import { initDB, createPlaylist, addTracksToPlaylist, getPlaylists, getPlaylistTracks, getUserRecentTracks, getUserTopTracks } from '../database';
import { genreMatrixService } from './genreMatrix.service';

// 1. Z-Score normalization is handled by scaling 0-1 mapped values in JS, but 
// for simplicity we assume vectors are already [0,1] normalized.
// Distance query uses native PGLite `<->` vector L2 distance operator.

export async function getHubCollections(
  llmConcepts: { section: string, title?: string, description: string, target_vector: number[] }[],
  userId: string | null = null,
  settings: { genreBlendWeight?: number, llmTracksPerPlaylist?: number, llmPlaylistDiversity?: number } = {}
) {
  const db = await initDB();
  const hubs: any[] = [];

  const genreBlend = (settings.genreBlendWeight ?? 50) / 100; // 0.0 to 1.0
  const tracksPerPlaylist = settings.llmTracksPerPlaylist ?? 10;
  const diversity = (settings.llmPlaylistDiversity ?? 50) / 100; // 0.0 to 1.0

  // Helper: re-rank a pool of tracks by blending vector distance with genre hop cost.
  const reRankByHopCost = (rows: any[], referenceGenre: string, limit: number, blendWeight?: number) => {
    const weight = blendWeight ?? genreBlend;
    if (!referenceGenre) return rows.slice(0, limit);
    const scored = rows.map(row => {
      const hopCost = genreMatrixService.getHopCost(referenceGenre, row.genre || '');
      const combined = (row.distance ?? 0) + hopCost * weight;
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

  // Helper: synthesize a 13D MFCC timbre centroid from the 7D acoustic seed results.
  // Keeps LLM concepts at 7D token cost while enabling 20D ranking.
  const imputeTimbreCentroid = async (seed7DStr: string): Promise<string | null> => {
    try {
      const seedRes = await db.query(`
        SELECT tf.mfcc_vector
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        WHERE tf.acoustic_vector <-> $1 < 1.0
          AND tf.mfcc_vector IS NOT NULL
        ORDER BY tf.acoustic_vector <-> $1 ASC
        LIMIT 20
      `, [seed7DStr]);
      if (seedRes.rows.length === 0) return null;
      const centroid = new Array(13).fill(0);
      for (const row of seedRes.rows as any[]) {
        const vec = JSON.parse(row.mfcc_vector);
        for (let i = 0; i < 13; i++) centroid[i] += vec[i];
      }
      const n = seedRes.rows.length;
      return `[${centroid.map(v => v / n).join(',')}]`;
    } catch {
      return null;
    }
  };

  // Generate tracks for each LLM concept and persist them as Playlists
  for (const concept of llmConcepts) {
    // Case B: LLM High-Concept generated concept (e.g. "Evening Acoustic Drift")
    if (concept.target_vector) {
      const vectorStr = `[${concept.target_vector.join(',')}]`;

      // Synthesize MFCC timbre centroid from the 7D acoustic neighbourhood
      const mfccCentroidStr = await imputeTimbreCentroid(vectorStr);

      // Build exclusion clause for cross-playlist deduplication
      const exclusionParams: string[] = [];
      let exclusionClause = '';
      if (assignedTrackIds.size > 0) {
        const ids = Array.from(assignedTrackIds);
        const placeholders = ids.map((_, i) => `$${i + 3}`).join(',');
        exclusionClause = `WHERE t.id NOT IN (${placeholders})`;
        exclusionParams.push(...ids);
      }

      let res;
      if (mfccCentroidStr) {
        // Full 20D query: acoustic + mfcc combined distance
        res = await db.query(`
          SELECT t.*, (tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance
          FROM tracks t
          JOIN track_features tf ON t.id = tf.track_id
          WHERE tf.mfcc_vector IS NOT NULL
          ${exclusionClause}
          ORDER BY distance ASC
          LIMIT 50
        `, [vectorStr, mfccCentroidStr, ...exclusionParams]);
        // Fallback: if 20D yields too few results, supplement with 7D query
        if (res.rows.length < 10) {
          const renumberedExclusion = exclusionClause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) - 1}`);
          res = await db.query(`
            SELECT t.*, tf.acoustic_vector <-> $1 AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            ${renumberedExclusion}
            ORDER BY distance ASC
            LIMIT 50
          `, [vectorStr, ...exclusionParams]);
        }
      } else {
        // Graceful degradation: no MFCC data yet, use 7D only
        const renumberedExclusion = exclusionClause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) - 1}`);
        res = await db.query(`
          SELECT t.*, tf.acoustic_vector <-> $1 AS distance
          FROM tracks t
          JOIN track_features tf ON t.id = tf.track_id
          ${renumberedExclusion}
          ORDER BY distance ASC
          LIMIT 50
        `, [vectorStr, ...exclusionParams]);
      }
      
      if (res.rows.length > 0) {
        // Re-rank by macro-genre to avoid jarring transitions
        const referenceGenre = res.rows[0].genre || '';
        const ranked = reRankByHopCost(res.rows, referenceGenre, Math.max(tracksPerPlaylist * 2, 20));

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
            albumArtist: r.albumartist,
            trackNumber: r.tracknumber,
            releaseType: r.releasetype,
            isCompilation: !!r.iscompilation
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
      const vecRes = await db.query(`
        SELECT t.id, t.genre, tf.acoustic_vector
        FROM tracks t JOIN track_features tf ON t.id = tf.track_id
        WHERE t.id IN (${placeholders})
      `, recentIds);

      if (vecRes.rows.length >= 3) {
        // Compute 7D acoustic centroid
        let centroid = [0,0,0,0,0,0,0];
        let mfccCentroid: number[] | null = null;
        let hasMfcc = true;
        for (const r of vecRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector);
          for(let i=0; i<7; i++) centroid[i] += vec[i];
          if (r.mfcc_vector) {
            if (!mfccCentroid) mfccCentroid = new Array(13).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<13; i++) (mfccCentroid as number[])[i] += mv[i];
          } else {
            hasMfcc = false;
          }
        }
        centroid = centroid.map(v => v / vecRes.rows.length);
        const vecStr = `[${centroid.join(',')}]`;
        if (hasMfcc && mfccCentroid) {
          mfccCentroid = mfccCentroid.map(v => v / vecRes.rows.length);
        } else {
          mfccCentroid = null;
        }
        const mfccStr = mfccCentroid ? `[${mfccCentroid.join(',')}]` : null;
        const referenceGenre = (vecRes.rows[0] as any).genre || '';

        let upNextRes;
        if (mfccStr) {
          upNextRes = await db.query(`
            SELECT t.*, (tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+3}`).join(',')}) AND tf.mfcc_vector IS NOT NULL
            ORDER BY distance ASC LIMIT $${recentIds.length + 3}
          `, [vecStr, mfccStr, ...recentIds, constraints.nearestNeighborLimit]);
        } else {
          upNextRes = await db.query(`
            SELECT t.*, tf.acoustic_vector <-> $1 AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+2}`).join(',')})
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
    const recentTracksRes = await db.query(
      'SELECT t.id, t.genre, tf.acoustic_vector FROM tracks t JOIN track_features tf ON t.id = tf.track_id ORDER BY t.lastPlayedAt DESC LIMIT 5'
    );
    if (recentTracksRes.rows.length >= 3) {
       let centroid = [0,0,0,0,0,0,0];
       let mfccCentroid: number[] | null = null;
       let hasMfcc = true;
       for (const r of recentTracksRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector);
          for(let i=0; i<7; i++) centroid[i] += vec[i];
          if (r.mfcc_vector) {
            if (!mfccCentroid) mfccCentroid = new Array(13).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<13; i++) (mfccCentroid as number[])[i] += mv[i];
          } else { hasMfcc = false; }
       }
       centroid = centroid.map(v => v / recentTracksRes.rows.length);
       const vecStr = `[${centroid.join(',')}]`;
       if (hasMfcc && mfccCentroid) {
         mfccCentroid = mfccCentroid.map(v => v / recentTracksRes.rows.length);
       } else { mfccCentroid = null; }
       const mfccStr = mfccCentroid ? `[${mfccCentroid.join(',')}]` : null;
       const recentIds = recentTracksRes.rows.map((r:any) => r.id);
       const referenceGenre = (recentTracksRes.rows[0] as any).genre || '';

       let upNextRes;
       if (mfccStr) {
         upNextRes = await db.query(`
           SELECT t.*, (tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+3}`).join(',')}) AND tf.mfcc_vector IS NOT NULL
           ORDER BY distance ASC LIMIT $${recentIds.length + 3}
         `, [vecStr, mfccStr, ...recentIds, constraints.nearestNeighborLimit]);
       } else {
         upNextRes = await db.query(`
           SELECT t.*, tf.acoustic_vector <-> $1 AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+2}`).join(',')})
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
    jumpRes = await db.query(`
      SELECT t.*, ups.play_count, ups.last_played_at,
        ups.play_count * GREATEST(0, 1 - POWER(
          (($1::bigint - ups.last_played_at)::float / (365.0 * 86400 * 1000)), 2
        )) AS heatScore
      FROM user_playback_stats ups
      JOIN tracks t ON ups.track_id = t.id
      WHERE ups.user_id = $4
        AND ups.play_count >= 2
        AND ups.last_played_at > 0
        AND ups.last_played_at < ($1::bigint - $2::bigint)
        AND ups.last_played_at > ($1::bigint - $3::bigint)
      ORDER BY heatScore DESC
      LIMIT 30
    `, [nowMs, thirtyDaysMs, twoYearsMs, userId]);
  } else {
    // Fallback: global (backward compat)
    jumpRes = await db.query(`
      SELECT *,
        playCount * GREATEST(0, 1 - POWER(
          (($1::bigint - lastPlayedAt)::float / (365.0 * 86400 * 1000)), 2
        )) AS heatScore
      FROM tracks
      WHERE playCount >= 2
        AND lastPlayedAt > 0
        AND lastPlayedAt < ($1::bigint - $2::bigint)
        AND lastPlayedAt > ($1::bigint - $3::bigint)
      ORDER BY heatScore DESC
      LIMIT 30
    `, [nowMs, thirtyDaysMs, twoYearsMs]);
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
      const topVecRes = await db.query(`
        SELECT t.id, t.genre, tf.acoustic_vector
        FROM tracks t JOIN track_features tf ON t.id = tf.track_id
        WHERE t.id IN (${topPlaceholders})
      `, topIds);

      if (topVecRes.rows.length > 0) {
        let centroid = [0,0,0,0,0,0,0];
        let mfccCentroid: number[] | null = null;
        let hasMfcc = true;
        for (const r of topVecRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector);
          for(let i=0; i<7; i++) centroid[i] += vec[i];
          if (r.mfcc_vector) {
            if (!mfccCentroid) mfccCentroid = new Array(13).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<13; i++) (mfccCentroid as number[])[i] += mv[i];
          } else { hasMfcc = false; }
        }
        centroid = centroid.map(v => v / topVecRes.rows.length);
        const vecStr = `[${centroid.join(',')}]`;
        if (hasMfcc && mfccCentroid) {
          mfccCentroid = mfccCentroid.map(v => v / topVecRes.rows.length);
        } else { mfccCentroid = null; }
        const mfccStr = mfccCentroid ? `[${mfccCentroid.join(',')}]` : null;
        const referenceGenre = (topVecRes.rows[0] as any).genre || '';

        // Find tracks with 0 plays by THIS user
        let vaultRes;
        if (mfccStr) {
          vaultRes = await db.query(`
            SELECT t.*, (tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (
              SELECT track_id FROM user_playback_stats WHERE user_id = $4 AND play_count > 0
            ) AND tf.mfcc_vector IS NOT NULL
            ORDER BY distance ASC LIMIT $3
          `, [vecStr, mfccStr, constraints.nearestNeighborLimit, userId]);
        } else {
          vaultRes = await db.query(`
            SELECT t.*, tf.acoustic_vector <-> $1 AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            WHERE t.id NOT IN (
              SELECT track_id FROM user_playback_stats WHERE user_id = $3 AND play_count > 0
            )
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
    const topTracksRes = await db.query(
      'SELECT t.id, t.genre, tf.acoustic_vector, tf.mfcc_vector FROM tracks t JOIN track_features tf ON t.id = tf.track_id WHERE t.playCount > 0 ORDER BY t.playCount DESC LIMIT 10'
    );
    if (topTracksRes.rows.length > 0) {
       let centroid = [0,0,0,0,0,0,0];
       let mfccCentroid: number[] | null = null;
       let hasMfcc = true;
       for (const r of topTracksRes.rows as any[]) {
          const vec = JSON.parse(r.acoustic_vector);
          for(let i=0; i<7; i++) centroid[i] += vec[i];
          if (r.mfcc_vector) {
            if (!mfccCentroid) mfccCentroid = new Array(13).fill(0);
            const mv = JSON.parse(r.mfcc_vector);
            for(let i=0; i<13; i++) (mfccCentroid as number[])[i] += mv[i];
          } else { hasMfcc = false; }
       }
       centroid = centroid.map(v => v / topTracksRes.rows.length);
       const vecStr = `[${centroid.join(',')}]`;
       if (hasMfcc && mfccCentroid) {
         mfccCentroid = mfccCentroid.map(v => v / topTracksRes.rows.length);
       } else { mfccCentroid = null; }
       const mfccStr = mfccCentroid ? `[${mfccCentroid.join(',')}]` : null;
       const referenceGenre = (topTracksRes.rows[0] as any).genre || '';

       let vaultRes;
       if (mfccStr) {
         vaultRes = await db.query(`
           SELECT t.*, (tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.playCount = 0 AND tf.mfcc_vector IS NOT NULL
           ORDER BY distance ASC LIMIT $3
         `, [vecStr, mfccStr, constraints.nearestNeighborLimit]);
       } else {
         vaultRes = await db.query(`
           SELECT t.*, tf.acoustic_vector <-> $1 AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           WHERE t.playCount = 0
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
  const db = await initDB();
  const res = await db.query(`SELECT COUNT(*) as count FROM tracks`);
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
  const db = await initDB();
  const constraints = await getDynamicConstraints();
  
  // 1. Fetch vectors for the last 10 tracks to compute the Weighted Decay Centroid
  let targetVector = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // safe fallback
  let recentVectors: number[][] = [];
  
  if (sessionHistoryTrackIds.length > 0) {
    const last10Ids = sessionHistoryTrackIds.slice(-10);
    // Maintain strict order
    const placeholders = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const vecRes = await db.query(`
      SELECT t.id, tf.acoustic_vector, tf.mfcc_vector
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id 
      WHERE t.id IN (${placeholders})
    `, last10Ids);

    let recentMfccVectors: number[][] = [];

    // Map rows back to the ordered last10 array
    for (const id of last10Ids) {
      const row = vecRes.rows.find((r: any) => r.id === id) as any;
      if (row && row.acoustic_vector) {
        recentVectors.push(JSON.parse(row.acoustic_vector as string));
        if (row.mfcc_vector) {
          recentMfccVectors.push(JSON.parse(row.mfcc_vector as string));
        }
      }
    }

    if (recentVectors.length > 0) {
      // 9.1: The Weighted Decay Centroid (lambda = 0.8)
      const lambda = 0.8;
      targetVector = [0,0,0,0,0,0,0];
      let weightSum = 0;
      
      // Iterate from oldest to newest in the recent active window
      for (let i = 0; i < recentVectors.length; i++) {
        const weight = Math.pow(lambda, recentVectors.length - 1 - i);
        weightSum += weight;
        for (let j = 0; j < 7; j++) {
           targetVector[j] += recentVectors[i][j] * weight;
        }
      }
      
      for (let j = 0; j < 7; j++) {
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

  const vectorStr = `[${targetVector.join(',')}]`;

  // Compute MFCC timbre centroid (weighted decay, same lambda) for the last-10 window
  let mfccVectorStr: string | null = null;
  if (sessionHistoryTrackIds.length > 0) {
    const last10Ids = sessionHistoryTrackIds.slice(-10);
    const placeholders2 = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const mfccRes = await db.query(`
      SELECT t.id, tf.mfcc_vector
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id
      WHERE t.id IN (${placeholders2}) AND tf.mfcc_vector IS NOT NULL
    `, last10Ids);
    if (mfccRes.rows.length > 0) {
      const lambda = 0.8;
      const mfccTarget = new Array(13).fill(0);
      let mfccWeightSum = 0;
      const orderedMfcc: number[][] = [];
      for (const id of last10Ids) {
        const row = mfccRes.rows.find((r: any) => r.id === id) as any;
        if (row) orderedMfcc.push(JSON.parse(row.mfcc_vector));
      }
      for (let i = 0; i < orderedMfcc.length; i++) {
        const weight = Math.pow(lambda, orderedMfcc.length - 1 - i);
        mfccWeightSum += weight;
        for (let j = 0; j < 13; j++) mfccTarget[j] += orderedMfcc[i][j] * weight;
      }
      mfccVectorStr = `[${mfccTarget.map(v => v / mfccWeightSum).join(',')}]`;
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
    const lastTrackRes = await db.query('SELECT genre FROM tracks WHERE id = $1', [lastTrackId]);
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
    if (mfccVectorStr) {
      const renumberedHistory = historyClause
        ? `AND ${historyClause.replace(/^WHERE /, '').replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`)}`
        : '';
      res = await db.query(`
        SELECT t.*, (tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        WHERE tf.mfcc_vector IS NOT NULL
        ${renumberedHistory}
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 3}
      `, [vectorStr, mfccVectorStr, ...penaltyIds, overFetchLimit]);
    } else {
      res = await db.query(`
        SELECT t.*, tf.acoustic_vector <-> $1 AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        ${historyClause}
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 2}
      `, [vectorStr, ...penaltyIds, overFetchLimit]);
    }

    if (res.rows.length > 0) {
      // Step 4.2: Apply Hop Cost
      const scored = res.rows.map((row: any) => {
        const hopCost = genreMatrixService.getHopCost(currentGenre, row.genre || '');
        const finalScore = row.distance + (hopCost * genreWeight);
        return { ...row, hopCost, originalDistance: row.distance, finalScore };
      });

      // Filter and sort by the dynamically weighted score
      scored.sort((a, b) => a.finalScore - b.finalScore);
      
      // Ensure we have candidates within an acceptable boundary
      // We become less strict on absolute bounds as attempts increase
      const acceptable = scored.filter(c => c.finalScore < (constraints.distanceThreshold * (1 + attempt)));
      const pool = acceptable.length > 0 ? acceptable : scored; // fallback to best available if none acceptable

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
      const randomFallback = await db.query('SELECT * FROM tracks ORDER BY RANDOM() LIMIT 1');
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
