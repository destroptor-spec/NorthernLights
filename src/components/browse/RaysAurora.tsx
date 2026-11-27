import React, { useEffect, useRef, type RefObject } from 'react';
import { makeAurora, type AuroraSound } from '../../utils/auroraSignature';

/** The aurora is a soft backdrop: drawn at most this many pixels on its long side, then scaled by CSS. */
const MAX_SIDE = 1600;
/** The curtains' frame may be this much wider than tall: wide enough to span the hero, close enough to square to keep the demo tiles' sweep. */
const MAX_STRETCH = 1.5;
/** On a tall (phone) hero the square frame sits this far down the spare height, behind the cover and title. */
const TALL_OFFSET = 0.4;

/**
 * The track's aurora signature behind the Rays hero. The renderer scales its
 * curtains with their frame, so laid out over the whole wide, short hero they
 * flatten into bands, and drawn bigger and cropped they lose their shape.
 * Instead the curtains get a frame as tall as the hero and at most 1.5× as
 * wide, centred: the whole curtain fits, with the demo tiles' proportions,
 * and the night fills the rest. Two layers: the night (sky and stars, drawn once) fades slowly
 * into the page, while the lights above it are drawn in full and fade only
 * at the very bottom, so the fade never cuts the curtains off. The lights
 * drift only while on screen, the tab is visible and reduced motion is off;
 * otherwise they hold one still frame. Rebuilt (debounced) when its size
 * changes.
 */
export const RaysAurora: React.FC<{
  sound: AuroraSound;
  /** The hero: the curtains are laid out over it alone, however far the night reaches below. */
  heroRef?: RefObject<HTMLElement | null>;
}> = ({ sound, heroRef }) => {
  const skyRef = useRef<HTMLCanvasElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const skyCanvas = skyRef.current;
    const ctx = canvas?.getContext('2d');
    const skyCtx = skyCanvas?.getContext('2d');
    if (!canvas || !ctx || !skyCanvas || !skyCtx) return;
    let raf = 0;
    let rebuild = 0;
    let visible = false;
    let render: ReturnType<typeof makeAurora> | undefined;
    let lastArea = 0;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const size = () => {
      const box = canvas.getBoundingClientRect();
      const side = Math.max(box.width, box.height);
      const scale = Math.min(1, MAX_SIDE / Math.max(1, side));
      const w = Math.max(1, Math.round(box.width * scale)), h = Math.max(1, Math.round(box.height * scale));
      // The curtains' area: from the top of the sky to the foot of the hero.
      const hero = heroRef?.current?.getBoundingClientRect();
      const area = hero ? Math.max(1, Math.min(h, Math.round((hero.bottom - box.top) * scale))) : h;
      if (render && canvas.width === w && canvas.height === h && lastArea === area) return;
      lastArea = area;
      canvas.width = w; canvas.height = h;
      skyCanvas.width = w; skyCanvas.height = h;
      // The curtains' frame: as tall as that area and up to 1.5× as wide on a
      // wide hero; a square on a tall one, a little above the middle.
      const tall = area > w;
      const fh = tall ? w : area;
      const fw = Math.min(w, Math.round(fh * MAX_STRETCH));
      const frame = { x: Math.round((w - fw) / 2), y: tall ? Math.round((area - fh) * TALL_OFFSET) : 0, width: fw, height: fh };
      // No landscape: the sky fades into the page below the hero. The night
      // is drawn once on its own layer; the lights paint on a clear one.
      render = makeAurora(w, h, sound, { landscape: false, sky: false, frame });
      skyCtx.drawImage(render.sky, 0, 0);
    };
    const draw = (time: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    motion.addEventListener('change', paint);
    document.addEventListener('visibilitychange', paint);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(rebuild);
      intersection.disconnect();
      resize.disconnect();
      motion.removeEventListener('change', paint);
      document.removeEventListener('visibilitychange', paint);
    };
  }, [sound, heroRef]);

  return (
    <div className="rays-aurora" aria-hidden="true">
      <canvas ref={skyRef} className="rays-aurora__canvas rays-aurora__sky" />
      <canvas ref={ref} className="rays-aurora__canvas rays-aurora__lights" />
    </div>
  );
};
