import React, { useEffect, useRef } from 'react';
import { makeAurora, type AuroraSound } from '../../utils/auroraSignature';

/** The aurora is a soft backdrop: its square is drawn at most this many pixels a side, then scaled by CSS. */
const MAX_SIDE = 1200;
/** The sky's height against its width: tall enough for the curtains to keep the demo tiles' sweep. */
const SKY_ASPECT = 0.75;
/** Where the curtains gather in that sky (share of its height): the window is centred here. */
const CURTAIN_CENTRE = 0.47;

/**
 * The track's aurora signature behind the Rays hero. The renderer scales its
 * curtains with the canvas, so a wide, short hero would flatten them into
 * bands; instead the sky is drawn square (as wide as the hero, or taller
 * where the hero is) and the hero shows a window through it, centred on the
 * curtains. It drifts only while on screen, the tab is visible and reduced
 * motion is off; otherwise it holds one still frame. Rebuilt (debounced)
 * when its size changes.
 */
export const RaysAurora: React.FC<{ sound: AuroraSound }> = ({ sound }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let rebuild = 0;
    let visible = false;
    let render: ReturnType<typeof makeAurora> | undefined;
    let offset = 0;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const size = () => {
      const box = canvas.getBoundingClientRect();
      const side = Math.max(box.width, box.height);
      const scale = Math.min(1, MAX_SIDE / Math.max(1, side));
      const w = Math.max(1, Math.round(box.width * scale)), h = Math.max(1, Math.round(box.height * scale));
      if (render && canvas.width === w && canvas.height === h) return;
      canvas.width = w; canvas.height = h;
      const sky = Math.max(h, Math.round(w * SKY_ASPECT));
      offset = Math.round(Math.min(Math.max(0, sky * CURTAIN_CENTRE - h / 2), sky - h));
      // No landscape: the sky fades into the page below the hero.
      render = makeAurora(w, sky, sound, { landscape: false });
    };
    const draw = (time: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, -offset);
      render?.(ctx, time);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  }, [sound]);

  return (
    <div className="rays-aurora" aria-hidden="true">
      <canvas ref={ref} className="rays-aurora__canvas" />
    </div>
  );
};
