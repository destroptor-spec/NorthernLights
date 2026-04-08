// server/services/genreMatrix.service.ts
import { 
  getAllTracks, 
  getSubGenreMappings, 
  upsertSubGenreMapping,
  clearSubGenreMappings,
  getMacroGenreFromKNN,
  setSystemSetting,
  initDB
} from '../database';
import { categorizeSubGenres } from './llm.service';
import { queryWithRetry } from '../utils/db';

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

  // Calculate Hop Cost using Lowest Common Ancestor string splitting.
  // Paths are stored in dot-notation like `Electronic.House.Deep House`
  getHopCost(genreA: string, genreB: string): number {
    const a = this.sanitize(genreA || '');
    const b = this.sanitize(genreB || '');
    
    if (a === b) return 0.0;
    
    const pathA = this.subGenreMap?.[a];
    const pathB = this.subGenreMap?.[b];
    
    // If we have an exact match in subGenreMap
    if (pathA && pathA === pathB) {
      return 0.0;
    }

    if (!pathA || !pathB) {
      return 0.7; // High penalty for unknown genres
    }

    const partsA = pathA.split('.');
    const partsB = pathB.split('.');
    
    const lenA = Math.max(1, partsA.length);
    const lenB = Math.max(1, partsB.length);
    let lcaDepth = 0;

    const minDepth = Math.min(lenA, lenB);
    for (let i = 0; i < minDepth; i++) {
        if (partsA[i].toLowerCase() === partsB[i].toLowerCase()) {
            lcaDepth++;
        } else {
            break;
        }
    }

    // Distance = hops up from A to LCA + hops down from LCA to B
    const hops = (lenA - lcaDepth) + (lenB - lcaDepth);
    
    // Each hop adds 0.15 to the cost. Cap at 0.8 to allow for serendipity.
    const cost = Math.min(0.8, hops * 0.15);
    
    return cost;
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

      for (const track of tracks) {
        const subGenre = this.sanitize(track.genre || '');
        if (!subGenre) {
          // Tier 1 & 2: Missing Genre Fallback
          if (track.artist && !mappings[this.sanitize(track.artist)] && !newMappings[this.sanitize(track.artist)]) {
            itemsToCategorize.push({ artist: track.artist, originalTag: this.sanitize(track.artist) });
          } else if (!track.artist) {
            // Tier 2: KNN
            const tfRes = await queryWithRetry('SELECT acoustic_vector FROM track_features WHERE track_id = $1', [track.id]);
            if (tfRes.rows.length > 0) {
              const vector = JSON.parse(tfRes.rows[0].acoustic_vector);
              const knnMacro = await getMacroGenreFromKNN(vector);
              if (knnMacro) {
                  // Pass
              }
            }
          }
          continue;
        }

        if (!mappings[subGenre] && !newMappings[subGenre]) {
            // STEP 1: Direct SQL Match against MBDB Taxonomy
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
                // STEP 1.5: Fuzzy SQL Match (similarity threshold 0.8)
                const fuzzyRes = await queryWithRetry(
                    `SELECT path FROM (
                        SELECT path, similarity(LOWER(genre_name), $1) as sim FROM genre_tree_paths
                        UNION ALL
                        SELECT gtp.path, similarity(LOWER(ga.name), $1) as sim 
                        FROM genre_tree_paths gtp 
                        JOIN genre_alias ga ON gtp.genre_id = ga.genre
                    ) sub WHERE sim > 0.8 ORDER BY sim DESC LIMIT 1`,
                    [subGenre]
                );
                
                if (fuzzyRes.rows.length > 0) {
                    const path = fuzzyRes.rows[0].path;
                    console.log(`[GenreMatrix] Fuzzy SQL Match: "${subGenre}" -> "${path}"`);
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

      for (const key of Object.keys(newMappings)) {
         if (newMappings[key] === 'pending') delete newMappings[key];
      }

      if (itemsToCategorize.length === 0) {
        await setSystemSetting('genreMatrixLastRun', Date.now());
        await setSystemSetting('genreMatrixLastResult', 'All genres already mapped natively.');
        await setSystemSetting('genreMatrixProgress', 'Complete');
        return;
      }

      // STEP 2: LLM Batch Processing
      const BATCH_SIZE = 20;
      let startIdx = 0;
      
      if (resume) {
          const cpRes = await queryWithRetry("SELECT value FROM system_settings WHERE key = 'genreMatrixCheckpoint'");
          const value = cpRes.rows[0]?.value;
          startIdx = value ? parseInt(JSON.parse(value)) : 0;
          if (isNaN(startIdx) || startIdx >= itemsToCategorize.length) startIdx = 0;
          if (startIdx > 0) console.log(`[GenreMatrix] Resuming from checkpoint index ${startIdx}`);
      }

      const totalBatches = Math.ceil(itemsToCategorize.length / BATCH_SIZE);
      let matchCount = Object.keys(newMappings).length; 
      let failureCount = 0;

      for (let i = startIdx; i < itemsToCategorize.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const progressMsg = `Categorizing batch ${batchNum}/${totalBatches} with LLM...`;
        await setSystemSetting('genreMatrixProgress', progressMsg);
        await setSystemSetting('genreMatrixCheckpoint', JSON.stringify(i)); 
        
        const batch = itemsToCategorize.slice(i, i + BATCH_SIZE);
        console.log(`[GenreMatrix] ${progressMsg}`);
        
        const results = await categorizeSubGenres(batch.map(b => ({ subGenre: b.subGenre, artist: b.artist })));
        
        for (const input of batch) {
           const generatedGenres = results[input.originalTag];
           let found = false;

           if (generatedGenres && Array.isArray(generatedGenres)) {
               for (const g of generatedGenres) {
                   const cleanG = this.sanitize(g);
                   const res = await queryWithRetry(
                        `SELECT path FROM genre_tree_paths 
                         WHERE LOWER(genre_name) = $1 OR genre_id IN (
                            SELECT genre FROM genre_alias WHERE LOWER(name) = $1
                         ) LIMIT 1`, 
                        [cleanG]
                   );
                   if (res.rows.length > 0) {
                       const path = res.rows[0].path;
                       await upsertSubGenreMapping(input.originalTag, path);
                       newMappings[input.originalTag] = path;
                       matchCount++;
                       found = true;
                       break; 
                   }
               }
           }

           if (!found) {
               console.warn(`[GenreMatrix] LLM Categorization Failed for "${input.originalTag}". Output: ${JSON.stringify(generatedGenres)}`);
               failureCount++;
           }
        }
      }

      // Final refresh
      this.subGenreMap = await getSubGenreMappings();
      await setSystemSetting('genreMatrixLastRun', Date.now());
      await setSystemSetting('genreMatrixLastResult', `Categorized ${matchCount} total (${matchCount - Object.keys(newMappings).length + failureCount} LLM requests. Failures: ${failureCount}).`);
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
