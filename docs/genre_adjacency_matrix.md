# Genre Adjacency Matrix — Dynamic Hop-Cost System

## System Overview
This system prevents mathematically similar but culturally jarring track transitions by computing genre "hop costs" on-the-fly using the MusicBrainz hierarchical taxonomy stored in PostgreSQL.

## 1. Hop Cost Tiers (LCA-Based)
Hop costs are calculated by comparing the Lowest Common Ancestor depth of two genre paths in dot-notation (e.g., `Electronic.House.Deep House`).

| Relationship | Common Levels | Hop Cost | Multiplier (at weight=0.5, curve=1.25) |
|---|---|---|---|
| Deep siblings | ≥ 3 | 0.05 | 1.05× |
| Tier 2 cousins | 2 | 0.20 | 1.12× |
| Share root only | 1 | 0.50 | 1.28× |
| Alien hops | 0 | 2.0 | 2.28× |
| Unknown genre | — | 2.0 | 2.28× |

Unknown genres (no mapping in `subgenre_mappings`) receive the same 2.0 penalty as alien hops.

## 2. Categorization Pipeline (3-Step)

### Step 1: Direct SQL Match
Rapid, zero-token resolution against `genre_tree_paths` materialized view:
- 6 UNION ALL branches: tree path, tree alias, standalone genre with parent fallback, standalone alias, fuzzy tree (GIN indexed via `%` operator), fuzzy alias
- Fuzzy threshold: 0.7 for Tier 2, 0.8 for Tier 1.5

### Step 2: Vocabulary-Guided LLM Batch
Unmapped tags are batched to the LLM with a 300-genre vocabulary constraint:
- The LLM MUST only return genre names from the provided vocabulary
- Library-scoped: if library has < 300 genres, vocabulary contains only library genres
- If library has ≥ 300 genres, vocabulary is the top 300 from MBDB hierarchy
- LLM timeout: 120 seconds (for local LLMs)

### Step 3: KNN Fallback
Tracks without genre metadata are recovered via acoustic similarity:
- Full 21D KNN (8D acoustic + 13D MFCC) when both vectors available
- 8D-only KNN fallback when MFCC is missing
- NaN/invalid vector guards on all vector operations

## 3. Storage

- **`subgenre_mappings`** table: Maps sanitized genre tags to MBDB tree paths
- **`genre_tree_paths`** materialized view: Recursive CTE traversing `l_genre_genre` (entity0→entity1 direction for inverted MBDB link data)
- **In-memory cache**: Loaded on server startup, refreshed on re-categorization

## 4. Application Logic

### 4.1 Exponential Penalty Formula
The genre penalty uses an exponential model that scales the acoustic distance:

```typescript
const curve = 0.5 + (genrePenaltyCurve / 100) * 1.5; // 0.5 to 2.0
const combined = distance * Math.pow(1 + hopCost, weight * curve);
```

- **Small hops** (deep siblings, hop=0.05): Nearly invisible penalty (1.05×)
- **Alien hops** (hop=2.0): Massive penalty requiring 2.3× closer acoustic proximity to overcome
- **`genrePenaltyCurve`**: User setting (0-100, default 50) controlling curve steepness
- **`genreBlendWeight`**: User setting (0-100, default 50) controlling overall genre influence

### 4.2 Hard Genre Veto (banned_genres)
The LLM can declare `banned_genres` for each playlist concept. The veto checks against the **full hierarchical path** from `subGenreMap`, not just the leaf tag. Banning "dance" catches the entire `electronic.dance.*` subtree (trance, dubstep, hardstep, etc.).

```typescript
const fullPath = genreMatrixService.getGenrePath(leafGenre) || leafGenre;
if (bannedGenres.some(b => fullPath.includes(b.toLowerCase()))) {
  return { ...row, combined: Infinity };
}
```

### 4.3 Timbre-Weighted MFCC
For highly electronic/synthetic playlists (target acousticness < 0.3), MFCC timbre is weighted 3× more than rhythm in the SQL query:
```sql
(tf.acoustic_vector_8d <-> $1::vector) + ((tf.mfcc_vector <-> $2::vector) * 3.0) AS distance
```
This prioritizes instrument texture over tempo, pushing out tracks with mismatched timbre profiles.

**MFCC Imputation Safeguard**: The `imputeTimbreCentroid` function has a strict distance threshold (< 0.25) and minimum seed count (< 5). If the library doesn't have genuinely close acoustic neighbors, MFCC imputation aborts to prevent "timbre poisoning" — where a wrong-genre centroid pulls in more wrong-genre tracks.

### 4.4 SQL-Level Acousticness Dealbreaker
An asymmetric penalty applied directly in SQL for electronic/acoustic mismatches:
```sql
+ CASE WHEN $3::real < 0.2 AND (tf.acoustic_vector_8d::text::real[])[6] > 0.5 THEN 5.0 ELSE 0 END
```
If the playlist targets EDM (acousticness < 0.2) but a track is fully acoustic (> 0.5), it receives a +5.0 distance spike.

### 4.5 Hard Vector Clamping ("Bouncer at the Door")
Before scoring tracks, hard SQL bounds exclude tracks with dealbreaker dimensions entirely. These are absolute WHERE-clause exclusions — not penalties:

| Playlist Type | Energy Target | Hard Bounds |
|---|---|---|
| Chill/unwind | < 0.3 | Energy < 0.5 AND Danceability < 0.6 |
| Mid-range | 0.3–0.7 | None |
| Workout/club | > 0.7 | Energy > 0.4 |

These bounds are injected directly into the WHERE clause:
```sql
WHERE tf.acoustic_vector_8d IS NOT NULL
  AND (tf.acoustic_vector_8d::text::real[])[1] < 0.5  -- energy bound
  AND (tf.acoustic_vector_8d::text::real[])[7] < 0.6  -- danceability bound
```

All pgvector distance queries use explicit `::vector` casts on parameters to ensure type safety:
```sql
tf.acoustic_vector_8d <-> $1::vector
tf.mfcc_vector <-> $2::vector
```

### 4.5 Infinity Mode
Infinity Mode uses the same exponential penalty formula, controlled by `genreStrictness`:
```typescript
const finalScore = row.distance * Math.pow(1 + hopCost, genreWeight / 3.0);
```
Where `genreWeight = (genreStrictness / 100) * 3.0` (0.0 to 3.0).

## 5. Fallback

- Missing/Unknown genres: Default hop cost of 2.0 (same as alien)
- Same genre: 0.0
- Empty vocabulary (no MBDB): LLM falls back to unconstrained guessing
- Playback never crashes on missing genre data
