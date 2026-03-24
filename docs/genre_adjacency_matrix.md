# Antigravity Context: Dynamic Genre Adjacency Matrix

## System Overview
This document outlines the architecture for the "Genre Adjacency Matrix." This system acts as a cultural and semantic weighting layer on top of our mathematical DSP vector engine. Its purpose is to prevent mathematically similar but culturally jarring track transitions.

## 1. The Core Concept (The "Hop Cost")
When the engine transitions between tracks, it calculates a "Hop Cost" between their respective genres. 
- **0.0** = Seamless / Same Genre
- **0.2 - 0.4** = Close Cousins (e.g., R&B to Hip-Hop)
- **0.8 - 1.0** = Jarring / Unrelated (e.g., R&B to Death Metal)

This cost is mathematically appended to the Postgres Euclidean distance score.

## 2. Incremental Matrix Generation Pipeline (Delta Updates)
To minimize LLM API costs, the matrix is built incrementally. The LLM is ONLY queried when previously unseen genres are detected in the local library.

**Step 2.1: The Diff Check (Sanitization & Extraction)**
1. Query PostgreSQL for all distinct genres currently in the `tracks` table.
2. Sanitize them (lowercase, trim, strip special characters).
3. Fetch the existing keys from the `genre_matrix_cache`.
4. Calculate the diff. If no new genres are found, abort the pipeline.

**Step 2.2: LLM Musicologist Prompting (Delta Request)**
Pass ONLY the new genres and the list of existing genres to the LLM. Instruct it to return a partial adjacency matrix mapping the new genres against themselves and the existing ones.

**Step 2.3: Deep Merge & Save**
The Node.js backend receives the `matrix_delta`, deep-merges it into the existing JSON object, and saves it back to the `genre_matrix_cache` table.

## 3. Storage & Caching
- **Database Table:** Store the JSON response in a single PostgreSQL row as a `JSONB` column.
- **In-Memory Cache:** Node.js loads this JSON into memory so the playback engine can look up hop costs instantly.

## 4. Universal Application Logic (Infinity Mode & Hub Playlists)
This genre-cost penalty is a **universal filtering step**. It MUST be applied whenever the engine selects tracks based on a target vector.

**Step 4.1: The Base Execution**
1. **Over-fetch:** Query PostgreSQL (`pgvector`) for an expanded pool (e.g., 100 tracks) using Euclidean distance.
2. **Apply the Hop Cost:**
    ```typescript
   let genreWeight = 1.5; // Initial strictness
   const hopCost = genreMatrix[currentGenre]?.[candidateGenre] ?? 0.7;
   const finalScore = candidate.distance + (hopCost * genreWeight);
   ```
3. **Sort & Filter:** Re-sort by finalScore. Drop candidates that exceed a maximum acceptable distance/cost threshold.

**Step 4.2:** Guaranteed Playlist Length (Iterative Relaxation)
Hub playlists and Infinity Mode queues must meet pre-defined track counts (based on library size rules). If Step 4.1 yields fewer tracks than the target length, Antigravity MUST implement a progressive fallback loop:

1. Expand the Net: Increase the PostgreSQL over-fetch limit (e.g., from 100 to 300).
2. Relax the Genre Strictness: Reduce genreWeight by 25% (allowing slightly wider genre hops).
3. Relax the History Penalty: If artists were banned, temporarily lift the ban for older session history.
4. Recalculate: Re-run the scoring and sorting. Repeat this relaxation loop until the target_length is met or the absolute limits of the library are reached.
5. Wander Factor: Once the quota is filled, apply the weighted randomizer to the final selection to ensure serendipity.

## 5. Fallback Mechanisms

- Missing/Unknown Genres: Assume a default hop cost of 0.7.
- Same Genre: Natively 0.0.
- Ensures playback never crashes while waiting for the background LLM worker.
