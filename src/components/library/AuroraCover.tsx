import React, { useId } from 'react';

// Procedural cover art for generated playlist families — pure inline SVG built
// from the --aurora-cover-* tokens (no raster assets, no network, theme-stable
// like every other cover gradient). Four deliberately distinct motifs so the
// families never read as the same thing at a glance:
//
//   wrapped     — a horizontal wave horizon: seasonal sky over a wave-split
//                 field, soft bloom along the crest, big period label.
//   favourites  — vertical aurora curtains (green/teal): light pillars over a
//                 night base, genre label. Genre heavy-rotation mixes.
//   rediscover  — echo arcs (violet/rose): a low glow with soft concentric
//                 rings radiating out, genre label. Genre rediscovery mixes.
//   decade      — a sweeping aurora ribbon with the decade numeral printed
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
// 2–4 gently swaying full-height bands; the vertical gradient does the fading
// so the path stays simple. Positions/widths/sway/peak all seeded per cover.
// Bands roam freely (they may overlap — overlaps blend like layered light) and
// range from slim streaks to broad sheets; the wider the band, the softer its
// peak so fat overlaps never go blocky.
interface Curtain { x: number; w: number; sway: number; peak: number; peakAt: number }

function genCurtains(rnd: () => number): Curtain[] {
  const count = 2 + Math.floor(rnd() * 3); // 2–4
  return Array.from({ length: count }, () => {
    const w = lerp(rnd, 18, 90);
    const x = lerp(rnd, -12, 210 - w); // slight offscreen bleed allowed
    const sway = (rnd() < 0.5 ? -1 : 1) * lerp(rnd, 6, 16);
    const peak = lerp(rnd, 0.38, 0.6) * (1 - ((w - 18) / 72) * 0.3);
    return { x, w, sway, peak, peakAt: lerp(rnd, 0.2, 0.45) };
  });
}

function curtainPath({ x, w, sway }: Curtain): string {
  const r = x + w;
  return `M${x} 0 C ${x + sway} 60, ${x - sway} 130, ${x} 200 L ${r} 200 C ${r - sway} 130, ${r + sway} 60, ${r} 0 Z`;
}

// ─── Rediscover: echo arcs (generated) ─────────────────────────────────
// A glow with 1–5 concentric rings radiating out — light returning. Origin,
// ring count, spacing, stroke widths and opacities all seeded per cover.
// Fewer rings → thicker bands: 1–2 rings target the decade ribbon's 38–58u
// scale, and each extra ring steps the range down toward fine lines.
const RING_WIDTH_RANGES: Array<[number, number]> = [
  [38, 58], // 1 ring
  [18, 32], // 2 rings
  [8, 16],  // 3 rings
  [4, 9],   // 4 rings
  [1.6, 4], // 5 rings
];

interface EchoRing { r: number; sw: number; op: number }

function genEcho(rnd: () => number): { cx: number; cy: number; glowR: number; rings: EchoRing[] } {
  const cx = lerp(rnd, 48, 152);
  const cy = lerp(rnd, 66, 152);
  const count = 1 + Math.floor(rnd() * 5); // 1–5
  const [wMin, wMax] = RING_WIDTH_RANGES[count - 1];
  const rings: EchoRing[] = [];
  // Track the outer edge of the previous ring so fat bands never overlap.
  let edge = lerp(rnd, 10, 26);
  for (let i = 0; i < count; i++) {
    const sw = lerp(rnd, wMin, wMax);
    const r = edge + sw / 2;
    rings.push({ r, sw, op: Math.max(0.1, lerp(rnd, 0.34, 0.5) - i * 0.07) });
    edge = r + sw / 2 + lerp(rnd, 10, 24);
  }
  return { cx, cy, glowR: lerp(rnd, 48, 78), rings };
}

// ─── Decade: aurora ribbon (generated) ─────────────────────────────────
// The sweeping band's waveform and thickness are seeded per cover; thickness
// never drops below the original hand-tuned 38 units so the ribbon stays
// substantial. The numeral stays fixed and readable.
function genRibbon(rnd: () => number): { main: string; cross: string } {
  const t = lerp(rnd, 38, 58);
  const y0 = lerp(rnd, 118, 168);           // left anchor
  const y1 = lerp(rnd, 72, 126);            // right anchor
  const c1y = y0 - lerp(rnd, 28, 66);       // first control: rise
  const c2y = y1 + lerp(rnd, 30, 84);       // second control: dip
  const main = `M-10 ${y0} C 44 ${c1y}, 118 ${c2y}, 210 ${y1} L 210 ${y1 + t} C 118 ${c2y + t}, 44 ${c1y + t}, -10 ${y0 + t} Z`;
  // Thin counter-band recrossing the glyph at low opacity.
  const ct = lerp(rnd, 12, 20);
  const cy0 = lerp(rnd, 100, 128);
  const cy1 = lerp(rnd, 112, 146);
  const cc1 = cy0 + lerp(rnd, 24, 48);
  const cc2 = cy1 - lerp(rnd, 28, 52);
  const cross = `M-10 ${cy0} C 52 ${cc1}, 128 ${cc2}, 210 ${cy1} L 210 ${cy1 + ct} C 128 ${cc2 + ct}, 52 ${cc1 + ct}, -10 ${cy0 + ct} Z`;
  return { main, cross };
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

/** Widest a line of cover text may run (of 200), before it is squeezed to fit. */
const SUBLABEL_MAX_WIDTH = 168;

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
          {curtains.map((c, i) => (
            <linearGradient key={i} id={`${uid}-c${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={i % 2 === 1 ? tintB : tintA} stopOpacity="0.08" />
              <stop offset={c.peakAt} stopColor={i % 2 === 1 ? tintB : tintA} stopOpacity={c.peak} />
              <stop offset="1" stopColor={i % 2 === 1 ? tintB : tintA} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        {curtains.map((c, i) => (
          <path key={i} d={curtainPath(c)} fill={`url(#${uid}-c${i})`} />
        ))}
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
            <stop offset="0" stopColor={tintA} stopOpacity="0.55" />
            <stop offset="0.6" stopColor={tintA} stopOpacity="0.18" />
            <stop offset="1" stopColor={tintA} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
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
          />
        ))}
      </>
    );
  } else {
    // decade — a sweeping ribbon with the numeral printed into the art. One
    // thin band recrosses the glyph at low opacity so it sits *in* the aurora
    // while staying easily readable.
    const p = (auroraSeedVariant(seed, 4) + 1) as 1 | 2 | 3 | 4;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    const ribbon = genRibbon(mulberry32(hash));
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
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        <path d={ribbon.main} fill={`url(#${uid}-ribbon)`} />
        {label && (
          <text
            x="100"
            y={sublabel ? 110 : 124}
            textAnchor="middle"
            fontSize="66"
            fontWeight="900"
            fill="#ffffff"
            opacity="0.96"
            style={{ fontFamily: 'inherit', letterSpacing: '-0.02em' }}
          >
            {label}
          </text>
        )}
        {sublabel && (
          <text
            x="100"
            y="150"
            textAnchor="middle"
            fontSize="22"
            fontWeight="800"
            fill="#ffffff"
            opacity="0.92"
            style={{ fontFamily: 'inherit' }}
            // Long styles ("Progressive House") are squeezed to the width, never cut.
            {...(sublabel.length * 22 * 0.56 > SUBLABEL_MAX_WIDTH
              ? { textLength: SUBLABEL_MAX_WIDTH, lengthAdjust: 'spacingAndGlyphs' }
              : {})}
          >
            {sublabel}
          </text>
        )}
        <path d={ribbon.cross} fill={tintB} opacity="0.16" />
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
        <g transform={flip && variant !== 'decade' ? 'scale(-1,1) translate(-200,0)' : undefined}>
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
