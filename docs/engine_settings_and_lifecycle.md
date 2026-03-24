# Antigravity Context: Settings UI, LLM Config & Hub Lifecycle

## System Overview
This document outlines the architecture for the user-facing Settings menu, how state is passed to the recommendation engine, and **critical architectural corrections** regarding LLM API key storage and the Hub generation lifecycle. 

**CRITICAL APP CONTEXT:** This is a locally-hosted web application. The user brings their own music and their own LLM API keys. DO NOT assume a cloud SaaS environment. DO NOT store user API keys in a `.env` file.

---

## 1. Engine Tuning (Settings UI -> Backend Mapping)
The UI must expose human-readable tuning parameters that map directly to the backend mathematical variables.

**1.1 The "Playback Algorithm" Tab (Live Queue & Infinity Mode)**
- **Discovery Level (The Wander Factor):** Slider (1-100). Maps to the `limit` (over-fetch pool) and the randomizer weight. 
  - *Low:* Fetch top 5, heavily weight index 0. 
  - *High:* Fetch top 50, distribute weight evenly.
- **Genre Strictness:** Slider (0-100). Maps to the `genreWeight` multiplier.
  - *0:* `genreWeight = 0.0` (Ignore genre, pure math).
  - *100:* `genreWeight = 3.0` (Heavily penalizes jumping outside the current genre cluster).
- **Artist Amnesia:** Dropdown ("Allow Repeats", "Standard", "Strict"). Maps to the length of the `recently_played_artist_ids` array passed to the Postgres `NOT IN (...)` query.

**1.2 The "System & Processing" Tab**
- **Audio Analysis CPU Usage:** Dropdown ("Background", "Balanced", "Maximum"). Controls the async worker queue `concurrency` limit (e.g., 1 core vs. `os.cpus().length - 1`).
- **Hub Generation Schedule:** Dropdown ("Manual Only", "Daily", "Weekly"). Adjusts the cron job frequency for the LLM pipeline. Also create a button on the hub to generate or regenerate.

**1.3 State Management Implementation**
These settings must be instantly accessible. Store them in a frontend global state manager (Zustand/React Context). When requesting a new track, attach the values to the payload:
```typescript
interface PlaybackRequestPayload {
  targetVector: number[];
  currentGenre: string;
  settings: {
    discoveryLevel: number;
    genreStrictness: number;
    artistAmnesiaLimit: number;
  }
}
```
## 2. External Providers & API Configuration (CRITICAL)

Antigravity, do NOT use .env files for the user's LLM credentials. The user must be able to configure this dynamically via the UI to support local providers like Ollama or LM Studio.

- The UI: The Settings page must have an "External Providers" section with text inputs for API Base URL (defaults to OpenAI), API Key, and Model Name.
- The Storage: Store these values securely in a local Postgres settings table.
- The Execution: The Node.js backend must dynamically read these values from the database when instantiating the LLM client (e.g., the OpenAI Node SDK).

## 3. The Hub Generation Lifecycle (Bug Prevention)

Antigravity, you must separate the LLM generation trigger from the data fetching. The Hub MUST NOT trigger the LLM every time the user clicks the "Hub" tab.

- **Route A (The Fetcher):** GET /api/hub
  This route is called when the frontend component mounts. It MUST ONLY read from the hub_cache database table and return the data instantly. It must never trigger the LLM.

- **Route B (The Generator):** POST /api/hub/generate
  This route triggers the heavy LLM Prompt-to-Query pipeline, runs the Postgres Euclidean distance queries, overwrites the hub_cache table with the new playlists, and returns a success status. This is ONLY triggered by the background cron job (configured in 1.2) or a manual "Refresh Hub" button in the UI.
---
