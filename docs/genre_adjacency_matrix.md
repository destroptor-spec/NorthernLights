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

## 2. Categorization Pipeline (3-Step)

### Step 1: Direct SQL Match
Rapid resolution against the `subgenre_mappings` table:
- Checks for exact matches, aliases, and parent fallbacks.
- Fuzzy matching handles minor typos or variations in tagging.

### Step 2: Vocabulary-Guided LLM Batch
Unmapped tags are batched to the LLM with a 300-genre vocabulary constraint derived from the MBDB hierarchy. The LLM acts as a classification oracle, ensuring new tags align with the existing tree.

### Step 3: KNN Fallback
Tracks without metadata are recovered via acoustic similarity in the vector space:
- **Dual-Vector KNN**: Combines 8D MusiCNN (structure/mood) and 1280D EffNet (timbre/profile).
- **Consolidated scoring**: Weights the specialized 1280D embedding more heavily for electronic/synthetic genres.

## 3. Application Logic

### 3.1 Exponential Penalty Formula
The genre penalty scales the acoustic distance using an exponential model:

```typescript
const combined = distance * Math.pow(1 + hopCost, weight * penaltyCurve);
```

- **`penaltyCurve`**: Controls the steepness (0.5 to 2.0). High values make genre jumps nearly impossible unless the track is a perfect acoustic match.
- **`weight`**: The `genreBlendWeight` set by the user (0.0 to 1.0).

### 3.2 Hard Genre Veto (banned_genres)
The LLM can declare `banned_genres` for each Hub playlist. The veto checks against the **full hierarchical path**. Banning "dance" automatically catches the entire `electronic.dance.*` subtree.

### 3.3 EffNet Imputation Safeguard
For playlists generated from pure 8D structural seeds, the engine synthesizes an **EffNet Centroid** by averaging the embeddings of the 20 nearest 8D neighbors. A "Relative Cliff" check aborts imputation if the neighbourhood is too sparse, preventing "profile poisoning."

## 4. Infinity Mode
Infinity Mode applies the same hop-cost logic to ensure that "Continuous Discovery" stays within a cohesive cultural vibe while slowly drifting across the 1280D landscape.
