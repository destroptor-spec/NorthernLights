# Aurora genre & style redesign

Oct 6, 2026 · @Andreas

Give Aurora its own fixed two-level Genre → Style taxonomy, seeded from the versioned Discogs label list, fed by Picard tags first and Discogs-EffNet scores second, and rebuild Browse around it. Every original tag is kept, and no track is hidden or forced into a style. Everything works from file tags and audio alone; Last.fm and MusicBrainz artist tags are optional additions that improve results when an install has them, never a requirement.

## Problem

The browse view is messy even with every track run through Picard. Part of that is how the tree is built; part is what Picard's genre tags are.

- **Rails come from MusicBrainz roots.** `LibraryHome.tsx` groups each library genre under `segments[0]` of its `genre_tree_paths` path. The MusicBrainz genre graph has dozens of top-level nodes (electronic, electronica, dance, club…), and genres with several parents get several paths. Near-identical families become separate small rails.
- **Small families are exiled.** A root with fewer than 2 library members, and any tag with no MusicBrainz path, goes to "Other genres".
- **Picard tags are album-level, sometimes missing, and inconsistently named.** Picard writes MusicBrainz genres, which are user votes on the release group (falling back to the artist when enabled). Every track on an album gets the same genres, interludes and odd tracks included; releases nobody voted on get the artist's career genres or nothing; and spelling and granularity vary ("Drum and Bass" / "Drum & Bass", "electronic" next to "IDM").
- **Nothing checks a tag against the audio.** A wrong tag stays wrong until someone notices it, and an untagged track has no genre at all.

Several genres per track already work: `tracks.genres` keeps the raw Picard string, and `track_genres` stores primary and secondary memberships (used by the filter routes, Subsonic `getGenres` and the duplicate review in `genreCanonicalization.service.ts`). The engine still reads a single `tracks.genre_id`.

The result is a graph squeezed into a two-level UI, with no fixed set of parents to anchor it.

### What it costs Infinity today (measured on dev, 6 Nov 2026)

The same tree drives Infinity's genre penalty (`genreMatrix.getHopCost`: 0 / 0.05 / 0.2 / 0.5 by shared depth, 2.0 for different roots or unmapped genres; the distance is multiplied by (1 + hop)^(strictness/100), so ×1.22 for 0.5 and ×1.73 for 2.0 at the default strictness of 50). On 223 random seed tracks from the 30,303-track dev library, looking at each seed's 10 nearest candidates by Infinity's own distance (other artists and albums only):

- **78 % of the nearest candidates are penalised, 60 % at the 2.0 maximum**, against 86 % at 2.0 for random pairs. The penalty barely separates neighbours from strangers.
- **About 4 of each seed's 10 nearest are pushed out** at default strictness, replaced by tracks around rank 19 by sound.
- **The 2.0 hops come from near-duplicate roots**: dance ↔ electronic (14 % of them), pop ↔ rock, electronic ↔ pop, dance ↔ pop, metal ↔ rock, pop ↔ pop rock, blues rock ↔ rock.
- **`subgenre_mappings` holds junk**: artist names ("basshunter", "bob sinclar", "eric prydz vs pink floyd") and "soundtrack" are stored as genres under `dance`; some files carry the literal genre "None".
- **Listening confirms it.** Of 20 penalised neighbour pairs (round 1 of the reviewed sample, see Appendix), **17 sounded alike** and all were penalised, 14 of them at 2.0. Only 7 of the 17 would share a genre under this taxonomy from tags alone; the other 10 cross genres (Pop Rap vs Dance, Jazz vs Pop, Rock vs Electronic, Pop vs Soul). Grouping is therefore not enough: the engine must stop penalising genre changes (see Engine).

## Model choice

Score styles with the `genre_discogs400` head on the per-patch EffNet embeddings the extractor already computes. On 2,932 dev tracks it gave the same scores as EffNet's built-in output (largest difference 0.00001), so no benchmark is needed. Keep MAEST as a later drop-in for accuracy, not for coverage.

| Option | What it gives | Cost in Aurora | Verdict |
| --- | --- | --- | --- |
| [EffNet built-in output](https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.json) (`PartitionedCall:0`) | 400 sigmoid style scores from the graph already loaded, beside the embeddings at `PartitionedCall:1` | The current `TensorflowPredictEffnetDiscogs` wrapper reads one output node, so this needs a second EffNet pass | Same scores as the head; no |
| [genre\_discogs400 head](https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json) | 400 scores from the embeddings; ROC-AUC 0.954, PR-AUC 0.206 (verified in the model metadata) | 2 MB model on the per-patch embeddings already computed; fits the current wrapper | **Use** |
| [MAEST-30s](https://huggingface.co/mtg-upf/discogs-maest-30s-pw-73e-ts) | Same 400 labels; about +1.5 mAP on genre downstream (21.6 vs 19.9) | 87M-param transformer, wants 30 s of audio, TF batch size 1; a new embedding space, so Infinity's vectors would be rebuilt | Later, if style accuracy disappoints (Pop, Jazz). Still one region of the track, so it does not fix section coverage |
| [OMAR-RQ](https://arxiv.org/html/2507.03482v1) | Embeddings only; trails MAEST on tagging | 580M params; needs your own classifier | No |
| CLAP / MERT | Zero-shot text labels or embeddings | PyTorch stack; own classifier or prompt tuning | No |

The scores rank broad families well, but a single top-1 style is noisy: they are evidence next to tags, never the sole truth for tagged tracks. Measured against Picard tags on dev (2,750 tracks whose tags map to a genre):

| Tagged genre | Model's top genre matches | Tracks |
| --- | --- | --- |
| Electronic | 88 % | 700 |
| Reggae | 83 % | 23 |
| Hip Hop | 79 % | 182 |
| Rock | 74 % | 881 |
| Funk / Soul | 55 % | 85 |
| Blues | 40 % | 15 |
| Pop | 37 % | 447 |
| Folk, World, & Country | 36 % | 25 |
| Jazz | 17 % | 48 |
| Stage & Screen | 12 % | 17 |
| All | 71 % top-1, 82 % top-2 | 2,750 |

Pop is mostly heard as Electronic, Rock, Hip Hop or Funk / Soul: in Discogs labels, modern pop production lives under Electronic. A tagged style lands in the model's top 5 for 60 % of style-tagged tracks.

Caveats:

- **Licence.** MTG models are CC BY-NC-SA 4.0 (non-commercial; a commercial licence is available on request). Aurora already ships EffNet under the same terms; state it in the README.
- **Extra windows cost inference.** Scoring more of a track than today's single 15 s window means more decoding and more EffNet passes, not only decoding (see Pipeline).
- **Bias.** Training data over-represents Western and electronic music; classical, hip hop subgenres and non-Western music are coarser.
- **Packaging.** The newest `essentia-tensorflow` pre-release on PyPI (May 2026) ships Python 3.14 wheels only; watch the 3.11 pin.

Sources: [Essentia models](https://essentia.upf.edu/models.html), [EffNet metadata](https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.json), [genre\_discogs400 metadata](https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json), [MAEST paper](https://ar5iv.labs.arxiv.org/html/2309.16418), [OMAR-RQ paper](https://arxiv.org/html/2507.03482v1), [essentia-tensorflow on PyPI](https://pypi.org/project/essentia-tensorflow/).

## Taxonomy

Aurora owns a fixed two-level taxonomy: 15 genres, each with its styles. It is seeded from the versioned [genre\_discogs400 label list](https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json) (400 labels), but the model's vocabulary is an input to it, not a permanent product constraint.

| Genre | Labels | Notes |
| --- | --- | --- |
| Electronic | 106 | Most detailed |
| Rock | 91 | Most detailed |
| Latin | 35 |  |
| Folk, World, & Country | 27 | Coarse for non-Western music |
| Hip Hop | 26 | Coarse for modern subgenres |
| Jazz | 25 |  |
| Pop | 16 |  |
| Funk / Soul | 15 |  |
| Classical | 13 | Periods, not forms or ensembles |
| Non-Music | 13 | Spoken word, field recordings; hidden from Browse by default |
| Blues | 12 |  |
| Reggae | 11 |  |
| Stage & Screen | 4 | Soundtracks and scores |
| Brass & Military | 3 |  |
| Children's | 3 |  |

Rules:

- **A style is the full `Genre---Style` pair.** 16 style names appear under two genres: Afrobeat, Disco, Dub, Electro, Experimental, Gospel, Grime, Hardcore, Industrial, Neofolk, New Wave, Noise, Parody, Rhythm & Blues, Ska and Trip Hop. A bare tag like "Trip Hop" therefore never identifies a style on its own; mapping resolves it from the track's other tags or its ML scores, or sends it to review.
- **Seed and validate from the JSON, never by hand.** The import checks 400 labels, 15 genres and unique full labels, and records a taxonomy version.
- **Genre-only membership is valid.** A track tagged just "Rock" sits in Rock without an invented style.
- **Nothing is hidden.** Every original tag is stored verbatim. Tags that map to nothing stay visible under an "Unsorted tags" entry with their tracks, which turns the old "Other genres" bucket into a visible to-do list.
- **Local styles come from the library.** Extra styles are added under an existing genre only for real unmapped tags (for example Afrobeats under Hip Hop) and flagged `source = 'local'`; the model never predicts them.
- **MusicBrainz is an input, not the structure.** MusicBrainz tags resolve through the mapping table; its parent/subgenre graph is no longer used for grouping.
- **A track can belong to several styles and genres.**

## Data model

New tables hold the taxonomy, the original tags, per-track evidence, user corrections and model scores; each result records the versions that produced it. The MusicBrainz genre data (`genre`, `genre_alias`, `l_genre_genre`) stays as a lookup source for tag mapping, but no longer comes from the MBDB import (see MusicBrainz genre data). Track ids are `TEXT` to match `tracks.id`, artist and user ids are `UUID`; nullable style columns use `UNIQUE NULLS NOT DISTINCT` (PostgreSQL 15+, Aurora runs `pgvector:pg16`) instead of primary keys, because [primary-key columns cannot be null](https://www.postgresql.org/docs/current/ddl-constraints.html).

**Relation to today's genre tables.** The new tables are built alongside `tracks.genres`, `track_genres` and `tracks.genre_id`, which keep working unchanged until phase 4. `track_tags` is filled by splitting `tracks.genres`, the raw Picard string the scanner already stores. Merges accepted in the existing duplicate review (`genre_duplicate_reviews`) are carried into `tag_map` as `alias` rows, so that work is not redone. In phase 4, `track_genres` and `tracks.genre_id` are derived from fused genres (see Migration).

**Genre and style must agree.** Every table that names a genre references `taxonomy_genre`, and every row with a style uses a composite foreign key `(style_id, genre)`, so a row can never say "Rock" with a Jazz style. PostgreSQL's default `MATCH SIMPLE` skips the composite check when `style_id` is NULL, so genre-only rows stay valid.

```sql
-- The 15 genres (name avoids the MusicBrainz "genre" table)
CREATE TABLE taxonomy_genre (
  name             TEXT PRIMARY KEY,       -- 'Electronic', 'Folk, World, & Country'
  hidden           BOOLEAN NOT NULL DEFAULT false,  -- Non-Music: hidden from Browse by default
  taxonomy_version INT NOT NULL
);

-- Taxonomy, seeded and validated from the versioned label JSON.
-- A new taxonomy version updates rows in place; versions never coexist.
CREATE TABLE style (
  id               SERIAL PRIMARY KEY,
  label            TEXT UNIQUE NOT NULL,   -- 'Electronic---Trip Hop' (names repeat across genres)
  genre            TEXT NOT NULL REFERENCES taxonomy_genre(name),
  name             TEXT NOT NULL,
  model_index      SMALLINT UNIQUE,        -- column in the 400 scores; NULL for local styles
  source           TEXT NOT NULL DEFAULT 'discogs',  -- 'discogs' | 'local'
  taxonomy_version INT NOT NULL,
  UNIQUE (id, genre)                       -- target of the composite foreign keys below
);

-- Every original tag, verbatim (split from tracks.genres)
CREATE TABLE track_tags (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,                  -- as written in the file; exact repeats collapse
  position SMALLINT NOT NULL,              -- file order; display only, not confidence
  PRIMARY KEY (track_id, tag)
);

-- Normalised tag -> genre, or genre + style
CREATE TABLE tag_map (
  id              SERIAL PRIMARY KEY,
  tag             TEXT NOT NULL,           -- normalizeGenreIdentity(tag)
  genre           TEXT NOT NULL REFERENCES taxonomy_genre(name),
  style_id        INT,                     -- NULL = genre-only mapping
  method          TEXT NOT NULL,           -- 'exact' | 'alias' | 'mb_alias' | 'mb_parent' | 'llm' | 'manual'
  reliability     REAL NOT NULL CHECK (reliability BETWEEN 0 AND 1),
  mapping_version INT NOT NULL,
  FOREIGN KEY (style_id, genre) REFERENCES style(id, genre),
  UNIQUE NULLS NOT DISTINCT (tag, genre, style_id)
);

-- Tags deliberately left unmapped (kept apart from tag_map)
CREATE TABLE tag_ignored (
  tag    TEXT PRIMARY KEY,
  reason TEXT
);

-- The fused result: one row per membership, saying where it came from.
-- (Built in phase 2. The first plan also stored a row per evidence source;
-- model scores already live in track_style_scores, so only the result is
-- stored, and its source is what "Aurora rays from {title}" shows.)
CREATE TABLE track_styles (
  track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre          TEXT NOT NULL REFERENCES taxonomy_genre(name),
  style_id       INT,                        -- NULL = the genre row; every member genre has one
  source         TEXT NOT NULL,              -- 'tag' | 'audio' | 'artist' | 'override'
  strength       REAL NOT NULL,              -- ranking on pages, 0..1
  confidence     REAL NOT NULL,              -- how sure, 0..1
  disputed       BOOLEAN NOT NULL DEFAULT false,  -- tag membership the audio contradicts (phase 3)
  fusion_version INT NOT NULL,
  FOREIGN KEY (style_id, genre) REFERENCES style(id, genre),
  UNIQUE NULLS NOT DISTINCT (track_id, genre, style_id)
);
CREATE INDEX track_styles_style_idx ON track_styles (style_id, strength DESC) WHERE style_id IS NOT NULL;
CREATE INDEX track_styles_genre_idx ON track_styles (genre, strength DESC) WHERE style_id IS NULL;

-- Persistent user corrections, applied after fusion on every run.
-- 'add' also confirms a disputed tag, so the dispute is not raised again.
CREATE TABLE track_style_overrides (
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre      TEXT NOT NULL REFERENCES taxonomy_genre(name),
  style_id   INT,
  action     TEXT NOT NULL CHECK (action IN ('add', 'exclude')),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (style_id, genre) REFERENCES style(id, genre),
  UNIQUE NULLS NOT DISTINCT (track_id, genre, style_id)
);

-- Raw model scores; own version, so a genre backfill leaves other features alone
CREATE TABLE track_style_scores (
  track_id      TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  scores        REAL[] NOT NULL
                CHECK (array_ndims(scores) = 1 AND cardinality(scores) = 400),
  model         TEXT NOT NULL,   -- e.g. 'discogs-effnet-bs64-1:PartitionedCall:0'
  windows       TEXT NOT NULL,   -- e.g. '15s@35%'
  genre_version INT NOT NULL,
  analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Community artist tags, one row per provider; counts are never summed across providers
CREATE TABLE artist_tags (
  artist_id  UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,            -- 'lastfm' | 'musicbrainz'
  tag        TEXT NOT NULL,            -- as returned
  raw_count  INT NOT NULL,             -- Last.fm 0-100 relative; MusicBrainz raw votes
  weight     REAL NOT NULL CHECK (weight BETWEEN 0 AND 1),  -- normalised per artist and provider
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, provider, tag)
);

-- Non-genre tag vocabulary: moods, scenes, eras, vocals, and noise to drop
CREATE TABLE descriptor_map (
  tag  TEXT PRIMARY KEY,               -- normalised
  type TEXT NOT NULL CHECK (type IN ('mood', 'scene', 'era', 'vocal', 'noise')),
  name TEXT                            -- display form; NULL for noise
);

-- Album and artist profiles: summaries of their tracks' fused memberships,
-- rebuilt after every fusion run (see Three levels). Never edited directly.
CREATE TABLE album_styles (
  album_id       UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  genre          TEXT NOT NULL REFERENCES taxonomy_genre(name),
  style_id       INT,                  -- NULL = the genre itself
  share          REAL NOT NULL,        -- share of the album's tracks that are members, 0..1
  strength       REAL NOT NULL,        -- mean member strength over all its tracks, 0..1
  tracks         INT NOT NULL,         -- member tracks
  fusion_version INT NOT NULL,
  FOREIGN KEY (style_id, genre) REFERENCES style(id, genre),
  UNIQUE NULLS NOT DISTINCT (album_id, genre, style_id)
);
CREATE TABLE artist_styles (
  artist_id      UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  genre          TEXT NOT NULL REFERENCES taxonomy_genre(name),
  style_id       INT,
  share          REAL NOT NULL,        -- mean of the album shares: each album counts once
  albums         INT NOT NULL,         -- albums where it appears
  tracks         INT NOT NULL,         -- member tracks, own tracks only
  fusion_version INT NOT NULL,
  FOREIGN KEY (style_id, genre) REFERENCES style(id, genre),
  UNIQUE NULLS NOT DISTINCT (artist_id, genre, style_id)
);

-- Library-specific sound of each style
CREATE TABLE style_centroids (
  style_id       INT PRIMARY KEY REFERENCES style(id) ON DELETE CASCADE,
  centroid       vector(1280) NOT NULL,
  track_count    INT NOT NULL,
  artist_count   INT NOT NULL,
  fusion_version INT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `CHECK` on `scores` matters: PostgreSQL [does not enforce declared array sizes](https://www.postgresql.org/docs/current/arrays.html), so `REAL[400]` alone would accept any length.

Four versions make every result reproducible: `taxonomy_version` (label list), `mapping_version` (tag mappings), `genre_version` (model output, windows) and `fusion_version` (rules and thresholds).

**Simulated tracks are excluded.** Tracks with `track_features.is_simulated = true` store placeholder vectors at the centre of feature space. They get no `track_style_scores` row, never serve as KNN references or KNN subjects, and never count towards a centroid; their memberships come from tags and Last.fm only.

**Corrections and renames.** Overrides are keyed by track id and cascade with the track. The scanner still deletes and re-adds a track whose file is renamed or moved, so its overrides are lost along with its playlists, loves and stats. This plan accepts that until scanner move detection lands; it does not add its own workaround.

`tracks.genre_id` stays for the legacy Subsonic `genre` field, which is one string per track. In phase 4 it is derived from the strongest member style, or the genre for genre-only tracks; `track_genres` is rebuilt from fused genres at the same time, so `getGenres`, the filter routes and the OpenSubsonic per-song `genres` list can expose every fused genre and style.

## Pipeline

Each track gets evidence from up to four sources, and a fusion step writes the `fused` rows Browse and the engine read.

&#91;embedded content: genre/style data flow · 4 sources, 1 fused table\]

Only `track_styles` is read downstream; centroids are rebuilt from it after each scan and also drive "sounds close to" in Browse.

### Extractor changes (`server/workers/extractor.py`)

1. **Run the `genre_discogs400` head** on the per-patch embeddings EffNet already returns (`PartitionedCall:1`), in the same pass. No second EffNet run.
2. **Average frame scores** and write them to `track_style_scores`, stamped with model, windows and `genre_version`.
3. **Run an independent genre backfill.** It selects tracks by `genre_version` and leaves `FEATURE_VERSION`, the stored embeddings and DSP features untouched. If the window change below ships first, the two backfills become one re-analysis.

### Analysis window

This is no longer only a genre question: the single 15 s window at 35 % also produces the EffNet embedding Infinity searches on, and it caused 2 of the 3 bad pairs in round 1 of the reviewed sample. In both, the sampled spot matched and the rest of the track did not (27+28, 37+38 in the Appendix). On dev, a track's own windows differ more from each other (median cosine distance 0.162 across 20/35/50/65/80 %) than pairs that sound alike differ at the sampled spot (0.081).

A first comparison on the 20 listened pairs (separation of the 3 bad pairs from the 17 good ones, 1.0 = perfect):

| Embedding | Separation |
| --- | --- |
| Mean of 20 / 50 / 80 % | 0.86 |
| Mean of all five (20 / 35 / 50 / 65 / 80 %) | 0.86 |
| Best-match between three windows | 0.86 |
| Mean of 35 / 65 % | 0.69 |
| 65 % only | 0.53 |

That sample is biased towards today's window: the pairs were chosen because they were close at 35 %, so 35 %-only cannot be judged on it (it scores 0.92 by construction). It does show that two central windows (35 + 65 %) do worst of the multi-window options, and that a plain mean of spread windows does as well as comparing windows pairwise. The mean keeps one vector per track, so the HNSW index and Infinity's queries stay as they are.

Decision rule: a blind A/B listening round decides. Embed a pool of tracks at 20 / 50 / 80 % (about 1 s per track on 7 dev workers), pick seeds whose nearest neighbour differs between "35 % only" and "mean of 20 / 50 / 80 %", and rate which neighbour fits better without knowing which is which. Adopt the three windows if they win. Cost: each window is one more ffmpeg seek and decode (median 0.9 s) plus an EffNet pass (0.55 s), and changing the embedding means a `FEATURE_VERSION` bump and a full library re-analysis.

**Result (blind A/B, 6 Nov 2026).** Pool: 4,000 random dev tracks of at least 60 s, not pre-selected by any window. Excluded: same artist, album, normalised title and recording. For 20 seeds, the nearest neighbour under "35 % only" and under "mean of 20 / 50 / 80 %" were played in shuffled order (playlist "Genre test · Window blind A/B").

- **The two setups disagree almost everywhere.** They picked the same neighbour for only 1 of 21 seeds, and each one's pick typically ranks 7th–10th under the other.
- **The mean of 20 / 50 / 80 % won 13–7**, with no ties; one group (progressive metal) was hard to call. That is 65 %. On 20 groups it is suggestive rather than conclusive (sign test p ≈ 0.26), but it points the same way as round 1, where the single window caused 2 of the 3 misses.
- **Default:** adopt the mean of 20 / 50 / 80 %. A second blind round of 20 would firm it up if wanted: at the same 65 % rate, 40 groups give p ≈ 0.08.

**Implemented (feature version 3, branch `genre-engine-next`).** Measured per track on one worker, end to end:

| Stage | Before (1 window) | Feature version 3 (3 windows) |
| --- | --- | --- |
| Decode + resample | ~325 ms (ffprobe + ffmpeg + Essentia resample) | ~400 ms, mostly NFS I/O (one ffmpeg call at 44.1 and 16 kHz, duration from the DB) |
| Discogs-EffNet | 420 ms | 430 ms (three windows share one 64-patch batch) |
| MusiCNN | 142 ms | removed |
| Classifiers (styles, danceability, acoustic, instrumental) | — | 12 ms |
| DSP | 79 ms | 83 ms (tempo from the middle window) |
| Total | ~970 ms | ~990 ms |

MusiCNN was replaced because over three windows it cost more than EffNet (480 ms) for three numbers; EffNet classifiers rank like it for danceability and acousticness (Spearman 0.88, 0.83) and better separate instrumental tracks. Full dev re-analysis: about 30,700 tracks × 1 s / 6 workers ≈ 1.5 h. Inference sits behind `EssentiaCpuBackend` (`infer` / `infer_many`), so a CUDA/ROCm backend replaces only that class; with EffNet as the only network it is the one model to accelerate. Python moved to 3.14 with `essentia-tensorflow==2.1b6.dev1438` (outputs identical to dev1389 on 20 tracks).

### Source evidence

- **Tags.** Every original tag is stored in `track_tags` and resolved through `tag_map`. Confidence is the mapping's reliability (1.0 for exact and manual mappings, lower for LLM ones). Tag position is not treated as confidence, since Picard does not guarantee ranked tags.
- **ML.** Raw scores from `track_style_scores`.
- **KNN.** Neighbours come from a frozen reference set for the current `fusion_version`: tag-derived and manual memberships only, excluding the track itself, its own album and simulated tracks. Inferred memberships never become references, so they cannot strengthen themselves across scans.

### Fusion

Fusion writes three values per track and genre or style: **membership** (listed in Browse), **strength** (ranking on pages) and **confidence** (how sure). ML and KNN both come from EffNet embeddings, so they count as one audio signal: agreement between them never raises confidence above the stronger of the two.

```latex
\text{audio}(s) = \max\bigl(\text{ml}(s),\ \text{knn}(s)\bigr), \qquad \text{strength}(s) = \max\bigl(\text{tag}(s),\ 0.8 \cdot \text{audio}(s)\bigr)
```

Here tag(s) is the best mapping reliability among the track's tags for s. Rules, tuned on the reviewed sample:

- **Tagged tracks**: tags dominate. A tag mapping with reliability of at least 0.8 makes the track a member. An ML-only style joins if its raw score is at least 0.5, or at least 0.3 inside a tagged genre.
- **Tags mapped to a genre alone**: when none of a track's tags names a style, its styles come from audio within the tagged genre, as for untagged tracks below (top 3 with a raw ML score of at least 0.15). This ships in phase 2 with the untagged rule. It is how the review handles a tag one artist uses across varied albums ("Electric Hip Hop Soul": Downtempo, Glitch, Dubstep and Instrumental Hip Hop on different tracks): the tag sets the genre, and each track keeps its own style.
- **Untagged tracks**: the genre comes from the first available source, and styles always come from audio. This rule touches only tracks with no genre tag, so it ships in phase 2 (see Migration) and cannot make tagged tracks worse.
  1. *Artist tags, when the install has them*: the artist's strongest tag that maps to a genre (weight at least 0.3) sets the genre. On prod this matched Picard for 86 % of tracks, against 70 % for audio (see Artist tags).
  2. *Audio otherwise (the baseline)*: the model's top genre, but only in genres where it agrees with tags at least 70 % of the time, measured on the library itself at every full fusion run (at least 50 tagged tracks per genre). On dev with three windows: Rock 89 %, Electronic 75 %, Jazz 72 % qualify; Hip Hop 61 %, Pop 48 % and the rest do not.
  3. *Neither*: the track goes to Unsorted with the model's suggestion for an admin to confirm.

  Within the chosen genre, the top 3 styles with a raw ML score of at least 0.15 join as inferred members; KNN only breaks ties. Thresholds always compare raw scores, never weighted ones. On dev the predictions for untagged tracks looked right (Pendulum → Drum n Bass 0.91, Static-X → Nu Metal, Benal → Cloud Rap, Coldplay → Alternative Rock).
- **Disputed tags**: audio never removes a tag, because files are the source of truth, but it can flag one. The baseline check: a fused membership that comes from a tag is marked `disputed` when the track's raw ML score for that style is very low and its embedding sits outside the style's centroid neighbourhood (further than the style's 90th-percentile member distance). Both signals are required, the check runs only for styles with a centroid, and only in genres where audio agrees with tags at least 70 % of the time. When the artist has tags, they must contradict the file tag too: on prod, when audio and artist tags disagreed on genre, audio was right only 19 % of the time. The score cut-off must be far below 0.05: on dev, 28 % of tagged styles score under 0.05, so that alone would flag more than a quarter of the library. Disputed tracks stay listed and go to the admin review screen with the other mapping work: **Keep** writes an `add` override (the dispute is not raised again), **Remove** writes an `exclude` override. Thresholds are tuned on the reviewed sample like every other rule.
- **Albums**: album pages are ranked from aggregated track evidence. Track classifications are never changed to tidy an album, so interludes, compilations and soundtracks keep their own styles.
- Overrides apply last and persist across scans. Fusion re-runs whenever tags, mappings, overrides or rules change, without re-analysis, and stamps its fusion\_version.

Artist-tag evidence, when present, is applied after this vote and before overrides: it raises or lowers the confidence of inferred styles and supplies the genre for untagged tracks (see Artist tags). Without it every rule above still produces a complete result.

## Artist tags (Last.fm, MusicBrainz)

Artist tags are optional. An install without a Last.fm key or with MusicBrainz lookups off gets the full Browse and engine from file tags and audio; artist tags only raise confidence, settle ambiguous names and give untagged tracks a better genre. When present they serve two separate jobs: independent evidence that adjusts genre confidence, and a descriptor layer for moods, scenes and eras that never enters the genre taxonomy.

**Measured on prod (6 Nov 2026).** 92 % of the 4,813 library artists have Last.fm tags (dev has none). Mapped through the same tag mapping, an artist's strongest genre tag (weight at least 0.3) matches the Picard genre of their tracks for 86 % of 27,000 tagged tracks; using only Last.fm's own tags gives the same figure, so this is not MusicBrainz agreeing with itself. On the 2,260 tracks also scored by the audio model:

| Picard genre | Audio model | Artist tags | Tracks |
| --- | --- | --- | --- |
| Electronic | 87 % | 86 % | 696 |
| Rock | 75 % | 93 % | 945 |
| Pop | 39 % | 75 % | 394 |
| Hip Hop | 77 % | 93 % | 179 |
| Funk / Soul | 53 % | 71 % | 90 |
| Jazz | 15 % | 100 % | 40 |
| Folk, World, & Country | 41 % | 100 % | 22 |
| Stage & Screen | 26 % | 33 % | 23 |
| All | 70 % | 86 % | 2,260 |

When audio and artist tags agree (65 % of tracks) they match Picard 93.5 % of the time; when they disagree, artist tags match 71 % and audio 19 %. Caveat: Picard genres and artist tags both describe the artist or release, so this measure favours artist tags. Within an artist's catalogue only audio can tell tracks apart, which is why artist tags never set a style.

### What Aurora has today

- **Artist-level only.** `metadata/index.ts` fetches `artist.gettoptags` (falling back to `artist.getinfo` tags) and album tag names without counts. Track tags are not fetched.
- **Weights are relative.** A Last.fm count is 0–100, relative to that artist's strongest tag. MusicBrainz counts are raw votes, usually single digits.
- **The two scales are mixed.** `addCommunityTag` sums both into one `count`, so Last.fm weights swamp MusicBrainz votes in `communityTags`. Pre-step: keep counts per provider, and normalise MusicBrainz votes per artist before any comparison.

### Genre: confidence, not membership

Last.fm is the only genre evidence besides file tags that does not come from audio. ML and KNN share EffNet's errors; Last.fm does not, so agreement with it is the one case where combined evidence may raise confidence.

- **Corroborate.** An inferred style (ML or KNN) whose style or genre matches an artist tag with a normalised `weight` of at least 0.3 gets a confidence boost, capped below tag-derived confidence. Audio and artist tags agreeing is the strongest inferred evidence measured (93.5 % right).
- **Contradict.** An inferred style in a genre the artist has never been tagged with loses confidence. On genre, audio never wins against artist tags. Missing tags are not contradiction: niche artists often have few or none, and installs without a key have none at all.
- **Disambiguate.** For the 16 duplicate style names, artist tags pick the genre (an artist tagged "electronic" and "downtempo" puts Trip Hop under Electronic). Without artist tags, the track's other file tags or its ML scores decide, or the tag goes to review.
- **Untagged tracks.** With no Picard genre, the strongest artist tag that maps to a genre sets the genre; ML picks styles within it. Without artist tags, the audio-only rule in Fusion applies.
- **Never a style on its own.** Artist tags describe a career, not a track, so they never add a style membership by themselves, and they never override file tags.
- **Mapping.** The most common unmapped artist tags on prod are genre spellings that need aliases (rnb, singer-songwriter, uplifting trance, vocal trance, liquid funk, synthpop, britpop, electronica, punk rock), descriptors (female vocalists, 80s, danish, british, chillout) and noise ("all", "spotify").

### Descriptors: a separate layer

Most Last.fm tags are not genres: "melancholic", "chillout", "danish", "90s", "female vocalists", "atmospheric". Mapped into the taxonomy they would blur it; kept apart they feed features Aurora already has.

| Descriptor type | Examples | Used by |
| --- | --- | --- |
| Mood | melancholic, chill, energetic, dark | AI playlist prompts, daylist, a Mood facet |
| Scene / place | danish, nordic, uk garage scene | AI playlist prompts, a Scene facet |
| Era | 80s, 90s | Cross-check against release year; prompts |
| Vocal | female vocalists, instrumental | Cross-check against the voice/instrumental feature |

Recurring tags are sorted into these types once, the same way genre tags go through `tag_map`, and a blocklist drops noise ("seen live", "favorites", "awesome", artist names).

### Mapping hints

Across the library, Last.fm tags that co-occur with Picard tags already mapped to a style become suggestions for the LLM mapping step in phase 1. They are suggestions only: Last.fm tags never label the reviewed sample, so the evaluation does not partly grade itself.

## Engine

Style centroids power discovery first. Genre logic in recommendations changes only after a side-by-side comparison shows the new scoring helps.

- **Track style vector.** Strengths of member styles, L2-normalised, plus a separate 15-value genre part for genre-only tracks.
- **Style centroids.** A confidence-weighted mean of member embeddings, using non-simulated members with confidence of at least 0.7 only. Each artist's share of the weight is capped at 25 %, and a centroid is built only for styles with at least 20 tracks from at least 5 artists, so one prolific artist or album cannot define a style.
- **Sounds close to.** Cosine similarity between centroids, used in Browse first. Styles without a centroid fall back to the styles the model co-predicts on their tracks.
- **Candidate scoring (phase 4 only).** In `candidatePool.service.ts` and `recommendation.service.ts`, subtract a bounded style overlap from today's distance, which stays as it is: the 8D acoustic L2 distance plus the weighted EffNet cosine distance (`candidatePool.service.ts`, `distanceSql`). Cosine of the normalised style vectors means a track with many labels gains nothing for having them:

```latex
d'(t) = \underbrace{\lVert a_t - a_{\text{seed}} \rVert_2 + w \cdot \bigl(1 - \cos(e_t, e_{\text{seed}})\bigr)}_{\text{today's distance}} - \beta \cdot \cos(v_t, v_{\text{seed}}), \qquad 0 \le \cos(v_t, v_{\text{seed}}) \le 1
```

Here a is the 8D acoustic vector, e the EffNet embedding and v the style vector; lower d′ ranks higher.

- **No genre penalty.** The hop-cost multiplier and root enforcement (`reRankByHopCost`, the Infinity re-rank) are removed, not re-pointed at the new genres. Shared styles only ever pull a candidate closer; changing genre never pushes one away. Reason: in round 1 of the reviewed sample, 10 of the 17 pairs that sounded alike crossed genres even under this taxonomy, and a genre penalty would still push them out. The genre strictness setting becomes the style-overlap weight β.
- **Existing behaviour stays.** Acoustic controls, banned genres (a hard veto, not a penalty), diversity, artist spread and discovery bias work as today; banned genres can now target a genre or a style. The old engine stays selectable as a setting during the comparison.
- **Duplicate recordings (separate fix, not part of this plan).** Infinity excludes the same artist and album, but not the same recording on another album or under a misspelled artist (round 1, pair 1: "Kisha" and Ke$ha, same Fred Falke remix). Exclude by `mb_recording_id`, or by normalised artist + title when it is missing.
- **Vocabulary.** The LLM playlist prompt gets the styles present in the library instead of `getGenreVocabulary()`'s 300 MusicBrainz genres.

### MusicBrainz genre data

Today Settings → Database runs an MBDB import (`mbdb.service`): it downloads the full MusicBrainz dump (`mbdump.tar.bz2`, about 4 GB) and scans the whole archive to extract three tables: 2,132 genres, 938 aliases and 3,382 parent/child links, 2.2 MB in PostgreSQL. The parent/child tree drove the old grouping and hop cost; the redesign uses it only to map tags.

What it adds, measured on dev for tags that exact names and the 21 hand aliases miss:

| Tags | Exact + aliases | Added by MusicBrainz aliases and parents | Still unmapped |
| --- | --- | --- | --- |
| Picard track tags (dev, 32,426 uses) | 95.6 % | +1.2 % | 3.2 % |
| Last.fm artist tags (prod, weight at least 0.3, 12,434 uses) | 70.1 % | +8.5 % | 21.4 % |

It resolves genre spellings and subgenres by alias or nearest mapped ancestor: rnb → Funk / Soul, Punk Rock → Rock, Groove Metal → Rock, Edm → Electronic, uplifting trance and vocal trance → Trance, liquid funk and neurofunk → Drum n Bass. It cannot resolve descriptors (female vocalists, 80s, danish) or junk ("Other", "Électronique", "Pop @ Newest Mp3s"), and parents can mislead: "サウンドトラック" (soundtrack) lands under Pop because its MusicBrainz parent is J-pop.

Decision: keep the data, drop the download.

- **Ship a snapshot.** A versioned JSON of genre names, aliases and parent links (a few hundred KB) lives in the repo beside the Discogs label list, imported into `genre`, `genre_alias` and `l_genre_genre` on startup. A maintainer script refreshes it occasionally. MusicBrainz core data is CC0; confirm genres fall under it before shipping.
- **Mapping methods.** `mb_alias` counts like an exact match (reliability 1.0). `mb_parent` maps to the nearest ancestor that is a Discogs style or genre, at reliability 0.8 to start, tuned on the reviewed sample. Parent mappings are listed in the review screen so mistakes like the J-pop one are easy to correct.
- **Why it matters.** With no LLM configured, these two steps are the only automatic mapping beyond exact names and hand aliases.
- **Retire the import.** The MBDB import, its 4 GB download and its Settings dependency are removed once the snapshot ships. `genre_tree_paths` stays only while the old engine is selectable.

### What happens to the Genre Matrix

The Genre Matrix is retired piece by piece. Every piece keeps working unchanged until phase 4, so the old engine stays selectable and rollback stays possible. Centroid similarity is used only for "Sounds close to" in Browse; it never scores candidates.

| Piece today | Used by | Fate | When |
| --- | --- | --- | --- |
| MBDB import (`mbdb.service`: 4 GB dump → `genre`, `genre_alias`, `l_genre_genre`, `genre_tree_paths`) | Everything below | Data kept as a shipped snapshot for `mb_alias` / `mb_parent` tag mapping; the download and import are retired (see MusicBrainz genre data) | Snapshot in phase 1; import removed after it; `genre_tree_paths` with phase 4 |
| Categorizer (`runDiffAndGenerate`: SQL → LLM → KNN into `subgenre_mappings`) | Post-scan job, Settings → Genre Matrix | Replaced by `tag_map` (exact → alias → LLM); it also filed artist names as genres under `dance` | Phase 1; retired in phase 4 |
| Hop cost (`getHopCost`) | Infinity distance multiplier | Removed (see Problem and Engine) | Phase 4 |
| Root enforcement (`reRankByHopCost`) | Hub and AI playlists at high cohesion | Removed | Phase 4 |
| Banned-genre veto (`getGenrePath`, `isPathBlockedByBannedGenre`) | AI playlists | Re-pointed to genres and styles; stays a hard veto | Phase 4 |
| LLM vocabulary (`getGenreVocabulary`) | AI playlist prompts | Replaced by the library's styles | Phases 3–4 |
| Library genre health (`libraryProfile` → `llmConceptCompiler`) | AI playlists adapt genre blend to library coverage | Re-pointed to genre and style counts | Phase 4 |
| Browse rails (`getGenreTaxonomyPaths` → `LibraryHome`) | Genre browse | Replaced by the new Browse | Phase 2 |
| Candidate-pool genre paths (`candidatePool.service`) | Hub and candidate pools | Replaced by fused genres and styles | Phase 4 |
| Settings → Genre Transition Matrix tab | Admin | Becomes the tag-mapping review screen (unmapped tags, ambiguous names, disputed tags) | Phases 1–2 |

## Three levels: track, album, artist

Tracks, albums and artists each have genres and styles, but only the track is assigned. Album and artist profiles are summaries of their tracks, recomputed after every fusion run, so the levels can never contradict each other, and one tag never stamps a style on music that sounds different (a tag one artist uses across varied albums, like "Electric Hip Hop Soul"). Each level also shows the evidence that belongs to it.

| Level | Comes from | Also shown |
| --- | --- | --- |
| **Track** | Fusion: file tags, its own sound, corrections. The only level that is stored as decided and the only one that is edited. | Where each style came from |
| **Album** | Its tracks: for each genre and style, the share of the album's tracks that are members and the mean strength. | The album's own tags: Picard writes the release's genres to every track, so file tags are really release-level evidence |
| **Artist** | Their own tracks (not appearances or features; Various Artists has no profile), **each album counted once**: the mean of the album shares, so a 40-track deluxe edition or a remix album does not outweigh the rest. Tracks without an album count together as one album. | What listeners tag the artist with (Last.fm, MusicBrainz), when available; styles album by album over time |

- **Editing stays per track.** "Apply to the whole album" and "apply to every track by this artist" are shortcuts that write track overrides; there is no album or artist override.
- **What a profile lists.** A genre or style appears on an album when at least 20 % of its tracks are members, or it is among the album's 3 strongest; the same rule applies to an artist's album-weighted shares. Smaller ones stay in the data for ranking.
- **Ranking.** Browse ranks albums and artists on a style page by profile share times strength, so an album that is mostly the style comes before one with a single track in it.
- **Compilations.** An album's profile shows its spread as it is ("Sun:Sets 2019": Electronic, Downtempo, Ambient, House); nothing is tidied.

### Aurora rays from {title}

One view per track, titled "Aurora rays from {title}", that shows everything Aurora knows about it. Reached from the track's menu only (decided 2026-11-10: no Now Playing entry). Named for Aurora; not "DNA", which reads as another service's feature.

1. **Credits.** Artists and every role the scanner already stores in `track_artist_credits` (on dev: composer on 14,746 tracks, producer 6,335, lyricist 6,128, performer, writer, mixer, engineer, arranger, conductor, remixer), one card per person with all their roles and instruments, in a rail like the Hub's "uniquely yours" radio cards. The track's billed artists come first (artist, and featured from "feat."), so a featured artist with no role credits still appears.
2. **Genres and styles.** Each with its source in words ("from the file tag", "from the sound", "set by you"), strength, and a flag when the sound disputes a tag. "Remove style" and "Add style" write overrides.
3. **Sound.** Energy, danceability, acoustic ↔ electronic, instrumental, brightness and percussion from the analysis Aurora already runs, the tempo, and two charts of the raw model output: the 12 highest style scores (the track's own styles highlighted) and how the scores split across genres. As built, the page reads Credits, In context, Sound and style (genres and styles, then the sound and its charts), Also on.
4. **In context.** How the track sits in its album and artist profiles ("Glitch, where most of the album is Downtempo"), and the listener tags for the artist.
5. **Albums.** Every album in the library this recording is on (by `mb_recording_id`, or normalised artist + title without one), which is the same match the duplicate-recording fix uses.
6. **Sounds close to.** Nearby styles and tracks, from style centroids (phase 3); hidden for a track without a real embedding. Built: between Sound and style and Also on.

## Browse UI

Browse becomes Genre → Style → music, with Play at every level, consistent card sizes and direct style search. It replaces the rails and the "Other genres" grid in `LibraryHome.tsx`.

1. **Genres.** Equal-size 3:2 cards for the genres present, ordered by track count, each in one of the Hub's cover gradients (the same per name), its name in the display font and one line under it: track count and biggest style. No hover effects. Non-Music is hidden unless toggled.
2. **Genre page.** Its styles as equal-size cards with track counts and Play, sorted by count; every style appears, even one with 3 tracks. Genre-only tracks sit in a "Rock, no specific style" group, named for the genre. Play genre and a decade filter sit at the top.
3. **Style page.** Albums and artists ranked by strength, Play this style, and "Sounds close to" with the 6 nearest styles by centroid, from any genre (hidden until the style has a centroid).
4. **Style search.** Styles and tag aliases join the app's main search (decided 2026-11-07: no separate search box on Browse). Duplicate names show their genre: "Trip Hop · Electronic", "Trip Hop · Hip Hop".
5. **Unsorted tags.** The last entry lists unmapped tags with track counts; their tracks stay playable, and admins can map a tag from there. Admins also see a **Disputed** list here (tagged memberships the audio contradicts) with Keep and Remove.
6. **Facets** on genre and style pages: decade, energy, acoustic ↔ electronic, from features Aurora already computes.
7. **Provenance in details only.** "Aurora rays from {title}" says where each style came from (tag, model, neighbours, manual) and offers "Remove style", which writes an override; album and artist pages show their profiles (see Three levels). Cards carry no source badges.

API (built in phase 2, on API v1 like every listener feature): `GET /api/v1/browse/genres`, `/browse/genres/:genre`, `/browse/styles/:id`, `/browse/tracks` (filtered, strongest first, for lists and Play), `/browse/albums`, `/browse/artists`, `/browse/search?q=`, `/browse/unsorted`, `/albums/:id/styles` and `/artists/:id/styles` (the profiles); `/tracks/:id/rays` follows with the view. Neighbours ("Sounds close to") join in phase 3; energy and acoustic facets follow the decade facet. All read fused, member rows of `track_styles`, `album_styles`, `artist_styles` and `style_centroids`; nothing loads the full library.

## Migration and rollout

Deploy and migration steps for prod live in one runbook, [genre-engine-upgrade.md](./genre-engine-upgrade.md); every phase adds its steps there when it is built.

Ship in four phases: tags and taxonomy → usable Browse → measured ML enrichment → recommendation changes. Browse ships on tags alone and never waits for a full-library audio backfill. The analysis-window test runs first, alongside phase 1, because it also changes today's engine.

0. **Analysis window (parallel to phase 1).** The blind A/B round favoured the mean of 20 / 50 / 80 % (13–7, see Analysis window). Implemented as feature version 3: one ffmpeg call per track, EffNet plus classifiers (MusiCNN removed), `genre_discogs400` scores in `track_style_scores`. Any scan that finds a new file re-analyses every outdated track, so time the prod deploy. Prod steps (venv rebuild, models, re-analysis, verification) are in [genre-engine-upgrade.md](./genre-engine-upgrade.md).
1. **Taxonomy and tag mapping.** Seed `taxonomy_genre` and `style` from the versioned JSON with validation. Split Last.fm and MusicBrainz artist tags into per-provider rows with normalised weights (the scale-mixing fix). Copy every original tag from `tracks.genres` into `track_tags`, and carry accepted duplicate-review merges into `tag_map` as aliases. Map tags exact → alias → MusicBrainz alias → MusicBrainz parent → LLM; ambiguous duplicate style names and low-reliability mappings go to an admin review screen. The LLM step is optional, like all AI in Aurora: without a configured LLM, tags left after the MusicBrainz steps go straight to the review screen and stay visible under Unsorted. Seed the snapshot (see MusicBrainz genre data) in this phase. On dev, exact names alone map 77.5 % of tagged tracks, and 21 aliases for the most common misses (Dance → Electronic, Drum & Bass → Drum n Bass, Rap → Hip Hop, R&B → Rhythm & Blues, Metal → Heavy Metal, Film → Soundtrack…) raise that to 95.6 %. Junk tags ("None", "Other") map to `tag_ignored`. Gate: mapping coverage (share of tagged tracks with at least one mapping) and mapping correctness (share right in the reviewed sample) are reported separately, and both meet a target you set.
2. **Browse on tags, plus untagged tracks.** Fusion built (fusion version 1, `services/genreTaxonomy/fusion.ts`): on dev, 29,416 tracks take their genre from tags, 1,191 from artist tags, 82 from the sound, 57 stay unsorted, and 24,138 (78 %) have a style, up from 15,025 by tags alone; a full run takes about 10 s. Fusion with tag evidence, and the untagged-track rule so tracks with no genre tag do not wait for phase 3. Where artist tags are already stored (prod), they set the genre of untagged tracks immediately; without them the audio-only rule applies. Fusion is tested both with and without artist tags (dev has none), and both runs must leave every track either in a genre or in Unsorted. Their scores come from an early genre backfill limited to untagged, non-simulated tracks, using the `genre_discogs400` head on fresh per-patch embeddings (it fits the current extractor wrapper). The stored `embedding_vector` cannot be reused: it is an L2-normalised mean, not the per-patch input the head was trained on. These rows carry their own `genre_version`, so if phase 0 changes the windows they are simply rescored. The new Browse ships behind a setting, then becomes the default, with Unsorted tags live from day one. Tags mapped to a genre alone get styles from audio within that genre in the same step. Album and artist profiles (see Three levels) and "Aurora rays from {title}" ship here too, without "Sounds close to". Built so far (2026-11-06): fusion, the Browse API on v1, and Browse behind a per-user switch (Settings → Appearance → Genre and style browse): genre cards (3:2, in one of the Hub's cover gradients picked per name (Daylist's times of day, On repeat, Rewind, Wrapped), name in the display font, one line: track count and biggest style; no hover effects), genre pages (6 style cards, an index of every style, tracks without a style, albums, artists, Shuffle by genre or decade), style pages and Unsorted. Shuffle plays a mix (`/browse/mix`): a quarter of the genre or style, 15 to 30 tracks (all of a small one), drawn at random from its 300 strongest, at most 2 per artist, artists spread out; Infinity mode continues. Play on a genre or style card does the same. "Aurora rays from {title}" is built (`/library/rays/:trackId`, `GET /api/v1/tracks/:id/rays`, from the track menu while the preview is on), with Add and Remove for admins (`POST /api/library/track-styles/:trackId`, track overrides, re-fused at once), and album and artist pages show their profiles as chips linking to Browse. Not yet: "Sounds close to" (phase 3). Layout as built: Credits (a rail like the Hub's radio cards), In context (a rail of double-width two-column cards: artwork left; name, what it is, the track's place in it, genres and styles, listener tags right; the album and the artist lead; then every other billed artist, featured artist and remixer in the library, as narrower cards of the same height led by a round portrait), Sound and style (a Sound card; a Styles card with the two charts; the track's genres and styles, with their sources and the admin editor, sit behind Advanced at the foot of the card; the model's style scores are told in words (Strong ≥ 0.5, Clear ≥ 0.3, Noticeable ≥ 0.15, A hint ≥ 0.05, else Faint; bands from the dev library, where a track's strongest style has a median of 0.29), the exact score in the tooltip; admins add or take off a style by selecting its bar in "Styles the audio model hears", listeners' bars open the style), Also on. Style search is not on the Browse page: styles and tags join the app's main search index later (the `/browse/search` endpoint is ready for it).
3. **Measured ML enrichment.** Run the genre backfill (unless phase 0's re-analysis already wrote the scores). ML, KNN and Last.fm evidence for tagged tracks switch on only where the reviewed sample shows they help; Last.fm descriptors start feeding AI playlist prompts and facets; centroids and "Sounds close to" follow, in Browse and in "Aurora rays from {title}". Disputed-tag flags start once centroids exist. Built so far (2026-11-10): the genre backfill came with phase 0's re-analysis (30,713 of 30,746 dev tracks scored). Style centroids (`style_centroids`, `services/genreTaxonomy/centroids.ts`): the mean EffNet embedding of each style's tag and hand-set members (never inferred ones, so a centroid can't grow on its own guesses; never simulated tracks), for styles with at least 8 such tracks by 3 artists (dev: 57 of 297 styles in use), with the 90th-percentile member distance stored for the disputed-tag check; rebuilt at the end of every fusion run (about 0.2 s), and once at startup when fusion is already current. On dev the nearest centroids read right (Trance → Progressive Trance, Progressive House; Soul → Funk, Contemporary R&B; Disco → New Wave; the metal styles together); one mapping smell surfaced: the tag "Psychedelic" maps to Funk / Soul › Psychedelic, but its tracks sit next to Psy-Trance. "Sounds close to" is live on style pages (6 nearest styles, any genre, each card naming its genre) and in "Aurora rays from {title}" (6 compact style cards nearest the track's embedding, its own styles left out, and 12 nearest tracks: none from its album or recording, one version per song, at most two per artist; they play as a list from the one picked). Fusion version 2 ("trust, then verify", decided 2026-11-10 instead of waiting for a reviewed sample): tagged tracks take up to 3 styles the sound hears clearly, at a raw score of 0.3 inside a genre that already has a tagged style, or 0.5 in another genre the sound is trusted on (which brings that genre too); on dev 10 of 12 random 0.3–0.4 additions read right (Pop Rock → Alternative Rock, Pop Punk → Punk), and every 0.5+ cross-genre one did (pop remixes → House, a disco classic tagged Progressive Metal → Disco). A tagged style is disputed when its raw score is under 0.01 and the track sits beyond the style's 90th-percentile centroid distance, in a trusted genre: on dev 476 styles on 469 tracks (1.5 % of tagged styles with a centroid), mostly intros, interludes, acoustic tracks on metal albums, and pop under a rock tag. Artist tags don't veto a dispute (decided 2026-11-10): they describe the career, not the track, and would have hidden 398 of the 476, interludes included; a dispute only asks. Admins answer on Unsorted (Disputed tags, one row per track: Play, Keep, Remove, Undo); Keep is an add override (never disputed again), Remove an exclude. Fusion runs 11.4 s on dev (version 1: about 10 s). Next: descriptors (moods, places, eras from artist tags, kept out of the genre taxonomy); places need one name across languages ("danish", "dansk", "denmark", "danmark" are one place). KNN evidence stays off: the sound already speaks through ML, and the two share EffNet's errors.

**Places and languages (built 2026-11-10).** Andreas's use: a datapoint for filtering and for dynamic and AI playlists ("Dansk rap fra 90'erne"), not a genre and not display. Every track gets one ISO country and one ISO language in `track_origin`, with the source (`services/trackOrigin.service.ts`). Country, first found: the primary artist's MusicBrainz country (`artists.country`, stored from now on with each lookup, and filled from the stored area where it names a country, including England, Scotland, Wales and Northern Ireland as GB); else the artist's strongest place tag on Last.fm or MusicBrainz (weight 0.2 or more); else the file's release country (Picard's, except Europe and Worldwide). Language: the file's lyrics language (TLAN / LANGUAGE), "no lyrics" (zxx) counting as none. Tag spellings collapse through CLDR (`shared/places.ts`): country and language names in about 30 languages, so "danish", "dansk", "Denmark", "danmark", "Dänemark" and "danois" are all DK, plus an English demonym list CLDR lacks ("american", "british"); a tag that maps to a genre never counts, and "indie" (India in one locale), "georgia" (Atlanta rappers) and "jersey" never do. The scanner now reads the release country and lyrics language; files scanned before are read once in the background (dev: about 45 files a second, 11 minutes for 30,000). On dev: 27,160 of 30,746 tracks have a country (24,728 from MusicBrainz, 1,210 from place tags, 1,222 from the release), 6,068 a language (5,947 English, 50 Danish); Danish 90s hip hop is Humleridderne, Østkyst Hustlers, Clemens, Hvid Sjokolade, Malk De Koijn, Suspekt and Rent Mel, three of them found only through Last.fm. Used by: AI playlists (the model returns `countries`, `languages`, `year_from`, `year_to` only when asked; they are hard filters through every relaxation step, a track matching a country or a language), and Browse (Shuffle on genre and style pages narrows by decade and country together: "Shuffle Hip Hop · Denmark · 1990s"). **Moods, eras and vocals (built 2026-11-10).** Measured on dev first: vocals are the strongest descriptor ("female vocalists" on 630 artists, "male vocalists" on 423 but weighted low by Last.fm), artist-level moods are sparse (chillout 154 artists, atmospheric 31, party 25), and only 435 of 30,746 tracks lack a year, while 1.8 % of a 500-file sample sit in another decade by their original year (remasters and reissues: Metallica's 2021 "Nothing Else Matters"). So era is fixed at the source: `track_origin` gets an effective year and decade from the file's original year (Picard's ORIGINALDATE, now read by the scanner; older files are read once more in the background), else its year, else the artist's era tag ("80s", "1980s", "eighties", "80'erne") for a track without one. Vocals (female, male) and moods (chill, party, uplifting, melancholic, dark, atmospheric, romantic, energetic, funky) come from the artist's tags in English and the Scandinavian, German and Dutch spellings (`shared/descriptors.ts`), with weights from 0.05 (vocals) and 0.1 (moods); they describe the artist, not the one track. Place tags also understand combined tags ("dansk rap", "Deutschrap", "nederhop", "Nederlandstalig"). Used by: Browse (Shuffle narrows by decade, country, vocals and mood together) and AI playlists (years by the effective year, vocals a hard filter, moods only lean: a track by an artist tagged with a requested mood ranks 0.1 closer, while the target sound still decides). Mood words never become genres, and moods from the sound itself (energy, acousticness, danceability) stay with the target vector.
4. **Recommendation changes.** Style overlap replaces the hop-cost penalty in candidate scoring and is compared side by side against the old engine, which stays selectable. Then `tracks.genre_id` and `track_genres` are derived from fused genres and styles, and the remaining Genre Matrix pieces are retired or re-pointed (see What happens to the Genre Matrix), including `subgenre_mappings`.

**Reviewed sample.** A fixed, hand-labelled set of tracks every gate is checked against. It covers common styles, rare styles, ambiguous tags (the 16 duplicate style names), untagged tracks, and compilations and soundtracks. Round 1 (20 neighbour pairs, see Appendix) is done.

Rollback: phases 1–3 add tables and leave `tracks.genres`, `track_genres` and `tracks.genre_id` untouched, so the old genre paths keep working until phase 4. The one behaviour change before then is phase 1's per-provider tag split, which changes the `communityTags` that `metadata/index.ts` returns (Last.fm counts no longer swamp MusicBrainz votes).

## Decisions

| Question | Default |
| --- | --- |
| Write styles back to file tags? | No. Inferred styles stay in Aurora's database; writing to files is a separate, explicit action. |
| Build on `track_genres` or replace it? | Build alongside until phase 4, then derive `track_genres` and `tracks.genre_id` from fused results. Existing duplicate-review merges become `tag_map` aliases. |
| Keep the MBDB import? | No. Keep its 2.2 MB of genre data as a shipped snapshot used for alias and parent mapping; drop the 4 GB download. |
| Is Last.fm (or MusicBrainz) required? | No. File tags and audio are the baseline for Browse, fusion and the engine; artist tags only improve confidence and the genre of untagged tracks. |
| Can audio remove a wrong tag? | No. It can only mark the membership disputed for review; Keep and Remove are manual overrides. |
| Tidy tags in Picard (genre whitelist) instead? | Optional. The mapping table does the same job inside Aurora, keeps the original tags, and also covers files not tagged by Picard. |
| Discogs API as a fourth source? | Deferred until tags plus ML are evaluated on the reviewed sample. |
| Which local styles? | Only those the library's actual unmapped tags call for. |
| Analysis windows | Mean of 20 / 50 / 80 %, for embeddings and style scores together. It beat today's 35 % window 13–7 in a blind A/B; two central windows (35 + 65 %) did worst in the first comparison. |
| GPU (ROCm) for analysis? | No. Analysis is decode-bound, the prod VM has no GPU, and other self-hosters need the CPU path. |
| MAEST-30s instead of more windows? | No. It is still one region of the track, so it does not fix the round 1 misses, and it replaces Infinity's embedding space. Revisit only if style accuracy for Pop and Jazz matters after phase 3. |
| Genre penalty in the engine? | Removed in phase 4; style overlap is a bonus only. Banned genres remain a hard veto. |
| LLM step in tag mapping | Deferred (decided 2026-11-06). Exact names, hand aliases and MusicBrainz aliases and parents reach about 97 % of Picard tag uses; leftovers go to the review screen. |
| Where does the mapping review live? | Settings → Library Entities → Genres. Adding it includes reworking that whole sub-tab to the standard of the Artists sub-tab (previews, undo, clearer actions). Built (1b, 2026-11-06): one queue with kinds No genre, Two genres, Guessed, Several in one and Spellings (the old duplicate detector, still grouping `genres.merged_into` until phase 4); name matches accepted in bulk from a list; coverage meter and count as the header; every answer undoable for 30 days. The Artists and Genres tabs share one queue component (`ReviewQueue`, `ReviewPanel`, `useReviewQueue`). Each question shows the audio (each track counted under its top style) and the artists' tags, and starts from a suggestion when they agree (or when one source is clear alone: most artists, or 70 % of tracks); a style the tag itself names is kept unless under 20 % of the tracks have it among their 5 closest styles (the tag is then loosely used: "Electro" on Radiohead remixes, ODESZA, Netsky and a Chicane compilation, 16 of 102), and a tag that names no style gets one only when at least half the tracks have it as their top style, otherwise the genre alone. Top style alone undersells every style, so named styles are judged by the 5 closest: on dev, tracks tagged Hard Rock / House / Disco / Pop Rock have that style among their 5 closest for 77 / 72 / 54–66 / 46 % (top style 44 / 34 / 18–27 / 13 %), against 25 % for Rock › New Wave and 16 % for Electro. On dev, 77 of 100 questions get a suggestion. |
| Genres and styles for albums and artists? | Yes, as summaries of their tracks, never assigned on their own (decided 2026-11-06). An artist's profile counts each album once, not each track. |
| Name of the per-track view | "Aurora rays from {title}" (decided 2026-11-06), not "DNA". |
| Tuning weights and thresholds | Tuned against reviewed labels. Loves and skips personalise recommendations only, never shared genre truth. |

Still open:

- [x] Phase 1 gate (decided 2026-11-06): at least 95 % of tagged tracks have a mapping, and every mapping is reviewed in the review screen. Dev has 261 distinct Picard genre tags (the top 100 cover 96 % of uses), so a full review replaces sampling.
- [x] Phase 0: blind A/B round, 35 % window vs mean of 20 / 50 / 80 % (mean won 13–7).
- [ ] Optional: a second blind round of 20 to firm up the window result before re-analysing.

## Appendix: reviewed sample, round 1

Listened on dev, 6 Nov 2026 (playlist "Genre test · Sounds alike, penalised today"). Each pair is a seed and one of its 10 nearest Infinity candidates that today's engine penalises. The pairs were picked by today's 35 % window, which favours good matches.

| # | Pair | Tags · penalty today | Same genre in new taxonomy? | Verdict |
| --- | --- | --- | --- | --- |
| 1+2 | Kisha – Tik Tok (Fred Falkes Radio) / Ke$Ha – Tik Tok (Fred Falke Remix Radio) | Dance vs House · 2.0 | yes | Same recording, different album (duplicate bug) |
| 3+4 | Dj Goldfinger – Keep Me Hanging On (Klubbingman Remix) / Náksi Vs. Brunner – Somewhere Over the Rainbow (Klubbingman Edit) | Dance vs Euro House · 2.0 | yes | Alike (same remixer) |
| 5+6 | Gym Class Heroes – Ass Back Home (Ken Loi Instrumental) / Chicane – Don't Give Up (Reboot) | Pop Rap vs Dance · 2.0 | no | Good |
| 7+8 | Dj Manian – Turn the Tide / Lazard – I Wanna Grow Old With You | House vs Electronic · 0.5 | yes | Good |
| 9+10 | The Chainsmokers – Kills You Slowly (MOTi remix) / Martin Garrix & Dua Lipa – Scared to Be Lonely (Zonderling Remix) | Dance vs Dance-pop · 2.0 | yes | Good |
| 11+12 | Cold Blue – Once in Time / Paul Van Dyk – We Come Together | Trance vs Electronic · 0.5 | yes | Good |
| 13+14 | Tyler Bates – The Great Companion / Neal Acree – I Seek Vengeance | Orchestral vs Film · 2.0 | no | Good (both screen scores) |
| 15+16 | Colina – Farben / Dave Darell – Children | House vs "None" · 2.0 | no | Good |
| 17+18 | Michael Bublé – Forever Now / Ed Sheeran – Stoned | Jazz vs Pop · 2.0 | no | Decent (17 gains rhythm at the end) |
| 19+20 | Supertron – Tuning Traxx / Cascada – What Do You Want From Me | Dance vs "None" · 2.0 | no | Good (Hands Up) |
| 21+22 | Armin van Buuren & SACHA – Set Me Free / Calvin Harris & Sam Smith – Desire | Trance vs Pop · 2.0 | no | Good |
| 23+24 | Ørjan Nilsen – Drowning / David Guetta – Goodbye Friend | Progressive Trance vs Dance-pop · 2.0 | yes | Good |
| 25+26 | Jimmy Eat World – Big Casino / Thomas Wesley – Wasted | Rock vs Electronic · 2.0 | no | Good |
| 27+28 | Rival Consoles – Untravel / Armin van Buuren & Fatum – Punisher | Ambient vs Trance · 2.0 | yes | **Bad**: the sampled spot matches, the rest does not |
| 29+30 | Blink-182 – She's Out of Her Mind / Good Charlotte – My Bloody Valentine | Pop Punk vs Punk · 0.5 | yes | Good |
| 31+32 | MØ – Punches / Beyoncé – Mine | Pop vs Soul · 2.0 | no | Decent |
| 33+34 | Carribean Dream – Rise up Tonight / Ma.Bra. – Al Ritmo | House vs "None" · 2.0 | no | Good (hard trance, as the model said) |
| 35+36 | Diana Krall – I'm Confessin' / Tony Bennett – Don't Wait Too Long | Jazz vs Vocal · 2.0 | no | Good |
| 37+38 | Skrillex – Bangarang / Pretty Lights – Vibe Vendetta (GRiZ remix) | Dubstep vs Electric Hip Hop Soul · 2.0 | no | **Bad**: 38 has dub elements only around the sampled spot |
| 39+40 | Breaking Benjamin – Close Your Eyes / Media Lab – Embers | Alternative Metal vs Metal · 0.5 | yes | **Mediocre** |
