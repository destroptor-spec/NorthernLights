# Antigravity Context: Smart Music Recommendation Engine

## System Overview
This document outlines the architecture and constraints for building a precise, non-repetitive music recommendation engine for a local audio library. The goal is to avoid "greedy" nearest-neighbor algorithms (the "Plex Sonic trap") that result in looping, repetitive playlists. The engine must act like a DJ, balancing mathematical similarity with serendipity, history awareness, dynamic feature weighting, and total library size.

## 1. Database Schema (SQLite3)
We are using SQLite3. The database must separate standard metadata from normalized audio features to keep queries performant.

**Table 1: `tracks`**
Standard metadata.
- `id` (INTEGER PRIMARY KEY)
- `title`, `artist`, `album`, `file_path`, `duration_seconds`
- `analysis_status` (TEXT) - e.g., 'pending', 'processing', 'completed', 'failed'

**Table 2: `track_features`**
Audio analysis data linked via foreign key. All feature columns (except BPM) MUST be normalized (0.0 to 1.0) using Z-score normalization before insertion.
- `track_id` (FOREIGN KEY REFERENCES tracks(id) ON DELETE CASCADE)
- `bpm` (REAL)
- `energy` (REAL) - RMS Energy
- `brightness` (REAL) - Spectral Centroid
- `percussiveness` (REAL) - Zero-Crossing Rate
- `chromagram` (REAL) - Harmonic/Key signature mapping

## 2. Background Worker Architecture (Job Queue)
Audio extraction is CPU-bound. Antigravity, you MUST implement an asynchronous background worker queue to handle this without blocking the Node.js event loop.

**Worker Constraints & Logic:**
1.  **Enqueueing:** When a new folder is scanned, basic metadata is inserted into `tracks` with `analysis_status = 'pending'`. The `track_id` is pushed to the queue.
2.  **Concurrency Limits:** The worker must restrict simultaneous processing based on server CPU cores (e.g., `os.cpus().length - 1`).
3.  **The Extraction Pipeline:** Worker picks up job -> reads file -> extracts raw features -> updates `analysis_status` to 'processing'.
4.  **Error Handling:** If a track is corrupted, the worker must catch the exception, set `analysis_status = 'failed'`, and move to the next job without crashing the worker process.

## 3. Server-Side Normalization
Once the worker extracts the raw features, apply Z-score normalization across the entire feature dataset so no single feature mathematically dominates the vector distance:

z = (x - μ) / σ

*Note: Normalization should ideally be recalculated periodically via a background job as the library grows.*

## 4. Querying & Mathematical Distance
When querying the SQLite database for the next track, fetch candidate rows and calculate the true Euclidean distance in the TypeScript application code across all normalized features.

**Euclidean Distance Formula:**
d(p,q) = √((p1 - q1)² + (p2 - q2)² + ... + (pn - qn)²)
*(Where `p` is the seed track, `q` is the candidate, and `1...n` are the feature weights).*

## 5. "Anti-Repetition" Application Logic (Crucial)
Antigravity, when implementing the playlist generation algorithm, you MUST implement the following constraints:

1. **The Wander Factor (Temperature):** Query the top N nearest neighbors from SQLite, then use a weighted randomizer to pick one.
2. **History Penalty:** Maintain a session array of `recently_played_artist_ids`. Heavily penalize tracks by recently played artists to force library exploration.
3. **Dynamic Feature Targeting (DJ EQ):** Every 4-5 tracks, randomly shift feature weights (e.g., ignore `energy`, double `chromagram`) to create seamless harmonic transitions while resetting energy.
4. **Behavioral Telemetry:** If a user skips a track within 15 seconds, dynamically apply a negative weight to that track's specific feature cluster for the remainder of the session.

## 6. Dynamic Constraint Scaling (Library Size Awareness)
The engine's constraints MUST scale dynamically based on total indexed tracks (`SELECT COUNT(*) FROM tracks`). 

- **Small (< 500 tracks):** Reduce History Penalty to 2-3 tracks. Loosen Euclidean distance thresholds.
- **Medium (500 - 5,000 tracks):** Standard constraints: 10-track History Penalty, 20-track randomizer pool.
- **Large (> 5,000 tracks):** Strict constraints: 50+ track randomizer pool. Apply album-level or extended artist bans.

## 7. LLM-Driven Smart Collections (Prompt-to-Query Pipeline)
Dynamic playlists ("Smart Collections") will be generated using an external LLM acting as a "Creative Director."

**7.1 Configuration & Provider Setup**
- The UI must include an "External Providers" section.
- Required fields: `API Base URL` (defaults to `https://api.openai.com/v1`), `API Key`, and `Model Name`.

**7.2 The Execution Pipeline**
1. **Context Gathering:** The backend generates a text summary of the user's library.
2. **The Prompt:** The system sends the context to the configured LLM API endpoint instructing it to generate 3-5 creative playlist concepts and assign optimal acoustic target values (0.0 to 1.0) for each.
3. **Expected JSON Output Schema:**
   The LLM MUST return exactly this JSON structure:
   ```json
   {
     "collections": [
       {
         "title": "Neon Night Drive",
         "description": "Pulsing synthpop with steady beats.",
         "target_vectors": {
           "energy": 0.7,
           "brightness": 0.8,
           "percussiveness": 0.9
         },
         "metadata_bias": {"era": "1980s"}
       }
     ]
   }