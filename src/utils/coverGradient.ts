// Procedural cover-color gradients shared by the Hub feature tile and the
// mobile now-playing background. Given a seed (so the same cover always rolls
// the same layout) and a palette of extracted cover colors, these build a
// vibrant multi-layer CSS gradient string.

// Aurora-spectrum fallback palette when a cover doesn't yield usable colors.
// Mirrors the brand spectrum (oxygen green → teal → sky blue → rose pink).
export const AURORA_FALLBACK_PALETTE = ['#22c983', '#2dd4bf', '#0ea5e9', '#f43f5e'];

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function asHexColor(color: string | undefined, fallback: string): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = asHexColor(hex, AURORA_FALLBACK_PALETTE[0]).slice(1);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Coerce a palette into at least 4 distinct, valid hex colors, padding from the
// aurora fallback when needed. Deterministic for a given seed.
function normalizePalette(seed: string, palette: string[], fallbackColor: string): string[] {
  const fallbackPalette = AURORA_FALLBACK_PALETTE;
  const usablePalette = [...palette, fallbackColor]
    .map((color, index) => asHexColor(color, fallbackPalette[index % fallbackPalette.length]))
    .filter(Boolean);
  const colors = Array.from(new Set(usablePalette));
  while (colors.length < 4) colors.push(fallbackPalette[(colors.length + hashString(seed)) % fallbackPalette.length]);
  return colors;
}

// Hub mesh: soft, overlapping color fields distributed across the card.
// Keep the geometry stable while extracted artwork colors arrive.
export function buildMeshCoverGradient(seed: string, palette: string[], fallbackColor: string): string {
  const colors = normalizePalette(seed, palette, fallbackColor);

  const roll = hashString(`${seed}:mesh`);
  const pick = (offset: number) => colors[(roll + offset) % colors.length];
  const x1 = 5 + (roll % 22);
  const y1 = 4 + ((roll >>> 4) % 24);
  const x2 = 72 + ((roll >>> 8) % 24);
  const y2 = 8 + ((roll >>> 12) % 28);
  const x3 = 12 + ((roll >>> 16) % 28);
  const y3 = 76 + ((roll >>> 20) % 20);
  const x4 = 68 + ((roll >>> 6) % 26);
  const y4 = 70 + ((roll >>> 14) % 26);

  const c1 = pick(0);
  const c2 = pick(1);
  const c3 = pick(2);
  const c4 = pick(3);

  return [
    `radial-gradient(ellipse 75% 95% at ${x1}% ${y1}%, ${hexToRgba(c1, 0.80)} 0%, ${hexToRgba(c1, 0.36)} 40%, ${hexToRgba(c1, 0)} 100%)`,
    `radial-gradient(ellipse 70% 90% at ${x2}% ${y2}%, ${hexToRgba(c2, 0.76)} 0%, ${hexToRgba(c2, 0.32)} 42%, ${hexToRgba(c2, 0)} 100%)`,
    `radial-gradient(ellipse 80% 85% at ${x3}% ${y3}%, ${hexToRgba(c3, 0.68)} 0%, ${hexToRgba(c3, 0.28)} 38%, ${hexToRgba(c3, 0)} 100%)`,
    `radial-gradient(ellipse 75% 95% at ${x4}% ${y4}%, ${hexToRgba(c4, 0.72)} 0%, ${hexToRgba(c4, 0.30)} 40%, ${hexToRgba(c4, 0)} 100%)`,
  ].join(', ');
}

// Aurora bloom for the mobile now-playing backdrop: a few large, soft radial
// glows rolled from the cover's palette, laid over the blurred art. Deliberately
// restrained — fewer, larger, softer hotspots than a mesh, and no conic layer
// (banding + raster cost). The glows live in the upper two-thirds; the bottom
// belongs to the static neutral scrim. Vibrancy is bounded by construction: the
// bloom container's fixed envelope opacity plus that scrim guarantee text
// contrast for any cover, so no adaptive veil/tint machinery is needed.
export function buildBloomGradient(seed: string, palette: string[], fallbackColor: string): string {
  const colors = normalizePalette(seed, palette, fallbackColor);

  const roll = hashString(`${seed}:bloom:${colors.join('|')}`);
  const pick = (offset: number) => colors[(roll + offset) % colors.length];
  const x1 = 8 + (roll % 34);
  const y1 = 4 + ((roll >> 4) % 20);
  const x2 = 56 + ((roll >> 8) % 36);
  const y2 = 14 + ((roll >> 12) % 24);
  const x3 = 24 + ((roll >> 16) % 50);
  const y3 = 40 + ((roll >> 20) % 22);

  const c1 = pick(0);
  const c2 = pick(1);
  const c3 = pick(2);

  return [
    `radial-gradient(90% 70% at ${x1}% ${y1}%, ${hexToRgba(c1, 0.55)} 0%, ${hexToRgba(c1, 0.22)} 42%, transparent 74%)`,
    `radial-gradient(80% 65% at ${x2}% ${y2}%, ${hexToRgba(c2, 0.48)} 0%, ${hexToRgba(c2, 0.18)} 40%, transparent 70%)`,
    `radial-gradient(100% 80% at ${x3}% ${y3}%, ${hexToRgba(c3, 0.38)} 0%, transparent 64%)`,
  ].join(', ');
}
