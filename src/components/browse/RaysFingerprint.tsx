import React, { useState } from 'react';
import type { TrackRays } from '../../../shared/api/v1';

type Fingerprint = NonNullable<TrackRays['fingerprint']>;
type Axis = keyof Fingerprint['ranks'];

// Driving qualities on the right, soft ones on the left: energy sits opposite acoustic character.
const AXES: Array<{ key: Axis; label: string }> = [
  { key: 'energy', label: 'Energy' },
  { key: 'loudness', label: 'Loudness' },
  { key: 'percussiveness', label: 'Percussion' },
  { key: 'danceability', label: 'Danceability' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'instrumentalness', label: 'Instrumental' },
  { key: 'acousticness', label: 'Acoustic' },
];

const W = 460, H = 400, CX = W / 2, CY = H / 2 + 6, R = 132;
const rankText = (p: number) => (p >= 0.995 ? '99+' : `${Math.round(p * 100)}`);
const angle = (i: number) => -Math.PI / 2 + (i / AXES.length) * Math.PI * 2;
/** A small floor keeps a bottom rank a point on its spoke rather than the centre. */
const at = (i: number, p: number) => {
  const d = R * (0.06 + 0.94 * p);
  return [CX + Math.cos(angle(i)) * d, CY + Math.sin(angle(i)) * d] as const;
};
const shape = (ranks: Fingerprint['ranks']) =>
  AXES.map((a, i) => at(i, ranks[a.key] ?? 0)).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';
const ring = (f: number) => AXES.map((_, i) => at(i, f)).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';

/**
 * The Rays page's radar: where the track ranks in the library on seven
 * qualities (centre: the bottom of the library, rim: the top), over its main
 * genre's average shape and the library's median ring.
 */
export const RaysFingerprint: React.FC<{ fingerprint: Fingerprint; title: string }> = ({ fingerprint, title }) => {
  const [hover, setHover] = useState<number | null>(null);
  const { ranks, genre } = fingerprint;
  const wedge = (i: number) => {
    const a0 = angle(i - 0.5), a1 = angle(i + 0.5), r = R + 46;
    return `M${CX},${CY} L${CX + Math.cos(a0) * r},${CY + Math.sin(a0) * r} A${r},${r} 0 0 1 ${CX + Math.cos(a1) * r},${CY + Math.sin(a1) * r} Z`;
  };
  const summary = AXES.map(a => `${a.label} ${ranks[a.key] === null ? 'not measured' : rankText(ranks[a.key]!)}`).join(', ');

  return (
    <div className="rays-card rays-fingerprint" role="group" aria-labelledby="rays-fingerprint-title">
      <h3 className="rays-card__title" id="rays-fingerprint-title">Fingerprint</h3>
      <p className="rays-card__lede">Where it ranks in your library: the centre is the bottom of the library, the rim the top.</p>
      <ul className="rays-fingerprint__legend" aria-label="Legend">
        <li><span className="rays-fingerprint__key rays-fingerprint__key--track" />This track</li>
        {genre && <li><span className="rays-fingerprint__key rays-fingerprint__key--genre" />{genre.name} average</li>}
        <li><span className="rays-fingerprint__key rays-fingerprint__key--median" />Library median</li>
      </ul>
      <div className="rays-fingerprint__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Library ranks of ${title}: ${summary}.`}>
          {[0.25, 0.5, 0.75, 1].map(f => <path key={f} d={ring(f)} className={f === 0.5 ? 'rays-radar__ring rays-radar__ring--median' : 'rays-radar__ring'} />)}
          {AXES.map((_, i) => <line key={i} x1={CX} y1={CY} x2={CX + Math.cos(angle(i)) * R} y2={CY + Math.sin(angle(i)) * R} className="rays-radar__spoke" />)}
          {genre && <path d={shape(genre.ranks)} className="rays-radar__genre" />}
          <path d={shape(ranks)} className="rays-radar__area" />
          {AXES.map((a, i) => {
            const [x, y] = at(i, ranks[a.key] ?? 0);
            return <circle key={a.key} cx={x} cy={y} r={hover === i ? 6 : 4.5} className="rays-radar__dot" />;
          })}
          {AXES.map((_, i) => (
            <path key={`hit${i}`} d={wedge(i)} className="rays-radar__hit" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
          ))}
        </svg>
        {/* Labels as text over the plot, not inside the SVG: they keep the card's type sizes however wide the plot is drawn. */}
        <div className="rays-radar__labels" aria-hidden="true">
          {AXES.map((a, i) => {
            const lx = CX + Math.cos(angle(i)) * (R + 18), ly = CY + Math.sin(angle(i)) * (R + 18);
            const cos = Math.cos(angle(i));
            const side = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
            const p = ranks[a.key];
            return (
              <span
                key={a.key}
                className={`rays-radar__label rays-radar__label--${side}${hover === i ? ' is-hover' : ''}`}
                style={{ left: `${(lx / W) * 100}%`, top: `${(ly / H) * 100}%` }}
              >
                <span>{a.label}</span>
                <span className="rays-radar__value">{p === null ? '–' : rankText(p)}</span>
              </span>
            );
          })}
        </div>
      </div>
      <p className="rays-fingerprint__readout" aria-live="polite">
        {hover === null ? 'Point at a quality for its rank.' : (() => {
          const a = AXES[hover];
          const p = ranks[a.key], g = genre?.ranks[a.key];
          if (p === null) return `${a.label}: not measured yet.`;
          return `${a.label}: above ${rankText(p)} % of your library${g !== null && g !== undefined && genre ? `; the ${genre.name} average is ${rankText(g)}` : ''}.`;
        })()}
      </p>
    </div>
  );
};
