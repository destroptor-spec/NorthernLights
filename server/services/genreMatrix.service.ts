// server/services/genreMatrix.service.ts
import { 
  getAllTracks, 
  getSubGenreMappings, 
  upsertSubGenreMapping,
  clearSubGenreMappings,
  getGenrePathFromKNN,
  setSystemSetting,
  initDB
} from '../database';
import { categorizeSubGenres } from './llm.service';
import { queryWithRetry } from '../utils/db';

// Standalone vocabulary fetch — used by Genre Matrix and LLM prompt generation
// Library-scoped: if the library has < 300 genres, return only genres that actually exist in the library.
// If the library has ≥ 300 genres, return top 300 from MBDB hierarchy.
export async function getGenreVocabulary(): Promise<string[]> {
  // Count genres in the user's library
  const countRes = await queryWithRetry('SELECT COUNT(*) as cnt FROM genres');
  const libraryCount = parseInt(countRes.rows[0]?.cnt || '0', 10);

  if (libraryCount < 300) {
    // Small library: return all library genres, prioritized by MBDB mapping availability
    const res = await queryWithRetry(`
      SELECT g.name
      FROM genres g
      LEFT JOIN genre_tree_paths gtp ON LOWER(gtp.genre_name) = LOWER(g.name)
      ORDER BY 
        CASE WHEN gtp.genre_name IS NOT NULL THEN 0 ELSE 10 END ASC,
        g.name ASC
    `);
    return res.rows.map(r => r.name);
  }

  // Large library: return top 300 from MBDB hierarchy (prioritize tree-path genres)
  const res = await queryWithRetry(`
    SELECT name FROM (
      SELECT DISTINCT ON (name) name, level
      FROM (
        SELECT genre_name as name, level FROM genre_tree_paths
        UNION ALL
        SELECT name, 10 as level FROM genre_alias
        UNION ALL
        SELECT name, 20 as level FROM genre
      ) sub
      ORDER BY name ASC, level ASC
    ) ranked
    ORDER BY level ASC, name ASC
    LIMIT 300
  `);
  return res.rows.map(r => r.name);
}

export class GenreMatrixService {
  private subGenreMap: Record<string, string> | null = null;
  private isGenerating = false;

  async init() {
    this.subGenreMap = await getSubGenreMappings();

    // Sanitize progress on startup
    const progRes = await queryWithRetry("SELECT value FROM system_settings WHERE key = 'genreMatrixProgress'");
    const progress = progRes.rows[0]?.value ? JSON.parse(progRes.rows[0].value) : null;
    
    if (progress && progress !== 'Complete' && !progress.startsWith('Error') && !progress.startsWith('Interrupted')) {
      console.log('[GenreMatrix] Detected stale categorization job. Marking as Interrupted.');
      await setSystemSetting('genreMatrixProgress', 'Interrupted (Server restarted)');
    }
  }

  private sanitize(s: string): string {
    return s.toLowerCase().trim().replace(/[^\w\s-]/g, '');
  }

  private async getGenreVocabulary(): Promise<string[]> {
    return getGenreVocabulary();
  }

  // Expose the full hierarchical path for a genre (used by veto logic)
  // e.g., "trance" → "electronic.dance.trance.vocal trance"
  getGenrePath(genre: string): string | undefined {
    return this.subGenreMap?.[this.sanitize(genre)];
  }

  // Calculate Hop Cost using Lowest Common Ancestor string splitting.
  // Paths are stored in dot-notation like `Electronic.House.Deep House`
  getHopCost(genreA: string, genreB: string): number {
    const a = this.sanitize(genreA || '');
    const b = this.sanitize(genreB || '');
    
    if (a === b) return 0.0;
    
    const pathA = this.subGenreMap?.[a];
    const pathB = this.subGenreMap?.[b];
    
    if (pathA && pathA === pathB) return 0.0;
    if (!pathA || !pathB) return 2.0; // Unknown genre = alien tier

    const partsA = pathA.split('.');
    const partsB = pathB.split('.');
    
    // Find Lowest Common Ancestor depth
    let commonLevels = 0;
    for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
      if (partsA[i].toLowerCase() === partsB[i].toLowerCase()) {
        commonLevels++;
      } else {
        break;
      }
    }

    // Tiered penalties based on tree distance
    if (commonLevels >= 3) return 0.05; // Deep sibling
    if (commonLevels === 2) return 0.20; // Tier 2 cousin
    if (commonLevels === 1) return 0.50; // Share only root
    return 2.0;                          // Alien hop
  }

  async runDiffAndGenerate(resume = true) {
    if (this.isGenerating) return;
    this.isGenerating = true;
    try {
      const db = await initDB();
      const tracks = await getAllTracks();
      const mappings = await getSubGenreMappings();
      this.subGenreMap = mappings;

      const itemsToCategorize: { subGenre?: string, artist?: string, originalTag: string }[] = [];
      const newMappings: Record<string, string> = {};

      // --- TIER 1: DIRECT SQL MATCH ---
      console.log(`[GenreMatrix] Tier 1: Scanning metadata for direct MBDB matches...`);
      for (const track of tracks) {
        const subGenre = this.sanitize(track.genre || '');
        if (!subGenre) continue; // Will be handled by Tier 3

        if (!mappings[subGenre] && !newMappings[subGenre]) {
            const res = await queryWithRetry(
                `(SELECT path FROM genre_tree_paths WHERE LOWER(genre_name) = $1 LIMIT 1)
                 UNION ALL
                 (SELECT gtp.path FROM genre_tree_paths gtp 
                  JOIN genre_alias ga ON gtp.genre_id = ga.genre 
                  WHERE LOWER(ga.name) = $1 LIMIT 1)
                 LIMIT 1`, 
                [subGenre]
            );
            if (res.rows.length > 0) {
                const path = res.rows[0].path;
                await upsertSubGenreMapping(subGenre, path);
                newMappings[subGenre] = path;
                mappings[subGenre] = path; 
            } else {
                // Tier 1.5: Fuzzy SQL (GIN indexed via % operator)
                const fuzzyRes = await queryWithRetry(
                    `SELECT path FROM (
                        SELECT path, similarity(LOWER(genre_name), $1) as sim 
                        FROM genre_tree_paths
                        WHERE LOWER(genre_name) % $1
                        UNION ALL
                        SELECT gtp.path, similarity(LOWER(ga.name), $1) as sim 
                        FROM genre_tree_paths gtp 
                        JOIN genre_alias ga ON gtp.genre_id = ga.genre
                        WHERE LOWER(ga.name) % $1
                    ) sub WHERE sim > 0.8 ORDER BY sim DESC LIMIT 1`,
                    [subGenre]
                );
                
                if (fuzzyRes.rows.length > 0) {
                    const path = fuzzyRes.rows[0].path;
                    await upsertSubGenreMapping(subGenre, path);
                    newMappings[subGenre] = path;
                    mappings[subGenre] = path;
                } else {
                    itemsToCategorize.push({ subGenre, originalTag: subGenre });
                    newMappings[subGenre] = 'pending';
                }
            }
        }
      }

      // Cleanup pending for Tier 2 extraction
      for (const key of Object.keys(newMappings)) {
         if (newMappings[key] === 'pending') delete newMappings[key];
      }

      let matchCount = Object.keys(newMappings).length;
      let failureCount = 0;

      // --- TIER 2: BATCH LLM DISAMBIGUATION ---
      if (itemsToCategorize.length > 0) {
        console.log(`[GenreMatrix] Tier 2: Fetching vocabulary and federating ${itemsToCategorize.length} unknown tags to LLM...`);
        const vocabulary = await this.getGenreVocabulary();
        
        const BATCH_SIZE = 20;
        let startIdx = 0;
        
        if (resume) {
            const cpRes = await queryWithRetry("SELECT value FROM system_settings WHERE key = 'genreMatrixCheckpoint'");
            const value = cpRes.rows[0]?.value;
            startIdx = value ? parseInt(JSON.parse(value)) : 0;
            if (isNaN(startIdx) || startIdx >= itemsToCategorize.length) startIdx = 0;
        }

        const totalBatches = Math.ceil(itemsToCategorize.length / BATCH_SIZE);
        for (let i = startIdx; i < itemsToCategorize.length; i += BATCH_SIZE) {
          const batchNum = Math.floor(i / BATCH_SIZE) + 1;
          await setSystemSetting('genreMatrixProgress', `Tier 2: LLM Batch ${batchNum}/${totalBatches}...`);
          await setSystemSetting('genreMatrixCheckpoint', JSON.stringify(i)); 
          
          const batch = itemsToCategorize.slice(i, i + BATCH_SIZE);
          const results = await categorizeSubGenres(batch.map(b => ({ subGenre: b.subGenre, artist: b.artist })), vocabulary);
          
          for (const input of batch) {
             const generatedGenres = results[input.originalTag];
             let found = false;
             if (generatedGenres && Array.isArray(generatedGenres)) {
                 for (const g of generatedGenres) {
                     const cleanG = this.sanitize(g);
                     // Expanded Tier 2 Match: Check tree, orphans, aliases, and fuzzy fallback
                     // Fuzzy branches use % operator (GIN index eligible) to avoid full table scans
                     const res = await queryWithRetry(
                          `SELECT path FROM (
                             -- Direct Tree Path
                             SELECT path, 1.0 as sim FROM genre_tree_paths WHERE LOWER(genre_name) = $1
                             UNION ALL
                             -- Alias for Tree Path
                             SELECT gtp.path, 1.0 as sim FROM genre_tree_paths gtp 
                             JOIN genre_alias ga ON gtp.genre_id = ga.genre 
                             WHERE LOWER(ga.name) = $1
                             UNION ALL
                              -- Standalone Genre with parent fallback
                              (
                              SELECT COALESCE(gtp2.path, parent.name || '.' || g.name, g.name) as path, 1.0 as sim
                              FROM genre g
                              LEFT JOIN l_genre_genre lgg ON lgg.entity0 = g.id AND lgg.link = 944810
                              LEFT JOIN genre parent ON parent.id = lgg.entity1
                              LEFT JOIN genre_tree_paths gtp2 ON gtp2.genre_id = g.id
                              WHERE LOWER(g.name) = $1
                              LIMIT 1
                              )
                              UNION ALL
                              -- Standalone Alias with parent fallback
                              (
                              SELECT COALESCE(gtp3.path, parent2.name || '.' || g2.name, g2.name) as path, 1.0 as sim
                              FROM genre g2
                              JOIN genre_alias ga2 ON g2.id = ga2.genre
                              LEFT JOIN l_genre_genre lgg2 ON lgg2.entity0 = g2.id AND lgg2.link = 944810
                              LEFT JOIN genre parent2 ON parent2.id = lgg2.entity1
                              LEFT JOIN genre_tree_paths gtp3 ON gtp3.genre_id = g2.id
                              WHERE LOWER(ga2.name) = $1
                              LIMIT 1
                              )
                             UNION ALL
                             -- Fuzzy Match on Tree Paths (GIN indexed via % operator)
                             SELECT path, similarity(LOWER(genre_name), $1) as sim 
                             FROM genre_tree_paths 
                             WHERE LOWER(genre_name) % $1
                             UNION ALL
                             -- Fuzzy Match on Aliases (GIN indexed via % operator)
                             SELECT gtp.path, similarity(LOWER(ga.name), $1) as sim 
                             FROM genre_tree_paths gtp 
                             JOIN genre_alias ga ON gtp.genre_id = ga.genre
                             WHERE LOWER(ga.name) % $1
                          ) sub WHERE sim >= 0.7 ORDER BY sim DESC LIMIT 1`, 
                          [cleanG]
                     );
                     if (res.rows.length > 0) {
                         const path = res.rows[0].path;
                         await upsertSubGenreMapping(input.originalTag, path);
                         mappings[input.originalTag] = path;
                         matchCount++;
                         found = true;
                         break; 
                     }
                 }
             }
             if (!found) failureCount++;
          }
        }
      }

      // --- TIER 3: KNN TIMBRE FALLBACK ---
      console.log(`[GenreMatrix] Tier 3: Running KNN Timbre Recovery (21D) for remaining tracks...`);
      let knnCount = 0;

      // Collect tracks needing KNN and batch-fetch features in one query
      const tracksNeedingKnn: { trackId: string, effectiveKey: string }[] = [];
      for (const track of tracks) {
          const subGenre = this.sanitize(track.genre || '');
          const artistKey = this.sanitize(track.artist || 'unknown-artist');
          const effectiveKey = subGenre || artistKey;
          if (!mappings[effectiveKey]) {
              tracksNeedingKnn.push({ trackId: track.id, effectiveKey });
          }
      }

      if (tracksNeedingKnn.length > 0) {
          const trackIds = tracksNeedingKnn.map(t => t.trackId);
          const placeholders = trackIds.map((_, i) => `$${i + 1}`).join(',');
          const featuresRes = await queryWithRetry(`
            SELECT tf.track_id, tf.acoustic_vector_8d, tf.mfcc_vector
            FROM track_features tf
            WHERE tf.track_id IN (${placeholders})
              AND tf.acoustic_vector_8d IS NOT NULL
          `, trackIds);

          const featureMap = new Map<string, { vec8: number[], vecMfcc?: number[] }>();
          for (const row of featuresRes.rows) {
              const vec8 = JSON.parse(row.acoustic_vector_8d);
              if (vec8.some((v: number) => !isFinite(v))) continue;
              const rawMfcc = row.mfcc_vector ? JSON.parse(row.mfcc_vector) : undefined;
              const vecMfcc = rawMfcc && rawMfcc.some((v: number) => !isFinite(v)) ? undefined : rawMfcc;
              featureMap.set(row.track_id, { vec8, vecMfcc });
          }

          for (const { trackId, effectiveKey } of tracksNeedingKnn) {
              if (mappings[effectiveKey]) continue; // May have been set by earlier iteration
              const features = featureMap.get(trackId);
              if (!features) continue;
              const knnPath = await getGenrePathFromKNN(features.vec8, features.vecMfcc);
              if (knnPath) {
                  await upsertSubGenreMapping(effectiveKey, knnPath);
                  mappings[effectiveKey] = knnPath;
                  matchCount++;
                  knnCount++;
              }
          }
      }
      if (knnCount > 0) console.log(`[GenreMatrix] Tier 3 complete: ${knnCount} tracks recovered via KNN.`);

      // Final refresh
      this.subGenreMap = await getSubGenreMappings();
      await setSystemSetting('genreMatrixLastRun', Date.now());
      await setSystemSetting('genreMatrixLastResult', `Categorized ${matchCount} total (${itemsToCategorize.length} LLM tags processed. Failures: ${failureCount}. KNN Recovery: ${knnCount}).`);
      await setSystemSetting('genreMatrixProgress', 'Complete');
      await setSystemSetting('genreMatrixCheckpoint', '0'); 
    } catch (e: any) {
      console.error('Failed to run genre matrix categorization:', e);
      await setSystemSetting('genreMatrixLastRun', Date.now());
      await setSystemSetting('genreMatrixLastResult', `Error: ${e.message}`);
    } finally {
      this.isGenerating = false;
    }
  }

  async remapAll() {
    if (this.isGenerating) return;
    console.log('[GenreMatrix] FORCED REMAP: Clearing all existing mappings and re-running pipeline...');
    await clearSubGenreMappings();
    this.subGenreMap = {};
    await setSystemSetting('genreMatrixCheckpoint', '0');
    this.runDiffAndGenerate(false);
  }
}

export const genreMatrixService = new GenreMatrixService();
