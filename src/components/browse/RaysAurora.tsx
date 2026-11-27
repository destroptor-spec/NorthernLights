import React, { useEffect, useRef, type RefObject } from 'react';
import { makeAurora, type AuroraSound } from '../../utils/auroraSignature';

/** The aurora is a soft backdrop: drawn at most this many pixels on its long side, then scaled by CSS. */
const MAX_SIDE = 1600;
/** The curtains' frame may be this much wider than tall: wide enough to span the hero, close enough to square to keep the demo tiles' sweep. */
const MAX_STRETCH = 1.5;
/** On a tall (phone) hero the square frame sits this far down the spare height, behind the cover and title. */
const TALL_OFFSET = 0.4;
/** One star per cell of this size (CSS pixels), somewhere inside it, and only in some cells: an even scatter, never a clump. */
const STAR_CELL = 64;
const STAR_CHANCE = 0.55;

/** A small seeded random, so a track's stars stay put between visits and resizes. */
function seeded(text: string) {
  let seed = 2166136261;
  for (const ch of text) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sparse stars over the area, in the theme's ink: mostly faint pinpricks, a few brighter. */
function starLayer(w: number, h: number, cell: number, id: string) {
  const layer = document.createElement('canvas');
  layer.width = w; layer.height = h;
  const ctx = layer.getContext('2d');
  if (!ctx) return layer;
  const root = document.documentElement;
  const ink = getComputedStyle(root).getPropertyValue('--color-text-primary').trim() || '#d8d8e8';
  const dark = root.classList.contains('dark');
  const random = seeded(`${id}:stars`);
  ctx.fillStyle = ink;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if (random() > STAR_CHANCE) continue;
      const sx = x + random() * cell, sy = y + random() * cell;
      const magnitude = random() ** 4;
      ctx.globalAlpha = (dark ? 0.22 : 0.14) + magnitude * (dark ? 0.6 : 0.3);
      ctx.beginPath();
      ctx.arc(sx, sy, 0.55 + magnitude * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return layer;
}

/**
 * The track's aurora signature behind the Rays hero, drawn straight on the
 * page: in the dark theme the page is the night, with a sparse field of stars
 * behind the curtains; in the light theme the curtains show as soft colour
 * on the light page. The renderer scales its curtains with their frame, so
 * laid out over the whole wide, short hero they flatten into bands; instead
 * they get a frame as tall as the hero and at most 1.5× as wide, centred, so
 * the whole curtain fits with the demo tiles' proportions. The lights drift
 * only while on screen, the tab is visible and reduced motion is off;
 * otherwise they hold one still frame. Rebuilt (debounced) when its size
 * changes; the stars are redrawn when the theme does.
 */
export const RaysAurora: React.FC<{
  sound: AuroraSound;
  /** The hero: the curtains are laid out over it alone, however far the stars reach below. */
  heroRef?: RefObject<HTMLElement | null>;
}> = ({ sound, heroRef }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let rebuild = 0;
    let visible = false;
    let render: ReturnType<typeof makeAurora> | undefined;
    let stars: HTMLCanvasElement | null = null;
    let lastArea = 0;
    let scale = 1;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const starCell = () => Math.max(16, Math.round(STAR_CELL * scale));

    const size = () => {
      const box = canvas.getBoundingClientRect();
      scale = Math.min(1, MAX_SIDE / Math.max(1, box.width, box.height));
      const w = Math.max(1, Math.round(box.width * scale)), h = Math.max(1, Math.round(box.height * scale));
      // The curtains' area: from the top of the canvas to the foot of the hero.
      const hero = heroRef?.current?.getBoundingClientRect();
      const area = hero ? Math.max(1, Math.min(h, Math.round((hero.bottom - box.top) * scale))) : h;
      if (render && canvas.width === w && canvas.height === h && lastArea === area) return;
      lastArea = area;
      canvas.width = w; canvas.height = h;
      // The curtains' frame: as tall as that area and up to 1.5× as wide on a
      // wide hero; a square on a tall one, a little above the middle.
      const tall = area > w;
      const fh = tall ? w : area;
      const fw = Math.min(w, Math.round(fh * MAX_STRETCH));
      const frame = { x: Math.round((w - fw) / 2), y: tall ? Math.round((area - fh) * TALL_OFFSET) : 0, width: fw, height: fh };
      render = makeAurora(w, h, sound, { landscape: false, sky: false, frame });
      stars = starLayer(w, h, starCell(), sound.id);
    };
    const draw = (time: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (stars) ctx.drawImage(stars, 0, 0);
      render?.(ctx, time);
    };
    const tick = (now: number) => {
      draw(now / 1000);
      raf = requestAnimationFrame(tick);
    };
    const paint = () => {
      cancelAnimationFrame(raf);
      if (visible && !motion.matches && !document.hidden) raf = requestAnimationFrame(tick);
      else draw(1.2);
    };
    const restar = () => {
      stars = starLayer(canvas.width, canvas.height, starCell(), sound.id);
      paint();
    };

    size();
    paint();
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; paint(); });
    intersection.observe(canvas);
    const resize = new ResizeObserver(() => {
      window.clearTimeout(rebuild);
      rebuild = window.setTimeout(() => { size(); paint(); }, 180);
    });
    resize.observe(canvas);
    if (heroRef?.current) resize.observe(heroRef.current);
    const theme = new MutationObserver(restar);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    motion.addEventListener('change', paint);
    document.addEventListener('visibilitychange', paint);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(rebuild);
      intersection.disconnect();
      resize.disconnect();
      theme.disconnect();
      motion.removeEventListener('change', paint);
      document.removeEventListener('visibilitychange', paint);
    };
  }, [sound, heroRef]);

  return (
    <div className="rays-aurora" aria-hidden="true">
      <canvas ref={ref} className="rays-aurora__canvas" />
    </div>
  );
};
