import { initDB, createPlaylist, addTracksToPlaylist, getPlaylists, getPlaylistTracks, getUserRecentTracks, getUserTopTracks } from '../database';
import { genreMatrixService } from './genreMatrix.service';
import { queryWithRetry } from '../utils/db';

// 1. Z-Score normalization is handled by scaling 0-1 mapped values in JS, but 
// for simplicity we assume vectors are already [0,1] normalized.
// Distance query uses native PGLite `<->` vector L2 distance operator.

function normalizeTitle(title: string): string {
  if (!title) return '';
  let t = title.toLowerCase();

  // 1. Strip known "noise" tags in parentheses or brackets
  // Matches things like (Remastered), [2012 Remaster], (Deluxe Edition), etc.
  const noiseRegex = /[\(\[]\s*(?:(?:\d{4}\s*)?remaster(?:ed)?|deluxe|special|expanded|anniversary|digital|mono|stereo|explicit|edition)\s*[\)\]]/gi;
  t = t.replace(noiseRegex, '');

  // 2. Also strip plain "Remastered" text not in parentheses
  t = t.replace(/(?:\d{4}\s*)?remaster(?:ed)?/gi, '');

  // 3. Clean up leading/trailing punctuation and double spaces
  return t.replace(/\s+/g, ' ')
          .replace(/[\s\-\:\.\(\)\[\]]+$/, '')
          .trim();
}

function isSameSong(a: { title: string, artist: string, mb_recording_id?: string }, b: { title: string, artist: string, mb_recording_id?: string }) {
  if (a.mb_recording_id && b.mb_recording_id && a.mb_recording_id !== '') {
    return a.mb_recording_id === b.mb_recording_id;
  }
  const artistA = (a.artist || '').toLowerCase().trim();
  const artistB = (b.artist || '').toLowerCase().trim();
  if (artistA !== artistB) return false;

  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  return titleA === titleB;
}

export async function getHubCollections(
  llmConcepts: { section: string, title?: string, description: string, target_vector: number[] }[],
  userId: string | null = null,
  settings: { genreBlendWeight?: number, genrePenaltyCurve?: number, llmTracksPerPlaylist?: number, llmPlaylistDiversity?: number } = {}
) {
  const hubs: any[] = [];

  const genreBlend = (settings.genreBlendWeight ?? 50) / 100; // 0.0 to 1.0
  const penaltyCurve = 0.5 + ((settings.genrePenaltyCurve ?? 50) / 100) * 1.5; // 0.5 to 2.0
  const tracksPerPlaylist = settings.llmTracksPerPlaylist ?? 10;
  const diversity = (settings.llmPlaylistDiversity ?? 50) / 100; // 0.0 to 1.0

  // Helper: re-rank a pool of tracks by blending vector distance with genre hop cost.
  // Exponential model: genre penalty scales distance via Math.pow(1 + hopCost, weight * curve).
  // bannedGenres: absolute veto — matching tracks get sent to Infinity.
  // Root node enforcement: at high weight, blocks tracks from different genre families.
  const reRankByHopCost = (rows: any[], referenceGenre: string, limit: number, blendWeight?: number, bannedGenres?: string[]) => {
    const weight = blendWeight ?? genreBlend;
    if (!referenceGenre) return rows.slice(0, limit);
    const anchorRoot = referenceGenre ? referenceGenre.split('.')[0].toLowerCase() : null;

    const scored = rows.map(row => {
      const leafGenre = (row.genre || '').toLowerCase();
      const fullPath = genreMatrixService.getGenrePath(leafGenre) || leafGenre;
      const trackRoot = fullPath.split('.')[0].toLowerCase();

      // 1. Explicit LLM vetoes (full path check)
      if (bannedGenres && bannedGenres.some(b => fullPath.includes(b.toLowerCase()))) {
        return { ...row, combined: Infinity };
      }

      // 2. Root node enforcement: at high weight, block different genre families
      if (weight > 0.8 && anchorRoot && trackRoot && anchorRoot !== trackRoot) {
        return { ...row, combined: Infinity };
      }

      // 3. Multiplicative penalty
      const hopCost = genreMatrixService.getHopCost(referenceGenre, leafGenre);
      const combined = (row.distance ?? 0) * Math.pow(1 + hopCost, weight * penaltyCurve);
      return { ...row, combined };
    });
    scored.sort((a, b) => a.combined - b.combined);
    return scored.slice(0, limit);
  };

  // Helper: pick tracks using a weighted wander factor instead of deterministic top-N
  const wanderSelect = (scoredRows: any[], count: number, wanderStrength: number): any[] => {
    if (scoredRows.length <= count || wanderStrength < 0.05) {
      return scoredRows.slice(0, count);
    }
    const selected: any[] = [];
    const available = [...scoredRows];
    for (let i = 0; i < count && available.length > 0; i++) {
      // Weight: better scores (lower combined) get higher probability
      // wanderStrength controls how much randomness vs deterministic picking
      const weights = available.map((row, idx) => {
        const rankBias = 1 / (1 + idx); // natural decay by rank
        const randomFactor = Math.random() * wanderStrength;
        return rankBias * (1 - wanderStrength + randomFactor * 2);
      });
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      let r = Math.random() * totalWeight;
      let chosenIdx = 0;
      for (let j = 0; j < weights.length; j++) {
        r -= weights[j];
        if (r <= 0) { chosenIdx = j; break; }
      }
      selected.push(available[chosenIdx]);
      available.splice(chosenIdx, 1);
    }
    return selected;
  };

  // Track already-assigned track IDs across LLM concepts to prevent duplicate playlists
  const assignedTrackIds = new Set<string>();

  // Helper: synthesize a 1280D EffNet embedding centroid from the 8D acoustic seed results.
  // The LLM generates an 8D target vector — we don't have a 1280D embedding from the LLM.
  // Instead, we find the 20 closest 8D tracks and average their 1280D embeddings.
  // Uses "Relative Cliff" check to detect sparse/poisoned neighborhoods.
  const imputeEffNetCentroid = async (seed8DStr: string): Promise<string | null> => {
    try {
      const seedRes = await queryWithRetry(`
        SELECT tf.embedding_vector::text as vec,
               (tf.acoustic_vector_8d <-> $1::vector) as distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        WHERE tf.embedding_vector IS NOT NULL
        ORDER BY tf.acoustic_vector_8d <-> $1::vector ASC
        LIMIT 20
      `, [seed8DStr]);

      if (seedRes.rows.length < 5) return null;

      const firstBestDistance = seedRes.rows[0].distance;
      const fifthBestDistance = seedRes.rows[4].distance;

      const ABSOLUTE_CEILING = 1.5;
      const MAX_ALLOWED_CLIFF = 0.5;

      if (fifthBestDistance > ABSOLUTE_CEILING || (fifthBestDistance - firstBestDistance > MAX_ALLOWED_CLIFF)) {
        console.log(`[EffNet Impute] Neighborhood too sparse/steep. 1st: ${firstBestDistance.toFixed(3)}, 5th: ${fifthBestDistance.toFixed(3)}. Aborting.`);
        return null;
      }

      // Compute centroid from valid seeds
      const validSeeds = seedRes.rows.filter((r: any) => r.distance <= 1.5);

      // Determine dimension from first valid seed (128D for EffNet, 13D for legacy MFCC)
      const firstVec = JSON.parse(validSeeds[0].vec);
      const dim = firstVec.length;
      const centroid = new Array(dim).fill(0);

      for (const row of validSeeds) {
        const vec = JSON.parse(row.vec);
        for (let i = 0; i < dim; i++) centroid[i] += vec[i];
      }

      const n = validSeeds.length;
      // L2-normalize the centroid for cosine distance compatibility
      const norm = Math.sqrt(centroid.reduce((s, v) => s + (v / n) * (v / n), 0));
      if (norm > 0) {
        for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] / n) / norm;
      } else {
        for (let i = 0; i < dim; i++) centroid[i] = centroid[i] / n;
      }

      console.log(`[EffNet Impute] Successfully blended ${n} seeds (${dim}D) for embedding centroid.`);
      return `[${centroid.join(',')}]`;
    } catch {
      return null;
    }
  };

  // Generate tracks for each LLM concept and persist them as Playlists
  for (const concept of llmConcepts) {
    // Case B: LLM High-Concept generated concept (e.g. "Evening Acoustic Drift")
    if (concept.target_vector) {
      const targetGenres = (concept as any).target_genres || [];
      const bannedGenres: string[] = (concept as any).banned_genres || [];
      let matchedGenrePath = '';

      if (targetGenres.length > 0) {
        for (const g of targetGenres) {
          const clean = g.toLowerCase().trim();
          const res = await queryWithRetry(
            `(SELECT path FROM genre_tree_paths WHERE LOWER(genre_name) = $1 LIMIT 1)
             UNION ALL
             (SELECT gtp.path FROM genre_tree_paths gtp 
              JOIN genre_alias ga ON gtp.genre_id = ga.genre 
              WHERE LOWER(ga.name) = $1 LIMIT 1)
             LIMIT 1`, 
            [clean]
          );
          if (res.rows.length > 0) {
            matchedGenrePath = res.rows[0].path;
            break;
          }
        }
      }

      if (targetGenres.length > 0 && !matchedGenrePath) {
         console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - target genres [${targetGenres.join(', ')}] not found in DB.`);
         // Setting a special flag so callers can retry
         (concept as any).dropped = true;
         continue;
      }

      const vectorStr = `[${concept.target_vector.join(',')}]`;

      // Dynamic MFCC weight: for highly electronic/synthetic playlists (low acousticness),
      // timbre matters 3× more because MFCC differentiates synthetic vs natural instruments
      const targetAcousticness = concept.target_vector[5]; // index 5 = acousticness
      const effnetWeight = targetAcousticness < 0.3 ? 3.0 : 1.0;

      // Synthesize EffNet embedding centroid from the 8D acoustic neighbourhood
      const embeddingCentroidStr = await imputeEffNetCentroid(vectorStr);

      // === DYNAMIC POOL SIZING ===
      // Pool A (genre-constrained) dominates at high genreBlend weight
      // Pool B (serendipity) expands when Pool A starves
      const ABSOLUTE_MAX_FETCH = 200;
      const dynamicFetchSize = Math.min((tracksPerPlaylist * 3) + 50, ABSOLUTE_MAX_FETCH);
      let limitA = Math.max(10, Math.floor(dynamicFetchSize * genreBlend));
      let limitB = dynamicFetchSize - limitA;

      // Build exclusion set for cross-playlist deduplication
      const assignedIds = Array.from(assignedTrackIds);

      // === TWO-POOL CTE QUERY ===
      let res;
      if (embeddingCentroidStr && matchedGenrePath) {
        // Full two-pool: Pool A (genre-constrained 8D) + Pool B (genre-blind, cosine embedding)
        // params: $1 vectorStr, $2 genrePath, $3 limitA, $4 embeddingCentroid, $5 limitB, $6+ exclusionIds
        const exclClause = assignedIds.length > 0
          ? `AND t.id NOT IN (${assignedIds.map((_, i) => `$${i + 6}`).join(',')})`
          : '';
        res = await queryWithRetry(`
          WITH pool_a AS (
            SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) AS distance, 'A' as pool_source
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
            WHERE sm.path LIKE $2 || '%'
              AND t.duration > 90
              AND tf.acoustic_vector_8d IS NOT NULL
              ${exclClause}
            ORDER BY distance ASC
            LIMIT $3
          ),
          pool_b AS (
            SELECT t.*,
              (tf.acoustic_vector_8d <-> $1::vector) + ((tf.embedding_vector <=> $4::vector) * ${effnetWeight}) AS distance,
              'B' as pool_source
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (SELECT id FROM pool_a)
              AND t.duration > 90
              AND tf.acoustic_vector_8d IS NOT NULL
              AND tf.embedding_vector IS NOT NULL
              ${exclClause}
            ORDER BY distance ASC
            LIMIT $5
          )
          SELECT * FROM pool_a
          UNION ALL
          SELECT * FROM pool_b
        `, [vectorStr, matchedGenrePath, limitA, embeddingCentroidStr, limitB, ...assignedIds]);

        // Pool A starvation fallback: if no genre matches, expand Pool B
        const poolACount = res.rows.filter((r: any) => r.pool_source === 'A').length;
        if (poolACount < 5) {
          console.log(`[LLM Hub] Pool A starved (${poolACount} tracks). Expanding Pool B.`);
          limitB = dynamicFetchSize;
          
          // CRITICAL FIX: The fallback query only has $1 (vector), $2 (centroid), and $3 (limitB). 
          // Exclusion params must start at $4, not $6.
          const exclClauseFallback = assignedIds.length > 0
            ? `AND t.id NOT IN (${assignedIds.map((_, i) => `$${i + 4}`).join(',')})`
            : '';

          res = await queryWithRetry(`
            SELECT t.*,
              (tf.acoustic_vector_8d <-> $1::vector) + ((tf.embedding_vector <=> $2::vector) * ${effnetWeight}) AS distance,
              'B' as pool_source
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE tf.acoustic_vector_8d IS NOT NULL
              AND tf.embedding_vector IS NOT NULL
              AND t.duration > 90
              ${exclClauseFallback}
            ORDER BY distance ASC
            LIMIT $3
          `, [vectorStr, embeddingCentroidStr, limitB, ...assignedIds]);
        }
      } else if (embeddingCentroidStr && !matchedGenrePath) {
        // Embedding available but no genre matched: Pool B only (serendipity)
        const exclClauseFallbackBOnly = assignedIds.length > 0
          ? `AND t.id NOT IN (${assignedIds.map((_, i) => `$${i + 4}`).join(',')})`
          : '';
        res = await queryWithRetry(`
          SELECT t.*,
            (tf.acoustic_vector_8d <-> $1::vector) + ((tf.embedding_vector <=> $2::vector) * ${effnetWeight}) AS distance,
            'B' as pool_source
          FROM tracks t
          JOIN track_features tf ON t.id = tf.track_id
          WHERE tf.acoustic_vector_8d IS NOT NULL
            AND tf.embedding_vector IS NOT NULL
            AND t.duration > 90
            ${exclClauseFallbackBOnly}
          ORDER BY distance ASC
          LIMIT $3
        `, [vectorStr, embeddingCentroidStr, dynamicFetchSize, ...assignedIds]);
      } else if (matchedGenrePath) {
        // Genre matched but no MFCC: Pool A 8D only + Pool B 8D serendipity
        const exclClauseFallbackAAndB = assignedIds.length > 0
          ? `AND t.id NOT IN (${assignedIds.map((_, i) => `$${i + 5}`).join(',')})`
          : '';
        res = await queryWithRetry(`
          WITH pool_a AS (
            SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) AS distance, 'A' as pool_source
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
            WHERE sm.path LIKE $2 || '%'
              AND t.duration > 90
              AND tf.acoustic_vector_8d IS NOT NULL
              ${exclClauseFallbackAAndB}
            ORDER BY distance ASC
            LIMIT $3
          ),
          pool_b AS (
            SELECT t.*,
              tf.acoustic_vector_8d <-> $1::vector AS distance,
              'B' as pool_source
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (SELECT id FROM pool_a)
              AND t.duration > 90
              AND tf.acoustic_vector_8d IS NOT NULL
              ${exclClauseFallbackAAndB}
            ORDER BY distance ASC
            LIMIT $4
          )
          SELECT * FROM pool_a
          UNION ALL
          SELECT * FROM pool_b
        `, [vectorStr, matchedGenrePath, limitA, limitB, ...assignedIds]);
      } else {
        // Graceful degradation: no genre, no MFCC — 8D only (original behavior)
        const exclClauseFallbackGraceful = assignedIds.length > 0
          ? `AND t.id NOT IN (${assignedIds.map((_, i) => `$${i + 3}`).join(',')})`
          : '';
        res = await queryWithRetry(`
          SELECT t.*,
            tf.acoustic_vector_8d <-> $1::vector AS distance,
            'B' as pool_source
          FROM tracks t
          JOIN track_features tf ON t.id = tf.track_id
          WHERE tf.acoustic_vector_8d IS NOT NULL
            AND t.duration > 90
            ${exclClauseFallbackGraceful}
          ORDER BY distance ASC
          LIMIT $2
        `, [vectorStr, dynamicFetchSize, ...assignedIds]);
      }

      
      if (res.rows.length > 0) {
        // Use the mapped path as the reference genre
        const referenceGenre = matchedGenrePath || res.rows[0].genre || '';

        const llmGenreWeight = matchedGenrePath
          ? Math.min(1.0, genreBlend * 2)
          : genreBlend;

        if (referenceGenre) {
          console.log(`[LLM Hub] "${concept.title}" → anchoring re-rank to genre path "${referenceGenre}" (weight=${llmGenreWeight.toFixed(2)})`);
        }
        if (bannedGenres.length > 0) {
          console.log(`[LLM Hub] "${concept.title}" → vetoing: [${bannedGenres.join(', ')}]`);
        }

        const ranked = reRankByHopCost(res.rows, referenceGenre, Math.max(tracksPerPlaylist * 2, 20), llmGenreWeight, bannedGenres);

        // Apply wander factor for diversity instead of deterministic top-N
        const topTracks = wanderSelect(ranked, tracksPerPlaylist, diversity);


        // Register these track IDs to prevent overlap in subsequent playlists
        for (const t of topTracks) {
          assignedTrackIds.add(t.id);
        }

        // Create a formal Playlist record (user-scoped)
        const playlistId = `llm_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        await createPlaylist(playlistId, concept.title || concept.section, concept.description, true, userId);
        
        const trackIds = topTracks.map((r: any) => r.id);
        await addTracksToPlaylist(playlistId, trackIds);

        hubs.push({
          id: playlistId,
          title: concept.title || concept.section,
          description: concept.description,
          isLlmGenerated: true,
          tracks: topTracks.map((r: any) => ({
            ...r,
            albumArtist: r.album_artist,
            trackNumber: r.track_number,
            releaseType: r.release_type,
            isCompilation: !!r.is_compilation
          }))
        });
      }
    }
  }

  // Also append user's existing Playlists to the Hub
  const existingPlaylists = await getPlaylists(userId);
  const fourHoursMs = 4 * 60 * 60 * 1000;

  for (const pl of existingPlaylists) {
     // Hide LLM playlists older than 4 hours from the active Hub view (unless pinned)
     if (pl.isLlmGenerated && !pl.pinned && (Date.now() - pl.createdAt) > fourHoursMs) {
         continue;
     }

     if (!hubs.find((h: any) => h.id === pl.id)) {
        const tracks = await getPlaylistTracks(pl.id);
        if (tracks.length > 0) {
            hubs.push({
              id: pl.id,
              title: pl.title,
              description: pl.description,
              isLlmGenerated: pl.isLlmGenerated,
              pinned: pl.pinned,
              tracks
            });
        }
     }
  }

  // --- ENGINE-DRIVEN CATEGORIES (per-user) ---
  const constraints = await getDynamicConstraints();

  // 1. Up Next (Near user's recent history, genre-aware re-ranking)
  if (userId) {
    const userRecentTracks = await getUserRecentTracks(userId, 5);
    if (userRecentTracks.length >= 3) {
      // Get acoustic vectors for the user's recent tracks
      const recentIds = userRecentTracks.map((t: any) => t.id);
      const placeholders = recentIds.map((_, i) => `$${i + 1}`).join(',');
      const vecRes = await queryWithRetry(`
        SELECT t.id, t.genre, tf.acoustic_vector, tf.acoustic_vector_8d
        FROM tracks t JOIN track_features tf ON t.id = tf.track_id
        WHERE t.id IN (${placeholders})
      `, recentIds);

      if (vecRes.rows.length >= 3) {
        // Compute 8D acoustic centroid
        let centroid = [0,0,0,0,0,0,0,0];
        let effnetCentroid: number[] | null = null;
        let hasMfcc = true;
        for (const r of vecRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector_8d || r.acoustic_vector);
          for(let i=0; i<8; i++) centroid[i] += (vec[i] || 0.5); // Fallback to 0.5 (neutral) instead of undefined/NaN
          if (r.mfcc_vector) {
            if (!effnetCentroid) effnetCentroid = new Array(128).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<128; i++) (effnetCentroid as number[])[i] += mv[i];
          } else {
            hasMfcc = false;
          }
        }
        centroid = centroid.map(v => v / vecRes.rows.length);
        const vecStr = `[${centroid.join(',')}]`;
        if (hasMfcc && effnetCentroid) {
          effnetCentroid = effnetCentroid.map(v => v / vecRes.rows.length);
        } else {
          effnetCentroid = null;
        }
        const effnetStr = effnetCentroid ? `[${effnetCentroid.join(',')}]` : null;
        const referenceGenre = (vecRes.rows[0] as any).genre || '';

        let upNextRes;
        if (effnetStr) {
          upNextRes = await queryWithRetry(`
            SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+3}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
            ORDER BY distance ASC LIMIT $${recentIds.length + 3}
          `, [vecStr, effnetStr, ...recentIds, constraints.nearestNeighborLimit]);
        } else {
          upNextRes = await queryWithRetry(`
            SELECT t.*, tf.acoustic_vector_8d <-> $1::vector AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+2}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL
            ORDER BY distance ASC LIMIT $${recentIds.length + 2}
          `, [vecStr, ...recentIds, constraints.nearestNeighborLimit]);
        }

        if (upNextRes.rows.length > 0) {
          const ranked = reRankByHopCost(upNextRes.rows, referenceGenre, 30);
          const pool = ranked.sort(() => 0.5 - Math.random());
          hubs.unshift({
            id: 'engine_upnext', title: 'Up Next', description: 'Based on what you just listened to.',
            isLlmGenerated: false, tracks: pool.slice(0, 15)
          });
        }
      }
    }
  } else {
    // Fallback: use global tracks table (backward compat)
    const recentTracksRes = await queryWithRetry(
      'SELECT t.id, t.genre, tf.acoustic_vector, tf.acoustic_vector_8d FROM tracks t JOIN track_features tf ON t.id = tf.track_id WHERE t.last_played_at IS NOT NULL ORDER BY t.last_played_at DESC LIMIT 5'
    );
     if (recentTracksRes.rows.length >= 3) {
       let centroid = [0,0,0,0,0,0,0,0];
       let effnetCentroid: number[] | null = null;
       let hasMfcc = true;
       for (const r of recentTracksRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector_8d || r.acoustic_vector);
          for(let i=0; i<8; i++) centroid[i] += (vec[i] || 0.5);
          if (r.mfcc_vector) {
            if (!effnetCentroid) effnetCentroid = new Array(128).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<128; i++) (effnetCentroid as number[])[i] += mv[i];
          } else { hasMfcc = false; }
       }
       centroid = centroid.map(v => v / recentTracksRes.rows.length);
       const vecStr = `[${centroid.join(',')}]`;
       if (hasMfcc && effnetCentroid) {
         effnetCentroid = effnetCentroid.map(v => v / recentTracksRes.rows.length);
       } else { effnetCentroid = null; }
       const effnetStr = effnetCentroid ? `[${effnetCentroid.join(',')}]` : null;
       const recentIds = recentTracksRes.rows.map((r:any) => r.id);
       const referenceGenre = (recentTracksRes.rows[0] as any).genre || '';

       let upNextRes;
       if (effnetStr) {
         upNextRes = await queryWithRetry(`
           SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+3}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
           ORDER BY distance ASC LIMIT $${recentIds.length + 3}
         `, [vecStr, effnetStr, ...recentIds, constraints.nearestNeighborLimit]);
       } else {
         upNextRes = await queryWithRetry(`
           SELECT t.*, tf.acoustic_vector_8d <-> $1::vector AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+2}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL
           ORDER BY distance ASC LIMIT $${recentIds.length + 2}
         `, [vecStr, ...recentIds, constraints.nearestNeighborLimit]);
       }

       if (upNextRes.rows.length > 0) {
         const ranked = reRankByHopCost(upNextRes.rows, referenceGenre, 30);
         const pool = ranked.sort(() => 0.5 - Math.random());
         hubs.unshift({
           id: 'engine_upnext', title: 'Up Next', description: 'Based on what you just listened to.',
           isLlmGenerated: false, tracks: pool.slice(0, 15)
         });
       }
    }
  }

  // 2. Jump Back In — Heat Score system (per-user)
  const nowMs = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;

  let jumpRes;
  if (userId) {
    jumpRes = await queryWithRetry(`
      SELECT t.*, ups.play_count, ups.last_played_at,
        ups.play_count * GREATEST(0, 1 - POWER(
          EXTRACT(EPOCH FROM (NOW() - ups.last_played_at)) / (365.0 * 86400), 2
        )) AS heatScore
      FROM user_playback_stats ups
      JOIN tracks t ON ups.track_id = t.id
      WHERE ups.user_id = $1
        AND ups.play_count >= 2
        AND ups.last_played_at IS NOT NULL
        AND ups.last_played_at < NOW() - INTERVAL '30 days'
        AND ups.last_played_at > NOW() - INTERVAL '2 years'
      ORDER BY heatScore DESC
      LIMIT 30
    `, [userId]);
  } else {
    // Fallback: global (backward compat)
    jumpRes = await queryWithRetry(`
      SELECT *,
        play_count * GREATEST(0, 1 - POWER(
          EXTRACT(EPOCH FROM (NOW() - last_played_at)) / (365.0 * 86400), 2
        )) AS heatScore
      FROM tracks
      WHERE play_count >= 2
        AND last_played_at IS NOT NULL
        AND last_played_at < NOW() - INTERVAL '30 days'
        AND last_played_at > NOW() - INTERVAL '2 years'
      ORDER BY heatScore DESC
      LIMIT 30
    `);
  }

  if (jumpRes.rows.length > 0) {
     const shuffled = jumpRes.rows.sort(() => 0.5 - Math.random());
     hubs.unshift({
       id: 'engine_jumpback', title: 'Jump Back In', description: 'Tracks you love that have been waiting.',
       isLlmGenerated: false, tracks: shuffled.slice(0, 15)
     });
  }

  // 3. The Vault (0 plays, acoustically near user's most-played tracks, genre-aware)
  if (userId) {
    const userTopTracks = await getUserTopTracks(userId, 10);
    if (userTopTracks.length > 0) {
      // Get acoustic vectors for user's top tracks
      const topIds = userTopTracks.map((t: any) => t.id);
      const topPlaceholders = topIds.map((_, i) => `$${i + 1}`).join(',');
      const topVecRes = await queryWithRetry(`
        SELECT t.id, t.genre, tf.acoustic_vector, tf.acoustic_vector_8d
        FROM tracks t JOIN track_features tf ON t.id = tf.track_id
        WHERE t.id IN (${topPlaceholders})
      `, topIds);

      if (topVecRes.rows.length > 0) {
        let centroid = [0,0,0,0,0,0,0,0];
        let effnetCentroid: number[] | null = null;
        let hasMfcc = true;
        for (const r of topVecRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector_8d || r.acoustic_vector);
          for(let i=0; i<8; i++) centroid[i] += (vec[i] || 0.5);
          if (r.mfcc_vector) {
            if (!effnetCentroid) effnetCentroid = new Array(128).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<128; i++) (effnetCentroid as number[])[i] += mv[i];
          } else { hasMfcc = false; }
        }
        centroid = centroid.map(v => v / topVecRes.rows.length);
        const vecStr = `[${centroid.join(',')}]`;
        if (hasMfcc && effnetCentroid) {
          effnetCentroid = effnetCentroid.map(v => v / topVecRes.rows.length);
        } else { effnetCentroid = null; }
        const effnetStr = effnetCentroid ? `[${effnetCentroid.join(',')}]` : null;
        const referenceGenre = (topVecRes.rows[0] as any).genre || '';

        // Find tracks with 0 plays by THIS user
        let vaultRes;
        if (effnetStr) {
          vaultRes = await queryWithRetry(`
            SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (
              SELECT track_id FROM user_playback_stats WHERE user_id = $4 AND play_count > 0
            ) AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
            ORDER BY distance ASC LIMIT $3
          `, [vecStr, effnetStr, constraints.nearestNeighborLimit, userId]);
        } else {
          vaultRes = await queryWithRetry(`
            SELECT t.*, tf.acoustic_vector_8d <-> $1::vector AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (
              SELECT track_id FROM user_playback_stats WHERE user_id = $3 AND play_count > 0
            ) AND tf.acoustic_vector_8d IS NOT NULL
            ORDER BY distance ASC LIMIT $2
          `, [vecStr, constraints.nearestNeighborLimit, userId]);
        }

        if (vaultRes.rows.length > 0) {
          const ranked = reRankByHopCost(vaultRes.rows, referenceGenre, 30);
          const shuffled = ranked.sort(() => 0.5 - Math.random());
          hubs.push({
            id: 'engine_vault', title: 'The Vault', description: 'Unplayed tracks that match your taste.',
            isLlmGenerated: false, tracks: shuffled.slice(0, 15)
          });
        }
      }
    }
  } else {
    // Fallback: global (backward compat)
    const topTracksRes = await queryWithRetry(
      'SELECT t.id, t.genre, tf.acoustic_vector, tf.acoustic_vector_8d, tf.embedding_vector FROM tracks t JOIN track_features tf ON t.id = tf.track_id WHERE t.play_count > 0 ORDER BY t.play_count DESC LIMIT 10'
    );
    if (topTracksRes.rows.length > 0) {
       let centroid = [0,0,0,0,0,0,0,0];
       let effnetCentroid: number[] | null = null;
       let hasMfcc = true;
       for (const r of topTracksRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector_8d || r.acoustic_vector);
          for(let i=0; i<8; i++) centroid[i] += (vec[i] || 0.5);
          if (r.mfcc_vector) {
            if (!effnetCentroid) effnetCentroid = new Array(128).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<128; i++) (effnetCentroid as number[])[i] += mv[i];
          } else { hasMfcc = false; }
       }
       centroid = centroid.map(v => v / topTracksRes.rows.length);
       const vecStr = `[${centroid.join(',')}]`;
       if (hasMfcc && effnetCentroid) {
         effnetCentroid = effnetCentroid.map(v => v / topTracksRes.rows.length);
       } else { effnetCentroid = null; }
       const effnetStr = effnetCentroid ? `[${effnetCentroid.join(',')}]` : null;
       const referenceGenre = (topTracksRes.rows[0] as any).genre || '';

       let vaultRes;
       if (effnetStr) {
         vaultRes = await queryWithRetry(`
           SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.play_count = 0 AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
           ORDER BY distance ASC LIMIT $3
         `, [vecStr, effnetStr, constraints.nearestNeighborLimit]);
       } else {
         vaultRes = await queryWithRetry(`
           SELECT t.*, tf.acoustic_vector_8d <-> $1::vector AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.play_count = 0 AND tf.acoustic_vector_8d IS NOT NULL
           ORDER BY distance ASC LIMIT $2
         `, [vecStr, constraints.nearestNeighborLimit]);
       }

       if (vaultRes.rows.length > 0) {
         const ranked = reRankByHopCost(vaultRes.rows, referenceGenre, 30);
         const shuffled = ranked.sort(() => 0.5 - Math.random());
         hubs.push({
           id: 'engine_vault', title: 'The Vault', description: 'Unplayed tracks that match your taste.',
           isLlmGenerated: false, tracks: shuffled.slice(0, 15)
         });
       }
    }
  }

  return hubs;

}

export async function getDynamicConstraints() {
  const res = await queryWithRetry(`SELECT COUNT(*) as count FROM tracks`);
  const total = parseInt((res.rows[0] as any).count, 10) || 0;

  // Defaults for Medium (500 - 5000)
  const constraints = {
    historyPenaltySize: 10,
    randomizerPoolSize: 20,
    nearestNeighborLimit: 50,
    distanceThreshold: 0.5
  };

  if (total < 500) {
    constraints.historyPenaltySize = 0; // Loosen restrictions for tiny libraries
    constraints.randomizerPoolSize = 5;
    constraints.nearestNeighborLimit = 20;
    constraints.distanceThreshold = 1.0;
  } else if (total > 5000) {
    constraints.historyPenaltySize = 50; // Strict penalties for large libraries
    constraints.randomizerPoolSize = 50;
    constraints.nearestNeighborLimit = 100;
    constraints.distanceThreshold = 0.3;
  }

  return constraints;
}

export async function calculateNextInfinityTrack(
  sessionHistoryTrackIds: string[],
  settings: any = {}
) {
  const constraints = await getDynamicConstraints();
  
  // 1. Fetch vectors for the last 10 tracks to compute the Weighted Decay Centroid
  let targetVector = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // safe fallback
  let recentVectors: number[][] = [];
  
  if (sessionHistoryTrackIds.length > 0) {
    const last10Ids = sessionHistoryTrackIds.slice(-10);
    // Maintain strict order
    const placeholders = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const vecRes = await queryWithRetry(`
      SELECT t.id, tf.acoustic_vector_8d, tf.acoustic_vector, tf.embedding_vector
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id 
      WHERE t.id IN (${placeholders})
    `, last10Ids);

    let recentMfccVectors: number[][] = [];

    // Map rows back to the ordered last10 array
    for (const id of last10Ids) {
      const row = vecRes.rows.find((r: any) => r.id === id) as any;
      if (row && (row.acoustic_vector_8d || row.acoustic_vector)) {
        recentVectors.push(JSON.parse(row.acoustic_vector_8d || row.acoustic_vector));
        if (row.mfcc_vector) {
          recentMfccVectors.push(JSON.parse(row.mfcc_vector as string));
        }
      }
    }

    if (recentVectors.length > 0) {
      // 9.1: The Weighted Decay Centroid (lambda = 0.8)
      const lambda = 0.8;
      targetVector = [0,0,0,0,0,0,0,0];
      let weightSum = 0;
      
      // Iterate from oldest to newest in the recent active window
      for (let i = 0; i < recentVectors.length; i++) {
        const weight = Math.pow(lambda, recentVectors.length - 1 - i);
        weightSum += weight;
        for (let j = 0; j < 8; j++) {
           const val = recentVectors[i][j] ?? 0.5; // fallback for inconsistent vector length
           targetVector[j] += val * weight;
        }
      }
      
      for (let j = 0; j < 8; j++) {
        targetVector[j] /= weightSum;
      }
      
      // 9.2: Momentum & Trajectory Tracking (last 3 tracks)
      if (recentVectors.length >= 3) {
         const v3 = recentVectors[recentVectors.length - 1]; // newest
         const v2 = recentVectors[recentVectors.length - 2];
         const v1 = recentVectors[recentVectors.length - 3]; // oldest
           
         // Simple linear slope detection: average the two deltas
         const energyDelta = ((v3[0] - v2[0]) + (v2[0] - v1[0])) / 2;
         const danceDelta = ((v3[6] - v2[6]) + (v2[6] - v1[6])) / 2;
         
         if (energyDelta > 0.05) targetVector[0] = Math.min(1.0, targetVector[0] * 1.1);
         else if (energyDelta < -0.05) targetVector[0] = Math.max(0.0, targetVector[0] * 0.9);

         if (danceDelta > 0.05) targetVector[6] = Math.min(1.0, targetVector[6] * 1.1);
         else if (danceDelta < -0.05) targetVector[6] = Math.max(0.0, targetVector[6] * 0.9);
      }
    }
  }

  // Deduplication: Fetch metadata for the last 50 tracks to prevent duplicate songs from different albums
  const dedupeHistoryIds = sessionHistoryTrackIds.slice(-50);
  let historyMetadata: any[] = [];
  if (dedupeHistoryIds.length > 0) {
    const metaPlaceholders = dedupeHistoryIds.map((_, i) => `$${i + 1}`).join(',');
    const metaRes = await queryWithRetry(`
      SELECT id, title, artist, mb_recording_id FROM tracks WHERE id IN (${metaPlaceholders})
    `, dedupeHistoryIds);
    historyMetadata = metaRes.rows;
  }

  const vectorStr = `[${targetVector.join(',')}]`;

  // Compute MFCC timbre centroid (weighted decay, same lambda) for the last-10 window
  let effnetVectorStr: string | null = null;
  if (sessionHistoryTrackIds.length > 0) {
    const last10Ids = sessionHistoryTrackIds.slice(-10);
    const placeholders2 = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const effnetRes = await queryWithRetry(`
      SELECT t.id, tf.embedding_vector
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id
      WHERE t.id IN (${placeholders2}) AND tf.embedding_vector IS NOT NULL
    `, last10Ids);
    if (effnetRes.rows.length > 0) {
      const lambda = 0.8;
      const effnetTarget = new Array(1280).fill(0);
      let effnetWeightSum = 0;
      const orderedEffnet: number[][] = [];
      for (const id of last10Ids) {
        const row = effnetRes.rows.find((r: any) => r.id === id) as any;
        if (row && row.embedding_vector) orderedEffnet.push(JSON.parse(row.embedding_vector));
      }
      for (let i = 0; i < orderedEffnet.length; i++) {
        const weight = Math.pow(lambda, orderedEffnet.length - 1 - i);
        effnetWeightSum += weight;
        for (let j = 0; j < 1280; j++) effnetTarget[j] += orderedEffnet[i][j] * weight;
      }
      effnetVectorStr = `[${effnetTarget.map(v => v / effnetWeightSum).join(',')}]`;
    }
  }

  // Apply Frontend Settings for Engine Tuning
  let discoveryLevel = settings.discoveryLevel ?? 50; // 1-100
  let genreStrictness = settings.genreStrictness ?? 50; // 0-100
  
  // Base parameters
  let genreWeight = (genreStrictness / 100) * 3.0;
  let poolSize = Math.max(5, Math.floor(discoveryLevel / 2));
  let penaltySize = settings.artistAmnesiaLimit !== undefined 
                      ? settings.artistAmnesiaLimit 
                      : constraints.historyPenaltySize;
                      
  let currentGenre = '';
  if (sessionHistoryTrackIds.length > 0) {
    const lastTrackId = sessionHistoryTrackIds[sessionHistoryTrackIds.length - 1];
    const lastTrackRes = await queryWithRetry('SELECT genre FROM tracks WHERE id = $1', [lastTrackId]);
    if (lastTrackRes.rows.length > 0 && (lastTrackRes.rows[0] as any).genre) {
      currentGenre = (lastTrackRes.rows[0] as any).genre as string;
    }
  }

  let finalCandidates: any[] = [];

  // Iterative Relaxation Loop
  for (let attempt = 0; attempt < 3; attempt++) {
    const penaltyIds = sessionHistoryTrackIds.slice(-penaltySize);
    const historyParams = penaltyIds.map((_, i) => `$${i + 2}`);
    const historyClause = historyParams.length > 0 ? `WHERE t.id NOT IN (${historyParams.join(',')})` : '';

    // Step 4.1: Over-fetch
    const overFetchLimit = poolSize * 3 + 50;

    let res;
    if (effnetVectorStr) {
      const renumberedHistory = historyClause
        ? `AND ${historyClause.replace(/^WHERE /, '').replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`)}`
        : '';
      res = await queryWithRetry(`
        SELECT t.*, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        WHERE tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
        ${renumberedHistory}
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 3}
      `, [vectorStr, effnetVectorStr, ...penaltyIds, overFetchLimit]);
    } else {
      res = await queryWithRetry(`
        SELECT t.*, tf.acoustic_vector_8d <-> $1::vector AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        WHERE tf.acoustic_vector_8d IS NOT NULL ${historyClause ? `AND ${historyClause.replace(/^WHERE /, '')}` : ''}
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 2}
      `, [vectorStr, ...penaltyIds, overFetchLimit]);
    }

    if (res.rows.length > 0) {
      // Step 4.2: Apply Hop Cost
      const scored = res.rows.map((row: any) => {
        const hopCost = genreMatrixService.getHopCost(currentGenre, row.genre || '');
        const finalScore = row.distance * Math.pow(1 + hopCost, genreWeight / 3.0);
        return { ...row, hopCost, originalDistance: row.distance, finalScore };
      });

      // Step 4.2b: Filter out "Same Song" duplicates (different albums/remasters)
      const uniqueScored = scored.filter(candidate => {
        const matchingHistory = historyMetadata.find(h => isSameSong(h, candidate));
        if (matchingHistory) {
          // If the candidate IS the exact same track ID, it's already excluded by SQL
          // But if it's a sibling (same recording, different album), we drop it here.
          return false;
        }
        return true;
      });

      // Filter and sort by the dynamically weighted score
      uniqueScored.sort((a, b) => a.finalScore - b.finalScore);
      
      // Ensure we have candidates within an acceptable boundary
      // We become less strict on absolute bounds as attempts increase
      const acceptable = uniqueScored.filter(c => c.finalScore < (constraints.distanceThreshold * (1 + attempt)));
      const pool = acceptable.length > 0 ? acceptable : uniqueScored; // fallback to best available if none acceptable

      finalCandidates = pool.slice(0, poolSize);
      if (finalCandidates.length > 0) {
        const avgMatch = finalCandidates.reduce((sum, c) => sum + (c.finalScore || 0), 0) / finalCandidates.length;
        const avgHop = finalCandidates.reduce((sum, c) => sum + (c.hopCost || 0), 0) / finalCandidates.length;
        console.log(`[Engine] Found tracks after ${attempt} relaxation(s). AvgMatch: ${avgMatch.toFixed(3)}, AvgHop: ${avgHop.toFixed(2)}, PenaltySize: ${penaltySize}, GenWt: ${genreWeight.toFixed(2)}`);
        break; // Met quota
      }
    }

    // Relax Constraints
    poolSize += 10;
    genreWeight *= 0.75;
    penaltySize = Math.max(0, Math.floor(penaltySize / 2));
  }

  // Handle absolute pool exhaustion gracefully
  if (finalCandidates.length === 0) {
      const randomFallback = await queryWithRetry('SELECT * FROM tracks ORDER BY RANDOM() LIMIT 1');
      return randomFallback.rows[0];
  }

  // Wander Factor: Pick a track from the final candidates using a weighted randomizer
  const candidates = finalCandidates.map((row: any) => ({
      ...row,
      weight: 1 / (Math.max(0.01, row.finalScore))
  }));

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let randomVal = Math.random() * totalWeight;
  
  for (const c of candidates) {
      randomVal -= c.weight;
      if (randomVal <= 0) {
          return c;
      }
  }

  return candidates[0]; // fallback to #1
}
