import React, { useEffect, useRef } from 'react';
import { makeAurora, type AuroraSound } from '../../utils/auroraSignature';

/** The aurora is a soft backdrop: drawn at most this wide and at 1×, then scaled by CSS. */
const MAX_WIDTH = 1600;

/**
 * The track's aurora signature behind the Rays hero. It drifts only while on
 * screen, the tab is visible and reduced motion is off; otherwise it holds one
 * still frame. Rebuilt (debounced) when its size changes.
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
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const size = () => {
      const box = canvas.getBoundingClientRect();
      const scale = Math.min(1, MAX_WIDTH / Math.max(1, box.width));
      const w = Math.max(1, Math.round(box.width * scale)), h = Math.max(1, Math.round(box.height * scale));
      if (render && canvas.width === w && canvas.height === h) return;
      canvas.width = w; canvas.height = h;
      // No landscape: the sky fades into the page below the hero.
      render = makeAurora(w, h, sound, { landscape: false });
    };
    const tick = (now: number) => {
      render?.(ctx, now / 1000);
      raf = requestAnimationFrame(tick);
    };
    const paint = () => {
      cancelAnimationFrame(raf);
      if (visible && !motion.matches && !document.hidden) raf = requestAnimationFrame(tick);
      else render?.(ctx, 1.2);
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
