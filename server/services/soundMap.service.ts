/**
 * The library's sound map, the Rays page's night sky: every analysed track's
 * 1280-number sound embedding (Discogs-EffNet, the mean of its three windows)
 * flattened onto its two principal components.
 *
 * The components are fitted on a random sample (power iteration, yielding to
 * the event loop between passes so requests keep flowing), then Postgres
 * projects every track at once. Built when first asked for, and rebuilt in
 * the background when the library has drifted from the map: tracks analysed
 * since, or removed. No provider calls; the build only reads the library.
 */
import { getEmbeddingSample, getSoundMapLabels, getSoundMapPoints, getSoundMapState, replaceSoundMap, type SoundMapLabel } from '../database';

const SAMPLE = 4000;
const ITERATIONS = 60;
/** Points drawn as the sky behind a track. */
const BACKDROP_POINTS = 5000;
/** Rebuild once this share of analysed tracks is missing from, or extra on, the map. */
const DRIFT = 0.02;
/** …but not more often than this. */
const MIN_REBUILD_MS = 15 * 60 * 1000;

const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * The first `k` principal components of `rows` (unit vectors), by power
 * iteration with deflation. Deterministic for a given `seed`.
 */
export async function fitPrincipalComponents(rows: number[][], k = 2, iterations = ITERATIONS, seed = 1): Promise<number[][]> {
  const n = rows.length;
  if (n < 3) return [];
  const d = rows[0].length;
  const mean = new Float64Array(d);
  for (const row of rows) for (let j = 0; j < d; j++) mean[j] += row[j] / n;
  const X = rows.map(row => Float64Array.from(row, (v, j) => v - mean[j]));
  let state = seed >>> 0 || 1;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 - 0.5; };

  const components: number[][] = [];
  const xw = new Float64Array(n);
  for (let c = 0; c < k; c++) {
    let w = Float64Array.from({ length: d }, random);
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) {
        const row = X[i]; let s = 0;
        for (let j = 0; j < d; j++) s += row[j] * w[j];
        xw[i] = s;
      }
      const next = new Float64Array(d);
      for (let i = 0; i < n; i++) {
        const row = X[i], s = xw[i];
        for (let j = 0; j < d; j++) next[j] += row[j] * s;
      }
      for (const prev of components) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += next[j] * prev[j];
        for (let j = 0; j < d; j++) next[j] -= dot * prev[j];
      }
      let norm = 0;
      for (let j = 0; j < d; j++) norm += next[j] * next[j];
      norm = Math.sqrt(norm);
      if (!norm) break;
      for (let j = 0; j < d; j++) next[j] /= norm;
      w = next;
      await yieldToLoop();
    }
    components.push(Array.from(w));
  }
  return components;
}

export interface SoundMapView {
  status: 'ready' | 'building' | 'empty';
  builtAt: string | null;
  trackCount: number;
  points: Array<[number, number]>;
  labels: SoundMapLabel[];
}

let building: Promise<void> | null = null;
let lastBuildStarted = 0;
let view: SoundMapView | null = null;
let viewBuiltAt: string | null = null;

async function build() {
  const sample = await getEmbeddingSample(SAMPLE);
  const components = await fitPrincipalComponents(sample, 2);
  if (components.length < 2) return;
  const mapped = await replaceSoundMap(components[0], components[1]);
  console.log(`[Sound map] Built from ${sample.length} sampled embeddings; ${mapped} tracks on the map.`);
}

/** Starts a rebuild when the map is missing or has drifted; never waits for it. */
export async function ensureSoundMap(): Promise<'ready' | 'building' | 'empty'> {
  const state = await getSoundMapState();
  if (state.analysed === 0) return 'empty';
  const drift = Math.abs(state.analysed - state.mapped) / state.analysed;
  const due = state.mapped === 0 || (drift >= DRIFT && Date.now() - lastBuildStarted >= MIN_REBUILD_MS);
  if (due && !building) {
    lastBuildStarted = Date.now();
    building = build()
      .catch(error => console.warn('[Sound map] Build failed:', error instanceof Error ? error.message : error))
      .finally(() => { building = null; });
  }
  return state.mapped === 0 ? 'building' : 'ready';
}

/** The sky behind a Rays page: a stable sample of the map and where the genres sit. */
export async function getSoundMapView(): Promise<SoundMapView> {
  const status = await ensureSoundMap();
  if (status !== 'ready') return { status, builtAt: null, trackCount: 0, points: [], labels: [] };
  const state = await getSoundMapState();
  const builtAt = state.builtAt ? new Date(state.builtAt).toISOString() : null;
  if (view && viewBuiltAt === builtAt) return view;
  const [points, labels] = await Promise.all([
    getSoundMapPoints(BACKDROP_POINTS),
    getSoundMapLabels(Math.max(25, Math.round(state.mapped * 0.005))),
  ]);
  // Four decimals is far finer than a pixel on any screen, and halves the payload.
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  view = { status: 'ready', builtAt, trackCount: state.mapped, points: points.map(([x, y]) => [round(x), round(y)]), labels };
  viewBuiltAt = builtAt;
  return view;
}

/** Tests only. */
export function resetSoundMapState() {
  building = null; lastBuildStarted = 0; view = null; viewBuiltAt = null;
}
