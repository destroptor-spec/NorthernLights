# Artist Radio & Daylist

The smart hub's **artist radio** and **daylist** features run on a shared multi-pool primitive that mirrors the quality safeguards used by the LLM playlist generator. Both features share the same dedup, artist-diversity, novelty-scoring, and banned-genre veto machinery — they only differ in which pools they assemble and how they weight them.

The primitive lives in `server/services/candidatePool.service.ts`. The features that consume it live in `server/services/smartHub.service.ts`.

> **Note**: this pipeline is *parallel* to the LLM playlist generator (`recommendation.service.ts` + `llm.service.ts`). It re-implements the same concepts in a smaller, self-contained module so changes to smart-hub features can't perturb LLM playlists, and vice versa.

## 1. The shared primitive

`candidatePool.service.ts` exports four building blocks plus a few helpers.

### 1.1 `fetchCandidatePool(opts)`
A single pool query against `tracks` + `track_features`. Combines the same signals the LLM generator uses:

- **Acoustic distance** — L2 on `acoustic_vector_8d` (8D), optional cosine on `embedding_vector` (1280D Discogs-EffNet), blended via `effnetWeight`.
- **Novelty boost** — when `enableDiscoveryBoost` is on, never-played tracks get `+0.16`, 180-day-stale tracks `+0.08`, recently-played tracks get a small penalty.
- **Favorites score** — when `favoritesScore` is on, the pool is restricted to tracks with play history OR a positive rating, and ranked by `play_count + rating * 2`. Plays and hearts (high ratings) are weighted equally.
- **Dormant filter** — when `dormantOnly` is on, the pool requires `last_played_at` to be null or older than 60 days.
- **Genre filters** — `pathPrefixes` (must match) and `excludePrefixes` (must not match) using the same `subgenre_mappings` + `genre_tree_paths` lateral join as the LLM generator.
- **Restrict to artist** — `restrictArtistIds` for the seed pool.
- **Banned genres** — hard SQL veto, with a soft-veto recovery path available through the orchestrator.

Always-on filters: Christmas suppression outside the Dec 1 – Jan 5 window, the "Various Artists" pseudo-entity exclusion, and the structural-cue gate (`intro/outro/interlude/skit/...`) so radios and daylists don't surface 40-second album skits.

### 1.2 `dedupeCandidateRows(rows)`
Two-layer key strategy:

1. **MB recording id** when present (`mb:` prefix). The gold standard — collapses studio + remaster + live versions of the same recording to one entry.
2. **Normalized `meta:${artist}:${title}`** as fallback. NFKD-normalized, strips remaster / deluxe / anniversary / edition tags and surrounding punctuation.

When the same recording appears in multiple pools, the entry with the best combined score (lower distance, higher pool bias, more novelty) wins.

### 1.3 `selectDiverseTracks(rows, count, opts)`
Picks `count` tracks from the deduped, ranked pool while enforcing:

- **Artist diversity floor** — `getTargetArtistFloor(count, relaxationLevel)` yields 65 / 55 / 45 % of `count` as the relaxation level climbs.
- **Per-artist cap** — `maxTracksPerArtistFromSpread(artistSpread, count)` returns 1–3 depending on the `artistSpread` setting. Optional `protectArtistIds` exempts the seed artist from the cap so the seed pool can actually surface more than one of their tracks.
- **Pool quota allocation** — `poolTargets` is a soft quota per pool; the scorer rewards picks that move undersubscribed pools toward their target.
- **Album / root-genre / acoustic-cluster spreading** — small penalties so the playlist doesn't lock onto one album, one sub-tree of the genre graph, or one acoustic cluster.
- **Acoustic dispersion** — penalises picks that are too close (in 8D) to already-selected tracks; rewards moderate pairwise distance.

Returns selected rows plus diagnostics: distinct artists / albums / roots / pools / clusters, mean pairwise distance, and an overall `diversityScore` ∈ [0, 1].

### 1.4 `buildPlaylistFromPools(opts)`
The orchestrator. Per attempt:

1. Fetch every pool in `poolSpecs` in parallel.
2. Apply banned-genre soft veto (hard reject by default; replaced by a `+0.18` penalty when `softVeto` is on, which the relaxation plan can request).
3. Rank by `distance − pool_bias − novelty * 0.30 − favorites_score(clipped) + vetoPenalty`.
4. Dedup, then `selectDiverseTracks` with the supplied `poolTargets`.

If the result has too few tracks or fails the artist floor, the orchestrator advances to the next step in `relaxationPlan`. The best attempt wins.

### 1.5 Helpers used by callers

- `computeArtistCentroids(userId, artistId, topN)` — averages the acoustic + embedding vectors of an artist's top-played tracks. Used as the radio's seed centroid (richer than picking a single seed track).
- `getArtistGenrePaths(artistId)` — resolves the seed artist's dominant `tracks.genre` values to MusicBrainz paths and returns `{ primaryPath, adjacentPaths, rootPath }`.
- `getLibraryMainstreamVector()` — 1-hour-cached mean of a random 1000-row sample of `acoustic_vector_8d`. Used to build the bridge vector for radios.
- `resolveGenrePath(genre)` — wraps the `genre_tree_paths` + `genre_alias` lookup.

## 2. Artist Radio

Path: `generateArtistRadioFresh()` in `smartHub.service.ts`.

### 2.1 Pool layout
Given a seed `artistId`:

- **seed** — `restrictArtistIds: [artistId]`, ordered by play count + rating. Target ~4 tracks. The seed artist is protected from the per-artist cap so this pool can land.
- **core** — embedding K-NN around the artist centroid (`computeArtistCentroids` over the user's top 5 played tracks for that artist). No genre filter. Target ~38 %.
- **adjacent** — same K-NN, restricted to `pathPrefixes` derived from the artist's own genre + adjacent paths. Target ~18 % (skipped when the artist has no resolvable genre).
- **bridge** — same K-NN, but the acoustic vector is the midpoint between the artist centroid and the library mainstream vector. Target ~15 %. Pulls in safe non-genre matches.
- **discovery** — same K-NN with `enableDiscoveryBoost`. Target ~16 %. Surfaces neighbours the user has never tried.

### 2.2 Relaxation
One relaxation step: drop genre filters, widen `core` and `discovery` K, keep the same pool targets. If multi-pool still returns zero tracks (corrupt centroid, tiny library), a legacy artist-only catalogue dump runs as a last-ditch fallback.

### 2.3 Banned genres
Artist radio does **not** honor any banned-genre list. There is no user-configurable global ban list, and the radio has no LLM concept that would supply one. `bannedGenres` is left empty.

## 3. Daylist

Path: `computeDaylistFresh()` in `smartHub.service.ts`.

### 3.1 Identity
The daylist is a **discovery mix**: high-played / hearted tracks the user hasn't reached for, plus tracks they haven't tried but likely enjoy. The time-of-day mood layer survives only as flavor — it shapes the title, the description, and provides a soft acoustic bias, but does **not** dominate track selection.

### 3.2 Mood layer (flavor only)
`generateDaylistConcept` still calls the LLM with weekday + time-of-day + the user's top-8 7-day genres, asking for:

- a 3-word title (mood + weekday + time, e.g. `Lazy Wednesday Afternoon`)
- a short description
- 2–4 banned genres that clash with the mood (e.g. `metal`, `hardcore` for `late night`)
- an 8D target vector

The title and description are surfaced verbatim. The vector becomes a soft acoustic bias on the `acoustic` and `discovery` pools. The banned genres are honored via the orchestrator's veto.

If the LLM is disabled (`dummy-key`) or fails, the daylist falls back to `DAYLIST_DEFAULT_MOODS[timeOfDay]`.

### 3.3 Pool layout
Three pools, totalling `limit` tracks (default 30):

- **favorites** — `favoritesScore: true`, no recency filter. Played + hearted tracks ranked by `play_count + rating * 2`. Target ~40 %.
- **acoustic** — vector match against the LLM mood vector, no genre restriction. Target ~25 %.
- **discovery** — vector match + `enableDiscoveryBoost` + `dormantOnly`. Never-played or 60-day-stale neighbours, biased toward the mood vector. Target ~35 %.

### 3.4 Relaxation
1. **Step 1** — soft-veto the banned genres (replace hard SQL exclusion with a `+0.18` rank penalty) and lift the dormant filter on the discovery pool so any unheard track qualifies.
2. **Step 2** — drop the mood vector entirely from the favorites and discovery pools, widen pool sizes ×3, and broaden the artist floor.
3. **Last resort** — random by recency, no acoustic guidance.

### 3.5 Caching
Untouched from the previous implementation:

- 4-hour TTL.
- Bucket-aware refresh: if the cached daylist's `created_at` predates the current time-of-day bucket, refresh runs in the background even within TTL — but only for users who have engaged in the last 24 h.
- Stale-while-revalidate via `getStaleOrFresh` + `fireBackgroundRefresh`.
- Persists as a system playlist with `generation_source = 'daylist'` and a stable id `smart_daylist_${userId}`.

## 4. What is *not* shared with LLM playlists

The candidate pool primitive deliberately reimplements helpers (`getSongDedupKey`, `normalizeTitle`, `selectDiverseTracks`, `getTargetArtistFloor`, `isPathBlockedByBannedGenre`) instead of importing from `recommendation.service.ts`. Two consequences:

- Tuning the radio / daylist multi-pool layer (pool biases, scoring weights, relaxation behaviour) does not touch LLM playlist generation.
- Drift is possible: a future improvement to the LLM playlist scorer will not automatically reach the smart-hub features. Treat the two pipelines as siblings, not as a single shared lib.

## 5. Persistence and routes

Unchanged. `persistSmart()` in `smartHub.service.ts` writes the result to `playlists` + `playlist_tracks` with the same stable IDs the previous implementations used (`smart_artist-radio_${userId}_${artistId}`, `smart_daylist_${userId}`). The HTTP surface in `server/routes/hub.routes.ts` and the Hub frontend in `src/components/Hub.tsx` and `ArtistDetail.tsx` are untouched.

## 6. File map

- `server/services/candidatePool.service.ts` — shared primitive.
- `server/services/smartHub.service.ts` — `generateArtistRadioFresh`, `computeDaylistFresh`, plus the surrounding cache / TTL / LLM-concept glue.
- `server/routes/apiV1.routes.ts` — `POST /api/v1/hub/artist-radio` (and its `/eligibility`), `GET /api/v1/hub/smart` (the daylist is part of the smart Hub).
