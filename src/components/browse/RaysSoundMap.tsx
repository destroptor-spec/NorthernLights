import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchSoundMap, raysPath } from '../../api/browse';
import { usePlayerStore } from '../../store/index';
import { coverUrlFor } from './browseParts';
import type { SoundMap, TrackRays } from '../../../shared/api/v1';

type NearTrack = NonNullable<TrackRays['soundsCloseTo']>['tracks'][number];

let cachedMap: SoundMap | null = null;
let inflight: Promise<SoundMap> | null = null;

/** The map's backdrop, fetched once per session; while the first map is being made, asked again a few times. */
function useSoundMap(): SoundMap | null {
  const [map, setMap] = useState<SoundMap | null>(cachedMap?.status === 'ready' ? cachedMap : null);
  useEffect(() => {
    if (map) return;
    let cancelled = false;
    let timer = 0;
    let tries = 0;
    const load = () => {
      inflight ??= fetchSoundMap(usePlayerStore.getState().getAuthHeader()).finally(() => { inflight = null; });
      inflight.then(result => {
        if (cancelled) return;
        if (result.status === 'ready') { cachedMap = result; setMap(result); }
        else if (result.status === 'building' && ++tries < 10) timer = window.setTimeout(load, 8000);
      }).catch(() => { /* the section stays hidden */ });
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [map]);
  return map;
}

/**
 * The view: centred on the track, wide enough for every neighbour, never
 * closer than a slice of the whole map. Neighbours stay inside the band's
 * solid middle, clear of its fading edges (more room across than down).
 */
function viewFor(map: SoundMap, centre: { x: number; y: number }, near: Array<{ x: number; y: number }>, aspect: number) {
  const q = (values: number[], f: number) => [...values].sort((a, b) => a - b)[Math.floor(f * (values.length - 1))] ?? 0;
  const xs = map.points.map(p => p[0]), ys = map.points.map(p => p[1]);
  const span = Math.max(q(xs, 0.99) - q(xs, 0.01), q(ys, 0.99) - q(ys, 0.01), 1e-6);
  let half = span * 0.16;
  for (const p of near) half = Math.max(half, Math.abs(p.x - centre.x) / (0.8 * aspect), Math.abs(p.y - centre.y) / 0.6);
  half = Math.min(half, span * 0.8);
  return { halfX: half * aspect, halfY: half };
}

const NIGHT_TOP = '#060c21', NIGHT_BOTTOM = '#142339';

/** A cover that falls back to a plain tile when it has none or it fails to load. */
const SkyArt: React.FC<{ src: string | undefined; className: string; lazy?: boolean }> = ({ src, className, lazy = false }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className={className} />;
  return <img src={src} alt="" loading={lazy ? 'lazy' : undefined} onError={() => setFailed(true)} />;
};

/**
 * Your library as a night sky (the Rays page): every analysed track placed by
 * its sound (the sound map), this track's cover in the middle and lines to the
 * tracks that sound closest. A star shows its cover and name on hover or focus
 * and opens that track's rays.
 */
export const RaysSoundMap: React.FC<{
  position: NonNullable<TrackRays['soundMap']>;
  cover: string | undefined;
  title: string;
  near: NearTrack[];
}> = ({ position, cover, title, near }) => {
  const map = useSoundMap();
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  const stars = useMemo(() => {
    const byId = new Map(near.map(t => [t.id, t]));
    return position.near.filter(p => byId.has(p.trackId)).map(p => ({ ...p, track: byId.get(p.trackId)! }));
  }, [position, near]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);

  // Not measured yet (0 × 0 before layout): no view, so nothing is placed at an infinite offset.
  const view = useMemo(() => (map && box && box.w > 0 && box.h > 0 ? viewFor(map, position, stars, box.w / box.h) : null), [map, box, position, stars]);
  const at = (x: number, y: number) => view ? {
    left: 50 + ((x - position.x) / view.halfX) * 50,
    top: 50 - ((y - position.y) / view.halfY) * 50,
  } : { left: 50, top: 50 };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || !map || !box || !view) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(box.w * dpr); el.height = Math.round(box.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, box.w * 0.13, box.h);
    sky.addColorStop(0, NIGHT_TOP); sky.addColorStop(1, NIGHT_BOTTOM);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, box.w, box.h);
    const px = (x: number) => box.w / 2 + ((x - position.x) / view.halfX) * (box.w / 2);
    const py = (y: number) => box.h / 2 - ((y - position.y) / view.halfY) * (box.h / 2);
    map.points.forEach(([x, y], i) => {
      const sx = px(x), sy = py(y);
      if (sx < -2 || sy < -2 || sx > box.w + 2 || sy > box.h + 2) return;
      // A steady, uneven brightness per star, so the sky isn't a uniform dot screen.
      const twinkle = ((i * 2654435761) >>> 0) / 4294967296;
      ctx.fillStyle = `rgba(221, 232, 255, ${0.22 + twinkle * 0.5})`;
      ctx.beginPath(); ctx.arc(sx, sy, twinkle > 0.92 ? 1.6 : 1.1, 0, Math.PI * 2); ctx.fill();
    });
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim() || 'sans-serif';
    ctx.font = `600 12px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(214, 224, 245, 0.72)';
    for (const label of map.labels) {
      const sx = px(label.x), sy = py(label.y);
      if (sx < 40 || sx > box.w - 40 || sy < 16 || sy > box.h - 10) continue;
      ctx.fillText(label.genre, sx, sy);
    }
  }, [map, box, view, position]);

  if (!map) return null;
  return (
    <section className="browse-section" aria-label="Your library as a night sky">
      <h2 className="browse-section__title">Your library as a night sky</h2>
      <p className="browse-section__lede">Your tracks placed by how they sound. {title} is in the middle, with lines to the tracks that sound closest to it.</p>
      <div className="rays-sky" ref={frame}>
        <canvas ref={canvas} className="rays-sky__canvas" role="img" aria-label={`A map of ${map.trackCount.toLocaleString()} tracks by sound, centred on ${title}`} />
        <svg className="rays-sky__lines" aria-hidden="true">
          {view && stars.map(s => {
            const p = at(s.x, s.y);
            return <line key={s.trackId} x1="50%" y1="50%" x2={`${p.left}%`} y2={`${p.top}%`} />;
          })}
        </svg>
        <ul className="rays-sky__stars" aria-label="Tracks that sound closest">
          {view && stars.map(s => {
            const p = at(s.x, s.y);
            const art = coverUrlFor(s.track.artworkId) || s.track.artworkUrl || undefined;
            return (
              <li key={s.trackId} className={p.top < 30 ? 'rays-sky__star is-low' : 'rays-sky__star'} style={{ left: `${p.left}%`, top: `${p.top}%` }}>
                <Link to={raysPath(s.trackId)} className="rays-sky__dot" aria-label={`${s.track.title} by ${s.track.artist}`}>
                  <span className="rays-sky__card" aria-hidden="true">
                    <SkyArt src={art} className="rays-sky__card-art" lazy />
                    <span className="rays-sky__card-text">
                      <span className="rays-sky__card-title">{s.track.title}</span>
                      <span className="rays-sky__card-artist">{s.track.artist}</span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="rays-sky__here" aria-hidden="true">
          <SkyArt src={cover} className="rays-sky__here-blank" />
        </div>
      </div>
      <p className="rays-sky__note">
        {map.trackCount.toLocaleString()} tracks, with a sample of {map.points.length.toLocaleString()} drawn. The map flattens each track's sound onto two dimensions, so a few close matches land further out than they sound.
      </p>
    </section>
  );
};
