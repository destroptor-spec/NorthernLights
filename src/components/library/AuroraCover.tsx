import React, { useId } from 'react';

// Procedural cover art for generated playlist families — pure inline SVG built
// from the --aurora-cover-* tokens (no raster assets, no network, theme-stable
// like every other cover gradient). Four deliberately distinct motifs so the
// families never read as the same thing at a glance:
//
//   wrapped     — a horizontal wave horizon: seasonal sky over a wave-split
//                 field, soft bloom along the crest, big period label.
//   favourites  — vertical aurora curtains (green/teal): light pillars across
//                 a glowing night sky, genre label. Heavy-rotation mixes.
//   rediscover  — echo arcs (violet/rose): rings radiating from a lit corner
//                 across the cover, genre label. Rediscovery mixes.
//   decade      — 2–3 sweeping aurora ribbons with the decade numeral printed
//                 into the art, always readable. Decade / decade-genre mixes;
//                 a decade-genre mix also prints its style under the numeral
//                 ("2010" over "House"), so it never reads as the plain decade.
//
// Everything is deterministic from `seed` (playlist id/title): same playlist
// always gets the same cover, different playlists spread across variants.

export type AuroraCoverVariant = 'wrapped' | 'favourites' | 'rediscover' | 'decade';

export type WrappedPalette = 'spring' | 'summer' | 'autumn' | 'winter' | 'year';

// FNV-1a; tiny and stable across sessions (covers must never shuffle on reload).
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — a tiny seeded PRNG so every cover's geometry is unique yet
// fully deterministic (same playlist → same cover, forever). Math.random is
// deliberately never used here.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (rnd: () => number, min: number, max: number) => min + rnd() * (max - min);

/** Deterministic bucket pick for a seed — exported for tests and callers. */
export function auroraSeedVariant(seed: string, buckets: number): number {
  if (buckets <= 0) return 0;
  return hashSeed(seed || '') % buckets;
}

/** "Spring 2026" → seasonal palette; "2025 Wrapped" (or anything else) → full-year. */
export function wrappedCoverPalette(title: string | null | undefined): WrappedPalette {
  const m = /^(winter|spring|summer|autumn)\s+\d{4}$/i.exec((title || '').trim());
  return m ? (m[1].toLowerCase() as WrappedPalette) : 'year';
}

/** Cover label: "2025 Wrapped" → "2025"; season titles pass through unchanged. */
export function wrappedCoverLabel(title: string | null | undefined): string {
  return (title || '').replace(/\s+Wrapped$/i, '').trim();
}

/**
 * Genre for the cover from an engine-mix title. New forms "Your Trance
 * favourites" / "Rediscover Trance", plus the legacy "Trance Heavy Rotation" /
 * "Trance Rediscovery" until playlists regenerate.
 */
export function systemGenreCoverLabel(title: string | null | undefined): string {
  const t = (title || '').trim();
  const fav = /^Your\s+(.+)\s+favourites$/i.exec(t);
  if (fav) return fav[1];
  const red = /^Rediscover\s+(.+)$/i.exec(t);
  if (red) return red[1];
  return t.replace(/\s+(Heavy Rotation|Rediscovery)$/i, '').trim();
}

/**
 * Full decade numeral for the cover from an engine-mix title: "The 2010's" /
 * "Trance from the 2010's" → "2010"; legacy "90's Mix" / "90's Pop" → "1990"
 * (two-digit decades ≥ 50 are 19xx, below are 20xx — the library's year floor
 * is 1950).
 */
export function systemDecadeCoverLabel(title: string | null | undefined): string {
  const t = (title || '').trim();
  const full = /\b((?:19|20)\d0)'?s\b/.exec(t);
  if (full) return full[1];
  const short = /\b(\d0)'s\b/.exec(t);
  if (short) return `${Number(short[1]) >= 50 ? 19 : 20}${short[1]}`;
  return t.replace(/\s+Mix$/i, '').trim();
}

/** Style for the cover from a decade-genre title: "House from the 2010's" → "House". */
export function systemDecadeGenreCoverLabel(title: string | null | undefined): string | undefined {
  const m = /^(.+?)\s+from the\s+(?:(?:19|20)\d0|\d0)'?s$/i.exec((title || '').trim());
  return m ? m[1].trim() : undefined;
}

/** The Aurora cover of a Discover (engine) playlist. */
export interface SystemPlaylistCover {
  variant: AuroraCoverVariant;
  /** Seeded by title, as the Hub always has, so the shape is the same on every surface. */
  seed: string;
  label?: string;
  sublabel?: string;
}

/**
 * The cover a Discover playlist has wherever it shows (the Hub, the
 * Playlists view, the playlist page), from its engine id and title; null
 * for every other playlist.
 */
export function systemPlaylistCover(id: string | null | undefined, title: string | null | undefined): SystemPlaylistCover | null {
  const key = id || '';
  const t = title || '';
  if (key.startsWith('engine_genre-most')) return { variant: 'favourites', seed: t, label: systemGenreCoverLabel(t) };
  if (key.startsWith('engine_genre-stale')) return { variant: 'rediscover', seed: t, label: systemGenreCoverLabel(t) };
  if (key.startsWith('engine_decade-genre')) return { variant: 'decade', seed: t, label: systemDecadeCoverLabel(t), sublabel: systemDecadeGenreCoverLabel(t) };
  if (key.startsWith('engine_decade')) return { variant: 'decade', seed: t, label: systemDecadeCoverLabel(t) };
  return null;
}

// ─── Wrapped: wave horizon ─────────────────────────────────────────────
// Hand-tuned field shapes (200×200 box, gentle 1–1.5 undulation crests). The
// crest path is reused via <use> for the bloom layers, so it lives in <defs>
// with no fill of its own.
const WAVE_PATHS = [
  'M0 118 C 34 104, 64 134, 100 121 C 136 108, 168 96, 200 110 L 200 200 L 0 200 Z',
  'M0 104 C 40 122, 72 94, 110 110 C 148 126, 172 122, 200 102 L 200 200 L 0 200 Z',
  'M0 128 C 28 112, 66 142, 104 126 C 142 110, 166 104, 200 122 L 200 200 L 0 200 Z',
];

// ─── Favourites: aurora curtains (generated) ───────────────────────────
// 2–4 broad, swaying sheets of light spread across the width (one per slot,
// jittered, so they never all clump on one side), each leaning so its foot
// sits off its head: abstract aurora, not stripes. The vertical gradient
// does the fading; the sheets blend with `screen`, so overlaps brighten like
// layered light. Positions/widths/lean/sway/peak all seeded per cover.
interface Curtain { x: number; w: number; sway: number; lean: number; peak: number; peakAt: number }

function genCurtains(rnd: () => number): Curtain[] {
  const count = 2 + Math.floor(rnd() * 3); // 2–4
  const slot = 220 / count;
  return Array.from({ length: count }, (_, i) => {
    const w = lerp(rnd, 46, 120);
    const centre = -10 + slot * (i + 0.5) + lerp(rnd, -slot * 0.3, slot * 0.3);
    const sway = (rnd() < 0.5 ? -1 : 1) * lerp(rnd, 14, 38);
    const lean = lerp(rnd, -40, 40);
    // Broad sheets a little softer, so wide overlaps stay luminous, not blocky.
    const peak = lerp(rnd, 0.58, 0.82) * (1 - ((w - 46) / 74) * 0.3);
    return { x: centre - w / 2, w, sway, lean, peak, peakAt: lerp(rnd, 0.14, 0.42) };
  });
}

function curtainPath({ x, w, sway, lean }: Curtain): string {
  const r = x + w;
  return `M${x} 0 C ${x + sway} 60, ${x + lean - sway} 130, ${x + lean} 200 L ${r + lean} 200 C ${r + lean - sway} 130, ${r + sway} 60, ${r} 0 Z`;
}

// ─── Rediscover: echo arcs (generated) ─────────────────────────────────
// Light returning: concentric rings radiating from a source at or just past
// one corner (never the bottom-left, where the label sits), wide enough that
// the arcs sweep across the whole cover. A broad glow sits at the source and
// a softer wash of the second tint fills the far side. Corner, ring count,
// spacing, stroke widths and opacities all seeded per cover.
const ECHO_SOURCES: Array<{ x: [number, number]; y: [number, number] }> = [
  { x: [150, 215], y: [-20, 40] },  // top right
  { x: [-15, 50], y: [-20, 30] },   // top left
  { x: [160, 220], y: [120, 190] }, // bottom right
  { x: [175, 225], y: [50, 110] },  // right
];

interface EchoRing { r: number; sw: number; op: number }

function genEcho(rnd: () => number): { cx: number; cy: number; glowR: number; rings: EchoRing[] } {
  const source = ECHO_SOURCES[Math.floor(rnd() * ECHO_SOURCES.length)];
  const cx = lerp(rnd, source.x[0], source.x[1]);
  const cy = lerp(rnd, source.y[0], source.y[1]);
  // Reach the far corner, so the outer arcs cross the whole square.
  const reach = Math.hypot(Math.max(cx, 200 - cx), Math.max(cy, 200 - cy));
  const count = 3 + Math.floor(rnd() * 5); // 3–7
  const rings: EchoRing[] = [];
  let edge = lerp(rnd, 12, 30);
  const step = (reach - edge) / count;
  // Widths vary widely within a cover: hairlines beside broad bands, and
  // rings may overlap. One ring is always broad, so no cover is all fine lines.
  const broadAt = Math.floor(rnd() * count);
  for (let i = 0; i < count; i++) {
    const broad = i === broadAt || rnd() < 0.35;
    const sw = broad ? lerp(rnd, step * 0.55, step * 1.05) : lerp(rnd, 1.5, Math.max(2, step * 0.22));
    const r = edge + sw / 2;
    // Thin lines need more opacity to read; broad bands less, to stay soft.
    const op = broad ? lerp(rnd, 0.38, 0.6) : lerp(rnd, 0.55, 0.85);
    rings.push({ r, sw, op: Math.max(0.22, op - i * 0.03) });
    // About a third of rings overlap the last (screen blend brightens the
    // overlap); the radius still always grows outward.
    const gap = rnd() < 0.35 ? -lerp(rnd, step * 0.1, step * 0.6) : lerp(rnd, step * 0.12, step * 0.55);
    edge = Math.max(r + 2, r + sw / 2 + gap);
  }
  // Overlaps and broad bands change how far the set reaches: scale it so
  // the outer ring always crosses the cover to (about) the far corner.
  const last = rings[rings.length - 1];
  const scale = (reach * lerp(rnd, 0.88, 1.05)) / (last.r + last.sw / 2);
  for (const ring of rings) { ring.r *= scale; ring.sw = Math.max(1.5, ring.sw * scale); }
  return { cx, cy, glowR: lerp(rnd, 95, 140), rings };
}

// ─── Decade: aurora ribbons (generated) ────────────────────────────────
// 2–3 sweeping ribbons whose width and curve vary widely: one broad band
// (it can be wider than the cover is tall, washing most of it) and one or
// two narrower ones, from hairline streaks to wide bands. Each may taper,
// wider at one end, and arcs gently or steeply. A thin one may recross the
// numeral at low opacity, so the numeral sits *in* the aurora; the rest lie
// under it. All seeded per cover; the numeral stays fixed and readable.
interface Ribbon { d: string; broad: boolean; over: boolean }

function ribbonPath(rnd: () => number, t0: number, t1: number): string {
  const y0 = lerp(rnd, -30, 200 - t0 * 0.4);  // left anchor (top edge)
  const y1 = lerp(rnd, -30, 200 - t1 * 0.4);  // right anchor
  const bend = lerp(rnd, 20, 150);            // how far the curve swings
  const c1x = lerp(rnd, 20, 90);
  const c2x = lerp(rnd, 110, 180);
  const c1y = y0 - bend * lerp(rnd, 0.3, 1);
  const c2y = y1 + bend * lerp(rnd, 0.3, 1) * (rnd() < 0.5 ? 1 : -0.4);
  const b0 = t0, b1 = t1;
  const bc1 = t0 * 0.7 + t1 * 0.3, bc2 = t0 * 0.3 + t1 * 0.7;
  return `M-10 ${y0} C ${c1x} ${c1y}, ${c2x} ${c2y}, 210 ${y1} `
    + `L 210 ${y1 + b1} C ${c2x} ${c2y + bc2}, ${c1x} ${c1y + bc1}, -10 ${y0 + b0} Z`;
}

function genRibbons(rnd: () => number): Ribbon[] {
  const count = 2 + Math.floor(rnd() * 2); // 2–3
  const broadAt = Math.floor(rnd() * count);
  const ribbons: Ribbon[] = [];
  for (let i = 0; i < count; i++) {
    const broad = i === broadAt;
    const width = () => (broad ? lerp(rnd, 60, 240) : rnd() < 0.5 ? lerp(rnd, 4, 22) : lerp(rnd, 22, 80));
    const t0 = width();
    const t1 = rnd() < 0.5 ? t0 : width(); // half of them taper
    ribbons.push({ d: ribbonPath(rnd, t0, t1), broad, over: false });
  }
  // The narrowest ribbon may cross over the numeral, faintly.
  const thin = ribbons.filter(r => !r.broad);
  if (thin.length && rnd() < 0.6) thin[thin.length - 1].over = true;
  // Broad first, so narrower ribbons read on top of it.
  return [...ribbons.filter(r => r.broad), ...ribbons.filter(r => !r.broad)];
}

interface AuroraCoverProps {
  variant: AuroraCoverVariant;
  /** Deterministic seed (playlist id/title) — picks shape variant + palette spread. */
  seed: string;
  /** Wrapped only: playlist title, parsed for the seasonal palette. */
  title?: string | null;
  /**
   * Cover text. wrapped/favourites/rediscover: big bottom-left label. decade:
   * the numeral printed into the art (e.g. "10's").
   */
  label?: string;
  /** Decade only: a smaller line under the numeral (a decade-genre mix's style). */
  sublabel?: string;
}

/** Widest a line of cover text may run (of 200). */
const SUBLABEL_MAX_WIDTH = 168;
/** Rough glyph width of the cover font at 800 weight, as a share of the font size. */
const GLYPH_WIDTH = 0.54;
const fitSize = (text: string, max: number) => Math.min(max, SUBLABEL_MAX_WIDTH / (Math.max(1, text.length) * GLYPH_WIDTH));

/**
 * How the style line under a decade numeral is set: one line at 22, smaller
 * down to 17 when it is long ("Progressive House"), else two lines split at
 * the space nearest the middle ("Contemporary Jazz Fusion"). Never squeezed.
 */
export function sublabelLayout(text: string): { lines: string[]; fontSize: number } {
  const one = fitSize(text, 22);
  const words = text.split(/\s+/).filter(Boolean);
  if (one >= 17 || words.length < 2) return { lines: [text], fontSize: Math.round(Math.max(one, 12) * 10) / 10 };
  let best: string[] = [text];
  let bestLongest = Infinity;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const longest = Math.max(...lines.map(l => l.length));
    if (longest < bestLongest) { best = lines; bestLongest = longest; }
  }
  const size = Math.min(...best.map(l => fitSize(l, 19)));
  return { lines: best, fontSize: Math.round(Math.max(size, 12) * 10) / 10 };
}

/** Absolute-fill cover; parent supplies the rounded, clipped square. */
export const AuroraCover: React.FC<AuroraCoverProps> = ({ variant, seed, title, label, sublabel }) => {
  const uid = useId();
  const hash = hashSeed(seed || title || '');
  const flip = (hash & 0x8) !== 0;
  // The decade numeral is part of the art itself, not the bottom-left overlay.
  const overlayLabel = variant === 'decade' ? undefined : label;

  let svgBody: React.ReactNode;
  if (variant === 'wrapped') {
    const palette = wrappedCoverPalette(title);
    const wave = WAVE_PATHS[hash % WAVE_PATHS.length];
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor={`var(--aurora-cover-${palette}-sky-a)`} />
            <stop offset="1" stopColor={`var(--aurora-cover-${palette}-sky-b)`} />
          </linearGradient>
          <linearGradient id={`${uid}-field`} x1="0" y1="0" x2="0.25" y2="1">
            <stop offset="0" stopColor={`var(--aurora-cover-${palette}-field-a)`} />
            <stop offset="1" stopColor={`var(--aurora-cover-${palette}-field-b)`} />
          </linearGradient>
          <path id={`${uid}-wave`} d={wave} />
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-sky)`} />
        {/* Bloom: stacked translucent copies of the field shape, drifting up from
            the crest — soft aurora glow without SVG filters (cheap across rails). */}
        <use href={`#${uid}-wave`} transform="translate(0,-26)" fill="#ffffff" opacity="0.05" />
        <use href={`#${uid}-wave`} transform="translate(0,-15)" fill="#ffffff" opacity="0.07" />
        <use href={`#${uid}-wave`} transform="translate(0,-7)" fill="#ffffff" opacity="0.09" />
        <use href={`#${uid}-wave`} fill={`url(#${uid}-field)`} />
      </>
    );
  } else if (variant === 'favourites') {
    // Green/teal end of the spectrum — the "your heavy rotation" family.
    const p = (auroraSeedVariant(seed, 2) + 1) as 1 | 2;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    const curtains = genCurtains(mulberry32(hash));
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-night`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="var(--aurora-cover-night-a)" />
            <stop offset="1" stopColor="var(--aurora-cover-night-b)" />
          </linearGradient>
          <radialGradient id={`${uid}-sky`} cx="0.5" cy="0.22" r="0.85">
            <stop offset="0" stopColor={tintB} stopOpacity="0.28" />
            <stop offset="0.55" stopColor={tintA} stopOpacity="0.12" />
            <stop offset="1" stopColor={tintA} stopOpacity="0" />
          </radialGradient>
          {curtains.map((c, i) => (
            <linearGradient key={i} id={`${uid}-c${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={i % 2 === 1 ? tintB : tintA} stopOpacity="0.16" />
              <stop offset={c.peakAt} stopColor={i % 2 === 1 ? tintB : tintA} stopOpacity={c.peak} />
              <stop offset="1" stopColor={i % 2 === 1 ? tintB : tintA} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        {/* The sky the curtains hang in: a soft glow of the tint behind them. */}
        <rect width="200" height="200" fill={`url(#${uid}-sky)`} />
        <g style={{ mixBlendMode: 'screen' }}>
          {curtains.map((c, i) => (
            <path key={i} d={curtainPath(c)} fill={`url(#${uid}-c${i})`} />
          ))}
        </g>
      </>
    );
  } else if (variant === 'rediscover') {
    // Violet/rose end of the spectrum — echoes of what you used to play.
    const p = (auroraSeedVariant(seed, 2) + 3) as 3 | 4;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    const echo = genEcho(mulberry32(hash));
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-night`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="var(--aurora-cover-night-a)" />
            <stop offset="1" stopColor="var(--aurora-cover-night-b)" />
          </linearGradient>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0" stopColor={tintA} stopOpacity="0.8" />
            <stop offset="0.45" stopColor={tintA} stopOpacity="0.32" />
            <stop offset="1" stopColor={tintA} stopOpacity="0" />
          </radialGradient>
          {/* The far side: a soft wash of the second tint, so the cover is lit edge to edge. */}
          <radialGradient id={`${uid}-wash`} cx={`${(200 - echo.cx) / 200}`} cy={`${(200 - echo.cy) / 200}`} r="0.9">
            <stop offset="0" stopColor={tintB} stopOpacity="0.26" />
            <stop offset="1" stopColor={tintB} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        <rect width="200" height="200" fill={`url(#${uid}-wash)`} />
        <circle cx={echo.cx} cy={echo.cy} r={echo.glowR} fill={`url(#${uid}-glow)`} />
        {echo.rings.map((ring, i) => (
          <circle
            key={i}
            cx={echo.cx}
            cy={echo.cy}
            r={ring.r}
            fill="none"
            stroke={i % 2 === 0 ? tintA : tintB}
            strokeWidth={ring.sw}
            opacity={ring.op}
            style={{ mixBlendMode: 'screen' }}
          />
        ))}
      </>
    );
  } else {
    // decade — 2–3 sweeping ribbons with the numeral printed into the art. A
    // thin one may recross the glyph at low opacity so it sits *in* the aurora
    // while staying easily readable.
    const p = (auroraSeedVariant(seed, 4) + 1) as 1 | 2 | 3 | 4;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    const ribbons = genRibbons(mulberry32(hash));
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-night`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="var(--aurora-cover-night-a)" />
            <stop offset="1" stopColor="var(--aurora-cover-night-b)" />
          </linearGradient>
          <linearGradient id={`${uid}-ribbon`} x1="0" y1="0" x2="1" y2="0.4">
            <stop offset="0" stopColor={tintA} stopOpacity="0.5" />
            <stop offset="1" stopColor={tintB} stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id={`${uid}-band`} x1="1" y1="0" x2="0" y2="0.6">
            <stop offset="0" stopColor={tintB} stopOpacity="0.62" />
            <stop offset="1" stopColor={tintA} stopOpacity="0.3" />
          </linearGradient>
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        <g style={{ mixBlendMode: 'screen' }}>
          {ribbons.filter(r => !r.over).map((r, i) => (
            // The broad band softer, so it washes the cover without drowning the numeral.
            <path key={i} d={r.d} fill={`url(#${uid}-${r.broad ? 'ribbon' : 'band'})`} opacity={r.broad ? 0.85 : 1} />
          ))}
        </g>
        {label && (
          <text
            x="100"
            y={sublabel ? (sublabelLayout(sublabel).lines.length > 1 ? 98 : 110) : 124}
            textAnchor="middle"
            fontSize="66"
            // Cal Sans has one weight: 400, never a synthetic bold.
            fontWeight="400"
            fill="#ffffff"
            opacity="0.8"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.02em' }}
          >
            {label}
          </text>
        )}
        {sublabel && (() => {
          const { lines, fontSize } = sublabelLayout(sublabel);
          const firstY = lines.length > 1 ? 132 : 150;
          return (
            <text
              x="100"
              textAnchor="middle"
              fontSize={fontSize}
              fontWeight="800"
              fill="#ffffff"
              opacity="0.92"
              style={{ fontFamily: 'inherit' }}
            >
              {lines.map((line, i) => (
                <tspan key={i} x="100" y={firstY + i * fontSize * 1.15}>{line}</tspan>
              ))}
            </text>
          );
        })()}
        {ribbons.filter(r => r.over).map((r, i) => (
          <path key={i} d={r.d} fill={tintB} opacity="0.18" />
        ))}
      </>
    );
  }

  return (
    <div className="absolute inset-0" aria-hidden="true">
      <svg
        viewBox="0 0 200 200"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {/* Mirrored for variety; not the echo arcs, whose source must stay out of the label's corner. */}
        <g transform={flip && (variant === 'wrapped' || variant === 'favourites') ? 'scale(-1,1) translate(-200,0)' : undefined}>
          {svgBody}
        </g>
      </svg>
      {overlayLabel && (
        <>
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/35 to-transparent" />
          <span className="absolute inset-x-3 bottom-3 line-clamp-2 text-left text-2xl font-black leading-none tracking-normal text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
            {overlayLabel}
          </span>
        </>
      )}
    </div>
  );
};
