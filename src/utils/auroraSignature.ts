/**
 * The aurora signature behind the Rays page's hero: a night sky whose aurora
 * is drawn only from the track's numbers. Colour follows brightness (and the
 * genre mix tints the veil), the number of streams danceability, the height
 * of the curtains energy, the density of the rays percussion, their softness
 * acoustic character, and the drift speed the tempo. Ranks in the library
 * (0–1) drive the scales, so they use the whole range on any library.
 *
 * makeAurora builds the sky and the curtains once per size; the returned
 * painter only composites them, so animating it is cheap.
 */
import { AURORA_FALLBACK_PALETTE } from './coverGradient';

export interface AuroraSound {
  id: string;
  bpm: number | null;
  mix: Array<{ genre: string; share: number }>;
  values: { danceability: number; acousticness: number };
  percentiles: { energy: number; brightness: number; danceability: number; percussiveness: number };
}

const hues: Record<string, number> = {
  Electronic: 152, Pop: 166, Jazz: 178, Classical: 188, Blues: 193, 'Folk, World, & Country': 131,
  Reggae: 137, Rock: 148, 'Hip Hop': 182, 'Funk / Soul': 145, Latin: 140, 'Stage & Screen': 173,
};

// Percentiles make the colour and stream scales usable across this library's
// uneven feature distributions. The renderer and its reading key share them.
const [green, teal, blue, rose] = AURORA_FALLBACK_PALETTE;
const palettes = [
  { until: 0.30, name: 'Emerald', fold: green, veil: '#a287ee' },
  { until: 0.55, name: 'Teal', fold: teal, veil: blue },
  { until: 0.80, name: 'Rose', fold: rose, veil: '#c89ae8' },
  { until: 0.95, name: 'Ruby', fold: '#e11d48', veil: rose },
  { until: 1, name: 'Red', fold: '#ff423f', veil: '#ed3977' },
];

export function signatureStyle(track: AuroraSound) {
  const palette = palettes.find(p => track.percentiles.brightness < p.until) ?? palettes[palettes.length - 1];
  const streams = Math.min(4, 1 + Math.floor(track.percentiles.danceability * 4));
  return { palette, streams };
}

function randomFor(id: string) {
  let seed = 2166136261;
  for (const ch of id) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseField(random: () => number) {
  const samples = Array.from({ length: 512 }, random);
  return (x: number) => {
    const i = Math.floor(x), fraction = x - i;
    const f = fraction * fraction * (3 - 2 * fraction);
    return samples[i % samples.length] * (1 - f) + samples[(i + 1) % samples.length] * f;
  };
}

function surface(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d')!;
}

function night(w: number, h: number, random: () => number, landscape: boolean) {
  const ctx = surface(w, h);
  const sky = ctx.createLinearGradient(0, 0, w * 0.13, h);
  sky.addColorStop(0, '#060c21');
  sky.addColorStop(0.55, '#101d37');
  sky.addColorStop(1, '#243848');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 360; i++) {
    const x = random() * w, y = random() * h;
    const magnitude = random() ** 5;
    const radius = (0.00065 + 0.0018 * magnitude) * Math.min(w, h);
    ctx.fillStyle = `rgba(221,232,255,${(0.23 + magnitude * 0.60) * (1 - y / h)})`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.35, radius), 0, 2 * Math.PI); ctx.fill();
  }

  // Two distant ridgelines give the eye a fixed horizon under the lights.
  // Left out where the sky fades into the page instead (the Rays hero).
  if (!landscape) return ctx.canvas;
  const terrain = noiseField(random);
  for (const [base, relief, colour] of [[0.90, 0.054, '#122131'], [0.97, 0.037, '#091522']] as const) {
    const peaks = Array.from({ length: 13 }, () => random());
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let px = 0; px <= w; px++) {
      const u = px / w * (peaks.length - 1);
      const i = Math.min(Math.floor(u), peaks.length - 2);
      const profile = peaks[i] + (peaks[i + 1] - peaks[i]) * (u - i);
      const rock = 0.24 * terrain(u * 5.1 + base * 90) + 0.11 * terrain(u * 19 + relief * 120);
      ctx.lineTo(px, h * (base - relief * (profile + rock)));
    }
    ctx.lineTo(w, h); ctx.fillStyle = colour; ctx.fill();
  }
  return ctx.canvas;
}

// A cross-section through a curtain. Its brightest edge sits near the lower
// fold. Both ends and the sides taper continuously into transparent sky.
function filament(fold: string, veil: string, soft: number) {
  const ctx = surface(40, 160);
  const gradient = ctx.createLinearGradient(0, 0, 0, 160);
  const middle = `color-mix(in srgb, ${fold} 58%, ${veil})`;
  const edge = `color-mix(in srgb, ${fold} 76%, white)`;
  const stops: [number, string, number][] = [
    [0, veil, 0], [0.16, veil, 0.10], [0.38, veil, 0.24], [0.55, middle, 0.24],
    [0.73, fold, 0.50], [0.83, fold, 0.84], [0.88, edge, 1],
    [0.92, fold, 0.46 + soft * 0.15], [1, fold, 0],
  ];
  for (const [y, colour, alpha] of stops) {
    gradient.addColorStop(y, `color-mix(in srgb, ${colour} ${alpha * 100}%, transparent)`);
  }
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 40, 160);
  const feather = ctx.createLinearGradient(0, 0, 40, 0);
  for (const [x, a] of [[0, 0], [0.17, 0.08], [0.34, 0.55], [0.5, 1], [0.66, 0.55], [0.83, 0.08], [1, 0]]) {
    feather.addColorStop(x, `rgba(0,0,0,${a})`);
  }
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = feather; ctx.fillRect(0, 0, 40, 160);
  return ctx.canvas;
}

/**
 * `sky: false` leaves the night out of each frame (the lights then paint on a
 * transparent canvas); the night is still built and returned as `.sky`, for a
 * caller that layers and fades the two apart.
 *
 * `frame` lays the curtains out in a rectangle of the canvas instead of the
 * whole of it ({x, y, width, height} in canvas pixels): their folds and rays
 * scale with the frame, so a wide, short canvas can keep a square tile's
 * proportions without cropping. The night still fills the canvas.
 */
export function makeAurora(
  w: number, h: number, track: AuroraSound,
  { landscape = true, sky = true, frame }: { landscape?: boolean; sky?: boolean; frame?: { x: number; y: number; width: number; height: number } } = {},
) {
  const fx = frame?.x ?? 0, fy = frame?.y ?? 0, fw = frame?.width ?? w, fh = frame?.height ?? h;
  const random = randomFor(track.id);
  const background = night(w, h, random, landscape);
  const palette = track.mix.slice(0, 2);
  const weight = palette.reduce((sum, item) => sum + item.share, 0);
  const genreHue = weight ? palette.reduce((sum, item) => sum + (hues[item.genre] ?? 155) * item.share, 0) / weight : 155;
  const {energy, brightness, percussiveness} = track.percentiles;
  const softness = track.values.acousticness;
  const mirror = random() > 0.5;
  const bend = random() * 2 * Math.PI;

  const { palette: colours, streams } = signatureStyle(track);
  const veil = `color-mix(in srgb, ${colours.veil} 86%, hsl(${genreHue} 78% 63%))`;

  function curtain(layer: number) {
    const depth = streams === 1 ? 0 : layer / (streams - 1);
    const distant = layer > 0;
    const ctx = surface(w, h);
    const fold = distant ? `color-mix(in srgb, ${colours.fold} 68%, ${veil})` : colours.fold;
    const sprite = filament(fold, veil, softness);
    const phase = random() * 6.28;
    const noise = noiseField(random);
    const folds = distant ? 1.2 : 1.4 + random() * 0.65;
    const steps = 1150;
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < steps; i++) {
      const u = i / (steps - 1);
      const perspective = 1 - 0.70 * u;
      const wave = (u * folds * 2 * Math.PI) + bend + (layer * 1.8);
      // Sweep a folded sheet through depth. Near a turn, filaments overlap
      // naturally and create a bright pleat instead of an outlined wave.
      let x = -0.18 + 1.36 * u + perspective * (0.12 * Math.sin(wave) + 0.037 * Math.sin(wave * 2 + phase));
      if (mirror) x = 1 - x;
      const y = 0.28 + (0.38 - 0.23 * depth) * u + 0.37 * depth
        + perspective * ((distant ? 0.07 : 0.14) * Math.cos(wave) + 0.023 * Math.sin(wave * 2.7 + phase));
      const ribs = noise(u * (28 + 165 * percussiveness) + 5 * noise(u * 8));
      const fine = noise(u * 360 + phase);
      const swell = noise(u * 8 + phase);
      const length = fh * (0.44 - 0.24 * depth) * (0.71 + 0.79 * energy) * perspective
        * (0.70 + 0.34 * swell + 0.09 * Math.sin(wave + phase) + 0.10 * fine);
      const width = fw * (0.010 + 0.010 * softness) * (0.56 + 0.44 * perspective);
      const taper = Math.min(1, u * 12, (1 - u) * 12);
      const opacity = (0.40 + 0.60 * ribs) * (0.62 + 0.38 * fine) * (0.31 + 0.45 * swell + 0.24 * Math.sin(wave - 0.4) ** 2);
      ctx.globalAlpha = taper * opacity * (0.55 + 0.40 * brightness) * (0.65 - 0.28 * depth) / (1 + softness);
      const lean = (mirror ? -1 : 1) * (0.20 + 0.32 * Math.sin(u * 3 + bend));
      ctx.setTransform(1, 0, lean, 1, fx + x * fw, fy + y * fh);
      ctx.drawImage(sprite, -width / 2, -0.88 * length, width, length);
    }
    const haze = surface(w, h);
    haze.filter = `blur(${Math.max(1.4, fh * 0.031)}px)`;
    haze.drawImage(ctx.canvas, 0, 0);
    ctx.resetTransform();
    ctx.globalAlpha = 0.67;
    ctx.drawImage(haze.canvas, 0, 0);
    return ctx.canvas;
  }
  const near = curtain(0);
  // Bake the rear streams into one layer so a four-stream sky animates as
  // cheaply as a two-stream sky.
  const rear = streams > 1 ? surface(w, h) : null;
  if (rear) {
    rear.globalCompositeOperation = 'screen';
    for (let layer = streams - 1; layer > 0; layer--) rear.drawImage(curtain(layer), 0, 0);
  }
  const paint = (ctx: CanvasRenderingContext2D, time: number) => {
    const phase = time * (track.bpm ?? 110) / 110 * 0.22;
    if (sky) ctx.drawImage(background, 0, 0);
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    if (rear) ctx.drawImage(rear.canvas, 0, fh * 0.006 * Math.sin(phase * 0.6 + bend));
    const sway = 0.003 + 0.009 * track.values.danceability;
    ctx.transform(1, sway * Math.sin(phase + bend), 0.007 * Math.cos(phase * 0.7), 1, 0, 0);
    ctx.globalAlpha = 0.94 + 0.06 * Math.sin(phase * 1.7);
    ctx.drawImage(near, -w * 0.015, -h * 0.015, w * 1.03, h * 1.03); ctx.restore();
  };
  return Object.assign(paint, { sky: background });
}
