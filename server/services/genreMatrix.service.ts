import { 
  getAllTracks, 
  getMacroMatrix, 
  updateMacroMatrix, 
  getSubGenreMappings, 
  upsertSubGenreMapping,
  getMacroGenreFromKNN,
  setSystemSetting,
  clearSubGenreMappings
 } from '../database';
import { categorizeSubGenres, MACRO_GENRES } from './llm.service';

export class GenreMatrixService {
  private macroMatrix: Record<string, Record<string, number>> | null = null;
  private subGenreMap: Record<string, string> | null = null;
  private isGenerating = false;

  async init() {
    this.subGenreMap = await getSubGenreMappings();
    this.macroMatrix = await getMacroMatrix();
    
    // If matrix is empty OR doesn't contain all new genres, re-seed it
    const existingGenres = this.macroMatrix ? Object.keys(this.macroMatrix) : [];
    const isMissingGenres = MACRO_GENRES.some(g => !existingGenres.includes(g));

    if (!this.macroMatrix || isMissingGenres) {
      console.log('[GenreMatrix] Initializing/Expanding macro-genre matrix seed...');
      const seed = this.generateExpandedSeed();
      await updateMacroMatrix(seed);
      this.macroMatrix = seed;
    }

    // Sanitize progress on startup (unlock UI if server was killed during run)
    const { initDB } = await import('../database');
    const db = await initDB();
    const progRes = await db.query("SELECT value FROM system_settings WHERE key = 'genreMatrixProgress'");
    const progress = progRes.rows[0]?.value ? JSON.parse(progRes.rows[0].value) : null;
    
    if (progress && progress !== 'Complete' && !progress.startsWith('Error') && !progress.startsWith('Interrupted')) {
      console.log('[GenreMatrix] Detected stale categorization job. Marking as Interrupted.');
      await setSystemSetting('genreMatrixProgress', 'Interrupted (Server restarted)');
    }
  }

  private generateExpandedSeed(): Record<string, Record<string, number>> {
    const seed: Record<string, Record<string, number>> = {};
    
    // Families for logical hop-cost defaulting
    const families = {
      electronic: ['electronic', 'edm/dance', 'house', 'techno', 'drum & bass', 'dubstep', 'trance', 'uk garage', 'breakbeat', 'electro', 'hardstyle/hardcore', 'downtempo'],
      soulful: ['r&b', 'soul/funk', 'gospel/religious', 'jazz', 'blues'],
      rock: ['rock', 'indie/alternative', 'metal', 'punk', 'experimental/avant-garde'],
      global: ['latin', 'afrobeats/african', 'k-pop/j-pop', 'world/traditional', 'reggae/dancehall'],
      root: ['folk/acoustic', 'country'],
      pop: ['pop'],
      utility: ['classical', 'soundtrack/score', 'spoken word/audio', 'children\'s music', 'holiday/seasonal', 'comedy/novelty', 'easy listening/lounge']
    };

    const findFamily = (g: string) => Object.entries(families).find(([_, list]) => list.includes(g))?.[0] || 'other';

    for (const row of MACRO_GENRES) {
      seed[row] = {};
      const familyA = findFamily(row);
      
      for (const col of MACRO_GENRES) {
        if (row === col) continue;
        const familyB = findFamily(col);
        
        let cost = 0.5; // Default "Unknown" distance

        if (familyA === familyB) {
          cost = 0.15; // Same family (e.g. House -> Techno)
        } else if (
           (familyA === 'electronic' && familyB === 'pop') || (familyA === 'pop' && familyB === 'electronic') ||
           (familyA === 'soulful' && familyB === 'pop') || (familyA === 'pop' && familyB === 'soulful') ||
           (familyA === 'rock' && familyB === 'pop') || (familyA === 'pop' && familyB === 'rock')
        ) {
          cost = 0.3; // High-affinity neighbors
        } else if (
           (familyA === 'rock' && familyB === 'metal') || (familyA === 'metal' && familyB === 'rock') ||
           (familyA === 'jazz' && familyB === 'classical') || (familyA === 'classical' && familyB === 'jazz')
        ) {
          cost = 0.25; // Close cousins across families
        } else if (
           (familyA === 'utility' || familyB === 'utility')
        ) {
          cost = 0.7; // Utility genres are generally distant from main flows
        }

        seed[row][col] = cost;
      }
    }
    return seed;
  }

  private sanitizeGenre(g: string): string {
    return g.toLowerCase().trim().replace(/[^\w\s-]/g, '');
  }

  getHopCost(genreA: string, genreB: string): number {
    const a = this.sanitizeGenre(genreA || '');
    const b = this.sanitizeGenre(genreB || '');
    
    if (a === b) return 0.0;
    
    const macroA = this.subGenreMap?.[a] || 'unknown';
    const macroB = this.subGenreMap?.[b] || 'unknown';
    
    if (macroA === 'unknown' || macroB === 'unknown') {
      return 0.7; // high penalty for missing/unknown genres
    }
    if (macroA === macroB) {
      return 0.0;
    }

    const cost = this.macroMatrix?.[macroA]?.[macroB] ?? this.macroMatrix?.[macroB]?.[macroA];
    if (cost !== undefined) return cost;

    // Handle the "all" default in the seed for spoken word/other
    if (this.macroMatrix?.[macroA]?.['all'] !== undefined) return this.macroMatrix[macroA]['all'];
    if (this.macroMatrix?.[macroB]?.['all'] !== undefined) return this.macroMatrix[macroB]['all'];

    return 0.7; // default fallback
  }

  async runDiffAndGenerate() {
    if (this.isGenerating) return;
    this.isGenerating = true;
    try {
      const tracks = await getAllTracks();
      const mappings = await getSubGenreMappings();
      this.subGenreMap = mappings;

      const itemsToCategorize: { subGenre?: string, artist?: string, originalTag: string }[] = [];
      const newMappings: Record<string, string> = {};

      for (const track of tracks) {
        const subGenre = this.sanitizeGenre(track.genre || '');
        if (!subGenre) {
          // Tier 1 & 2: Missing Genre Fallback
          // Try artist deduction first
          if (track.artist && !mappings[this.sanitizeGenre(track.artist)]) {
            itemsToCategorize.push({ artist: track.artist, originalTag: track.artist });
          } else if (!track.artist) {
            // Tier 2: KNN
            const res = await import('../database');
            const tfRes = await (await res.initDB()).query('SELECT acoustic_vector FROM track_features WHERE track_id = $1', [track.id]);
            if (tfRes.rows.length > 0) {
              const vector = JSON.parse(tfRes.rows[0].acoustic_vector);
              const knnMacro = await getMacroGenreFromKNN(vector);
              if (knnMacro) {
                // We'll use a special "path" key for KNN results if needed, or just skip LLM
                // For now, let's just use the track ID as a placeholder to store it
                newMappings[`knn_${track.id}`] = knnMacro;
              }
            }
          }
          continue;
        }

        if (!mappings[subGenre]) {
          itemsToCategorize.push({ subGenre, originalTag: subGenre });
        }
      }

      if (itemsToCategorize.length === 0) {
        await setSystemSetting('genreMatrixLastRun', Date.now());
        await setSystemSetting('genreMatrixLastResult', 'All genres already mapped.');
        return;
      }

      // Batch LLM calls (50 per prompt)
      const BATCH_SIZE = 50;
      const totalBatches = Math.ceil(itemsToCategorize.length / BATCH_SIZE);
      for (let i = 0; i < itemsToCategorize.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const progressMsg = `Categorizing batch ${batchNum}/${totalBatches}...`;
        await setSystemSetting('genreMatrixProgress', progressMsg);
        
        const batch = itemsToCategorize.slice(i, i + BATCH_SIZE);
        console.log(`[GenreMatrix] ${progressMsg}`);
        
        const results = await categorizeSubGenres(batch);
        for (const [key, macro] of Object.entries(results)) {
           if (MACRO_GENRES.includes(macro)) {
             await upsertSubGenreMapping(key, macro);
             newMappings[key] = macro;
           }
        }
      }

      // Final refresh
      this.subGenreMap = await getSubGenreMappings();
      await setSystemSetting('genreMatrixLastRun', Date.now());
      await setSystemSetting('genreMatrixLastResult', `Categorized ${Object.keys(newMappings).length} new mappings.`);
      await setSystemSetting('genreMatrixProgress', 'Complete');
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
    console.log('[GenreMatrix] FORCED REMAP: Clearing all existing mappings and re-seeding matrix for 39 genres...');
    
    // 1. Clear DB
    await clearSubGenreMappings();
    
    // 2. Clear local cache and re-init (re-seeds matrix if MACRO_GENRES changed)
    this.subGenreMap = {};
    this.macroMatrix = null;
    await this.init();
    
    // 3. Trigger full categorization
    // Non-blocking call to runDiffAndGenerate()
    this.runDiffAndGenerate();
  }
}

export const genreMatrixService = new GenreMatrixService();
