# Genre engine upgrade: deploy runbook

Every step needed to take branch `genre-engine-next` to prod, in one place. Each phase of [the genre & style redesign](./Aurora%20genre%20and%20style%20redesign.md) adds its steps here when it is built, so after the complete branch this page is the whole checklist. Steps run in the order listed.

| Phase | What it changes on prod | Status |
| --- | --- | --- |
| 0 | Python 3.14 venv, new analysis models, `track_style_scores`, full re-analysis | Built (`038e736`), not deployed |
| 1 | Genre list, MusicBrainz genre snapshot, tag mapping, artist-tag split, Last.fm backfill, genre review | Built (1a: taxonomy, snapshot, tag mapping, artist tags, backfill; 1b: review queue), not deployed |
| 2 | Fusion (genres and styles per track, album and artist profiles), new Browse behind a setting, "Aurora rays from {title}" | In progress: fusion, Browse API and Browse (preview switch) built, not deployed |
| 3 | Audio, KNN and Last.fm evidence; style centroids | Not built |
| 4 | Engine scoring; Genre Matrix and MBDB import retired | Not built |

Prod facts these steps rely on: host `10.10.0.12`, app in `~/NorthernLights`, deployed with `scripts/deploy-prod.sh` (leaves the checkout detached, keeps `dist-prev` for `--rollback`, and exports the database first whenever a deploy changes the schema).

## Before deploying

- [ ] The branch is merged to `main` (or the commit to deploy is on `origin`).
- [ ] A quiet window is planned: phase 0 re-analyses the whole library (see Phase 0, step 4).
- [ ] Optional: a VM-level backup. The deploy script's automatic database export covers the schema change.

## Phase 0: three-window analysis (feature version 3)

### 1. Rebuild the Python environment (can be done before the deploy)

`deploy-prod.sh` does not manage `.venv`. The current Essentia build needs Python 3.14. The old analysis code also runs on it (outputs verified identical), so this step is safe ahead of the deploy. Do not run it while an analysis is in progress, since analysis workers use `.venv`.

```bash
ssh andreas@10.10.0.12 'cd ~/NorthernLights && export PATH="$HOME/.local/bin:$PATH" \
  && uv venv --clear --python 3.14 .venv \
  && uv pip install --python .venv/bin/python "essentia-tensorflow==2.1b6.dev1438" \
  && .venv/bin/python -c "import sys, importlib.metadata as m; print(sys.version.split()[0], m.version(\"essentia-tensorflow\"))"'
```

Expected output: `3.14.x 2.1b6.dev1438`.

### 2. Deploy

```bash
ssh andreas@10.10.0.12 'bash -s -- main' < scripts/deploy-prod.sh
```

The deploy adds the `track_style_scores` table at startup (`CREATE TABLE IF NOT EXISTS`), so the script exports the database first (label `pre-<commit>`).

### 3. Check the models

At startup the server downloads four new model files (about 3.6 MB in total) from `essentia.upf.edu` into `server/models`: the style model and three classifiers. Analysis does not start until all of them are present.

- [ ] Settings → Database → models: every model is cached. If a download failed (prod has had outbound fetch blips), use Redownload there.

### 4. Re-analyse the library

Every track is now outdated (version 2 < 3). Analysis starts on the first scan that finds a new or changed file, or by hand:

- [ ] Optional: Settings → System → audio analysis CPU → Maximum for the run.
- [ ] Settings → Library → Analyze Pending.

On dev, 30,700 tracks take about 1.5 h at 6 workers; prod depends on its CPU. While it runs, Infinity only pairs tracks analysed with the same version as the seed, so recommendations draw on a smaller pool until the run finishes.

### 5. Verify

```bash
ssh andreas@10.10.0.12 'cd ~/NorthernLights && eval "$(grep -E "^(DB_USER|DB_NAME|DB_CONTAINER_NAME)=" .env)" \
  && podman exec -i "${DB_CONTAINER_NAME:-music-postgres}" psql -U "$DB_USER" -d "$DB_NAME"' <<'SQL'
SELECT feature_version, is_simulated, count(*) FROM track_features GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) AS style_rows, min(analyzed_at), max(analyzed_at) FROM track_style_scores;
SQL
```

- [ ] All non-simulated rows are at `feature_version` 3.
- [ ] `style_rows` equals the number of non-simulated version-3 rows.
- [ ] Settings → Library shows no outdated analysis.

### 6. Optional cleanup

- [ ] Delete `server/models/msd-musicnn-1.pb` on prod: MusiCNN is no longer used.

### Rollback

`ssh andreas@10.10.0.12 'bash -s -- --rollback' < scripts/deploy-prod.sh` restores the previous build. No database restore is needed: the old code treats version-3 rows as analysed, its Infinity keeps versions apart, it ignores `track_style_scores`, and it runs on the Python 3.14 venv. Rolling forward again resumes the re-analysis where it stopped.

## Phase 1: genre list and tag mapping

Genre list, MusicBrainz genre snapshot, original-tag table, tag mapping, coverage report, per-provider artist tags and their backfill (1a), and the genre review queue in Settings → Library Entities → Genres (1b).

### 1. Deploy (schema change)

New tables at startup: `taxonomy_genre`, `style`, `track_tags`, `tag_map`, `tag_ignored`, `genre_review_decisions`, `artist_tags`, `artist_tag_fetches`. `deploy-prod.sh` exports the database first, as for any schema change.

### 2. Automatic on first start (nothing to run)

In the background after the database connects, in this order:

1. Seeds 15 genres and 400 styles from `server/data/genre-taxonomy/discogs400-labels.json`.
2. Loads the shipped MusicBrainz genre snapshot (`mb-20260408-002212`) into `genre`, `genre_alias` and `l_genre_genre`, and rebuilds `genre_tree_paths`. This happens only if those tables are empty or hold older data. A newer MBDB import is kept and recorded as the source.
3. Copies every track's original genre tags into `track_tags` (about 30,000 tracks: seconds).
4. Maps every tag key. Later scans map new tags automatically.

The server log shows `[GenreTaxonomy] Coverage NN.N % of tagged tracks; …`. Dev reached 98.3 %, with 41 tags unmapped and 237 mappings to review.

### 3. Artist-tag backfill (automatic, slow, optional)

After the startup mapping, a background job fetches tags for library artists that have none yet:

- **Last.fm:** one `artist.gettoptags` call per artist, when a Last.fm key is configured.
- **MusicBrainz:** one artist lookup per artist with a known MBID, when MusicBrainz is enabled.

It works most-played first at one call per 1.5 s, maps new artist tags as it goes, stops on a rate limit, and resumes at the next start (a deploy or restart just continues it). Expect about 2 h for Last.fm on prod's ~4,800 artists, then a similar run for MusicBrainz. Without a key or with MusicBrainz off, it does nothing, and the taxonomy works from file tags and audio alone.

- [ ] Progress (admin): `GET /api/admin/genre-taxonomy/artist-tags/backfill` shows `fetched`, `remaining` and `stoppedReason`.
- [ ] To pause it: `POST /api/admin/genre-taxonomy/artist-tags/backfill` with `{"action":"stop"}`; `{}` starts it again.
- Existing artist chips switch from summed counts to per-provider weights when an artist is next looked up; nothing to do.

### 4. Verify

- [ ] The log line above appears without `[GenreTaxonomy] Initialisation failed`.
- [ ] Coverage and gate (admin): `GET /api/admin/genre-taxonomy/coverage` returns `gate.coverageMet: true`. `gate.allReviewed` stays false until step 5 is done.

```sql
SELECT (SELECT COUNT(*) FROM style) AS styles,              -- 400
       (SELECT COUNT(*) FROM track_tags) AS track_tags,
       (SELECT COUNT(*) FROM tag_map) AS mappings,
       (SELECT value FROM system_settings WHERE key = 'mbGenreSource') AS mb_source,
       (SELECT COUNT(*) FROM artist_tag_fetches) AS artist_fetches;
```

### 5. Review the genres (by hand; can wait until the backfill has run)

Settings → Library Entities → Genres. The header shows the share of tagged tracks that have a genre and how many questions are open. Each question shows what the audio says (the tracks' top genres and styles, from the re-analysis in the phase 0 steps) and artist-tag evidence once the backfill in step 3 has reached those artists, and starts from a suggested answer when they agree. Reviewing after both helps but is not required: without them the questions simply come without suggestions.

- [ ] Open **Name matches**, check the list (tags whose name is a genre or style), and **Accept all**. One Undo takes the whole batch back.
- [ ] Work through the queue. For a tag one artist uses across varied albums, prefer the genre alone (the suggestion does this when the tracks' styles vary): the audio then gives each track its own style. Filters: No genre, Two genres, Guessed (from MusicBrainz parents), Several in one, Spellings. Keys 1–9 choose an outcome, S skips, Enter applies.
- [ ] Spelling answers group the old genre list (`genres.merged_into`) as the old duplicate tool did, so the current engine follows them until phase 4.
- [ ] The phase-1 gate is met when the header reads "Every tag is reviewed" and the coverage endpoint returns `gate.passed: true`.

Dev, for scale: 143 name matches, 106 questions (41 no genre, 36 guessed, 13 several in one, 12 two genres, 4 spellings).

### Rollback

`--rollback` is safe: the old code ignores the new tables, and the MusicBrainz tables keep the same shape (the snapshot only refreshes their contents). Spelling answers from the review stay in `genres.merged_into`, which the old Genres tab also reads and can restore. The old code still writes summed tag counts to `artists.community_tags`; that only affects the chips' tooltip number.

## Phase 2: new Browse

### 1. Deploy (schema change)

New tables `track_styles`, `track_style_overrides`, `album_styles`, `artist_styles`; nothing existing changes. The deploy script exports the database first.

### 2. Automatic on first start (nothing to run)

After tag mapping, the server runs fusion once over the whole library because no fusion has run yet. The log says `[GenreTaxonomy] Fused N tracks in … ms: genre from tags …, artist tags …, sound …, by hand …, unsorted …; M with a style`. On dev (30,746 tracks) it takes about 10 s; prod's larger library takes proportionally longer, in the background. From then on fusion reruns by itself after scans, review answers and analysis.

Run it after phase 0's re-analysis if possible: without style scores, genre-only tags get no styles and untagged tracks can only take a genre from artist tags. Rerun by hand any time with `POST /api/admin/genre-taxonomy/fusion`.

### 3. Verify

- [ ] `GET /api/admin/genre-taxonomy/fusion` returns a status with `version` 1, `unsorted` small (dev: 57 of 30,746), and `audioGenres` listing the genres the sound may name on its own (dev: Electronic, Rock, Jazz).
- [ ] `SELECT COUNT(*) FROM album_styles` and `artist_styles` are not zero.

### 4. Try the new Browse (per user, off by default)

Settings → Appearance → **Genre and style browse (preview)**. Library → Genres then shows Aurora's genres; everyone else keeps the old genre list until they turn it on. Check a few genre and style pages, Shuffle, the decade buttons and Unsorted; open **Aurora rays** from a track's menu, and look at the genres and styles on an album and an artist page. The switch is stored per user on the server (`newBrowseEnabled`), so it follows you across devices.

## Phase 3: audio and artist-tag evidence

Built: style centroids, "Sounds close to", fusion version 2 ("trust, then verify": the sound adds styles to tagged tracks and flags tags it contradicts, for review), and places, languages, years, vocals and moods for filters and AI playlists.

### 1. Deploy (schema change)

New table `style_centroids` (one row per style: the mean audio embedding of its tagged tracks, with counts and the 90th-percentile member distance) and `track_origin` (a country and language per track); new columns `tracks.release_country`, `tracks.lyrics_language`, `tracks.original_year`, `tracks.origin_read_at`, `tracks.origin_read_version`, `artists.country`, and on `track_origin` the year, decade, vocals and moods. Nothing existing changes. The deploy script exports the database first.

### 2. Automatic on first start (nothing to run)

When fusion is already current (phase 2 ran), the server builds the centroids once at startup without a full fusion run. The log says `[GenreTaxonomy] Built N style centroids` (dev: 57 of the 297 styles in use; a style needs at least 8 tagged tracks by 3 artists). From then on every fusion run rebuilds them (about 0.2 s on dev). Needs phase 0's embeddings: tracks without a real embedding (simulated) never count.

Places: the first start fills `artists.country` from stored areas and builds `track_origin` (log: `[TrackOrigin]`/`[GenreTaxonomy] Placed N tracks (M artist countries from their areas)`), then reads the release country, lyrics language and original year from every file scanned before this version, in the background (`[TrackOrigin] Read release country, language and original year from N files`; dev: about 45 files a second, so prod's larger library takes proportionally longer; it resumes after a restart). It reads local files only; no provider calls.

Fusion version 2 runs once over the whole library at startup, because the version changed (dev: 11.4 s, about 1.5 s more than version 1). The log line now ends `…; N styles added from the sound, M disputed` (dev: 27,021 audio styles on tagged tracks, 476 disputed styles on 469 tracks).

### 3. Verify

- [ ] `GET /api/admin/genre-taxonomy/fusion` returns `version` 2 with `addedFromSound` and `disputed`.
- [ ] As an admin, Library → Genres → Unsorted ends with **Disputed tags**: one row per track with Play, Keep and Remove. Try Keep and Remove on one track each, and Undo from the toast; **Aurora rays** for a disputed track says "The sound disagrees" after the tag.
- [ ] `SELECT country_source, COUNT(*) FROM track_origin GROUP BY 1` after the file read finishes (`SELECT COUNT(*) FROM tracks WHERE COALESCE(origin_read_version, 0) < 2` is 0). Dev: artist 24,728, artist-tags 1,210, release 1,222.
- [ ] `SELECT year_source, COUNT(*) FROM track_origin GROUP BY 1` shows `original` for the files Picard tagged with an original date, and `SELECT COUNT(*) FROM track_origin WHERE vocals IS NOT NULL` is not zero (needs artist tags).
- [ ] A genre page (Hip Hop) shows Decade, Country, Vocals and Mood toggles under Shuffle; pick Denmark and a decade and Shuffle plays only those.
- [ ] With an LLM configured, a custom AI playlist "Dansk rap fra 90'erne" logs `[LLM Hub] "…" → only from DK or language da, years 1990–1999` and plays only Danish tracks from the 90s; "chill med kvindelig vokal" logs `female vocals, leaning chill`.
- [ ] `SELECT COUNT(*), MIN(p90_distance), MAX(p90_distance) FROM style_centroids` is not zero (dev: 57, 0.09 to 0.52).
- [ ] A style page with a centroid (Grunge, Trance, House) ends with **Sounds close to**: six style cards, each naming its genre (dev: Grunge → Hard Rock, Alternative Rock, Heavy Metal, Punk, Thrash, Progressive Metal).
- [ ] **Aurora rays** for an analysed track shows **Sounds close to** between Sound and style and Also on: six compact style cards and up to 12 tracks, one version per song, at most two per artist, none from the track's own album.

### Rollback

Drop `style_centroids`; nothing else reads it. Style pages and rays simply hide the section. Fusion version 2 adds no table: rolling back the code reruns version 1 at the next start, and Keep and Remove answers stay as ordinary hand corrections (`track_style_overrides`). `track_origin` and the new columns can stay or be dropped; the old code ignores them.

## Credit imports (automatic)

Not part of the genre engine, but on this branch. The MusicBrainz and Genius "Import credits" buttons are gone: the server imports producer, writer and role credits by itself whenever a provider is set up (MusicBrainz connected and enabled; a Genius API key), and Settings → Metadata → Genius / MusicBrainz only show progress.

### 1. Deploy (schema change)

New table `track_credit_lookups` (one row per track and provider: the key looked up and the outcome). At startup it is seeded with every track that already has MusicBrainz or Genius credits, so nothing imported by hand before is asked again.

### 2. Automatic (nothing to run)

Two minutes after the server starts, each configured provider begins; it checks for new tracks every 10 minutes. Pace: MusicBrainz one track per 1.5 s, Genius one per 2 s (dev measured about 2.6 s with the calls themselves, so 30,000 tracks take about a day). A rate limit (429, or 503 from MusicBrainz) or 20 failures in a row pause it for 30 minutes. A track is asked again only when retagged (new recording id, or new title and artist), after 7 days for a failure, or after 180 days for "no credits". Log lines: `[Credits] genius: looked up N tracks, M with credits, in … min`, `[Credits] musicbrainz: paused for 30 minutes (rate limited)`.

### 3. Verify

- [ ] Settings → Metadata → Genius shows "Importing in the background. N of M tracks looked up · K with credits" with a bar; no Import button. The same under MusicBrainz when it's connected.
- [ ] `SELECT source, outcome, COUNT(*) FROM track_credit_lookups GROUP BY 1, 2` grows over the first minutes.

### Rollback

The old code ignores `track_credit_lookups`; drop it or leave it. Credits already imported stay.

## Phase 4: engine switch and retirements

### Step 1 and 2a: the styles engine for everyone (no schema change)

Nothing to run. Style overlap is the only engine (the blind comparison came out even, 9–8 with 3 ties, and it needs only the new genres and styles). Infinity, the Hub and AI playlists, artist radio and the daylist read genres and styles from `track_styles`; nothing reads `subgenre_mappings` or `genre_tree_paths` for recommendations any more. The saved per-user settings `recommendationEngine` and `genrePenaltyCurve` are ignored and can stay in `user_settings`.

- [ ] Play a song with Infinity on; the server log reads `[Engine] Found tracks … AvgStyleOverlap: … Beta: 0.100`.
- [ ] Regenerate the Hub; Up Next and The Vault fill, and the AI playlists log `targets=` with paths like `electronic.deep house` and `hard veto [metal → rock.heavy metal, …]` when a concept bans genres.
- [ ] Start an artist radio; it plays.

Steps for the rest of step 2 (retirements) are added here when they are built. Known so far: the MBDB import (4 GB download) and the Genre Matrix are retired, and `tracks.genre_id` / `track_genres` are rebuilt from the new genres.
