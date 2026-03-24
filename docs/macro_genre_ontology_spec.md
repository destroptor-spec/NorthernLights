# Antigravity Context: Macro-Genre Ontology & Adjacency Matrix

## System Overview
This document outlines the architecture for the "Genre Adjacency Matrix." Its purpose is to prevent mathematically similar but culturally jarring track transitions. 

To avoid $O(N^2)$ LLM token limits and API failures when dealing with thousands of unique ID3 tags, the system uses a two-tier **Macro-Genre Ontology**. The backend maintains a static $20 \times 20$ matrix of core genres, and the LLM acts purely as an $O(N)$ categorizer to map specific sub-genres to those root categories.
To avoid $O(N^2)$ LLM token limits and API failures when dealing with thousands of unique ID3 tags, the system uses a two-tier **Macro-Genre Ontology**. The backend maintains a static $39 \times 39$ matrix of core genres, and the LLM acts purely as an $O(N)$ categorizer to map specific sub-genres to those root categories.

---

## 1. The Core Ontology (Static Root Matrix)
The backend must maintain a fixed list of core "Macro-Genres" and their transition costs. This handles the cultural relationship math instantly without relying on the LLM.

## Core Macro-Genres (39)

The system now uses a more granular 39-category ontology to better distinguish between high-energy club styles and atmospheric electronics:

1.  **Pop / K-Pop / J-Pop**
2.  **Rock / Metal / Punk / Indie / Alt**
3.  **Hip-Hop / R&B / Soul / Funk / Gospel**
4.  **Electronic / EDM / House / Techno / DnB / Dubstep / Trance / UK Garage / Breakbeat / Electro / Hardstyle / Downtempo**
5.  **Jazz / Blues / Classical / Soundtrack**
6.  **Folk / Country / World / Reggae / Latin / Afrobeats**
7.  **Utility**: Ambient, Spoken Word, Children's, Holiday, Comedy, Easy Listening, Experimental

### Relationship Logic (Seeding)
The adjacency matrix is seeded using a **Family-Based Affinity** system:
- **Internal Family Cost**: 0.15 (e.g., Techno -> House)
- **High Affinity Neighbor**: 0.3 (e.g., Electronic -> Pop)
- **Close Cousin**: 0.25 (e.g., Metal -> Rock)
- **Utility / Distant**: 0.7-0.9

**1.2 The Root Matrix Cache (`macro_matrix_cache`):**
Store a pre-calculated $39 \times 39$ JSON matrix in the PostgreSQL database representing the hop costs (0.0 to 1.0) between these 39 core genres. 
*(Example: `metal` to `punk` = 0.2; `metal` to `classical` = 0.9).*

---

## 2. The LLM Categorization Pipeline (Delta Updates)
The LLM is no longer asked to build a matrix. It acts purely as a "Genre Sorter" to map messy local ID3 tags to our clean Macro-Genres.

**Step 2.1: The Diff Check (Extraction & Sanitization)**
When the background worker scans tracks:
1. Extract ID3 genres, lowercase them, and strip special characters.
2. Compare them against the existing keys in the PostgreSQL `subgenre_mappings` table.
3. Extract ONLY the previously unseen sub-genres. If none are new, abort the LLM call.

**Step 2.2: The Batched LLM Prompt**
Send the unseen sub-genres in batches (e.g., max 50 per prompt) to the LLM.
- **Prompt Directive:** *"Act as an expert musicologist. I will provide a list of highly specific or messy music sub-genres. You must map each sub-genre to the single most appropriate parent category from this exact list of 20 Macro-Genres: [Insert 20 Macro-Genres]. Return ONLY a JSON object of key-value pairs."*

**Step 2.3: Expected JSON Output Schema**
```json
{
  "mappings": {
    "swedish melodic death metal": "metal",
    "post-avant jazzcore": "jazz",
    "90s trip-hop": "electronic",
    "unknown": "spoken word/other"
  }
}
```
**Step 2.4: Storage**
Save these new mappings into the PostgreSQL subgenre_mappings table:

    sub_genre (VARCHAR PRIMARY KEY)

    macro_genre (VARCHAR)

## 3. Handling Missing ID3 Metadata (The Fallback Cascade)

Local libraries frequently contain tracks with null or empty genre tags. Antigravity, you MUST implement this 3-tier fallback cascade during the background ingestion phase:

**Tier 1: LLM Artist Deduction**
If genre is null but artist exists, append the artist name to the LLM categorization batch.

    Logic: Instruct the LLM: "If provided an Artist name instead of a sub-genre, map the Artist's typical style to the closest Macro-Genre." (e.g., "Artist: Daft Punk" -> electronic).

**Tier 2: Vector K-Nearest Neighbors (KNN)**
If BOTH genre and artist are null, rely on the pgvector acoustic data.

    Logic: Query Postgres for the top 5 mathematically closest tracks (via Euclidean distance) that already possess a resolved macro_genre. Assign the most frequent Macro-Genre from those 5 neighbors to the unknown track.

**Tier 3: The "Ghost" State (Runtime Exemption)**
If Tier 2 fails (e.g., database is too small), set the macro_genre to "unknown".

    Logic: During playback queue generation, if a track is "unknown", bypass the genre penalty natively by setting hopCost = 0.0.

## 4. Universal Application Logic (Playback & Hub)

When calculating the Hop Cost between a seed track and a candidate track, Antigravity MUST use this fast, two-step lookup in TypeScript:

**1. Resolve to Macro:** Look up the macro_genre for both tracks in the subgenre_mappings cache.

**2. Calculate Cost:** Look up the hop cost between those two macro-genres in the macro_matrix_cache.

**3. Apply Penalty:** 
```typescript
    // In-memory lookups (loaded on server start)
    const macroA = subgenreMap[trackA.genre] || "unknown";
    const macroB = subgenreMap[candidateB.genre] || "unknown";

    // Same macro-genre (or the Ghost state) is always 0.0
    let hopCost = 0.0;
    if (macroA !== macroB && macroA !== "unknown" && macroB !== "unknown") {
    hopCost = macroMatrix[macroA]?.[macroB] ?? 0.7; // Fallback to 0.7
    }

    // Apply the user's strictness settings to the vector distance
    const finalScore = candidateB.distance + (hopCost * userSettings.genreStrictness);
```
**4 Sort & Wander:** Re-sort the PostgreSQL candidates by their new finalScore (lowest is best). Apply the "Wander Factor" randomizer to select the final track.