import React, { useCallback, useMemo } from 'react';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchGenreImage } from '../../utils/externalImagery';
import { useInView } from '../../hooks/useInView';

// A genre owns no cover of its own, so each is given a deterministic aurora
// signature derived from its name: two hues drawn only from the brand spectrum,
// a bloom angle, and a bloom origin. Same genre always glows the same way, so it
// becomes recognizable across visits; no two genres read alike, so the wall of
// genres stops being an identical card grid. ~1 in 11 earns the rare red-shift.
const AURORA_HUES = [
    'var(--aurora-green)',
    'var(--aurora-teal)',
    'var(--aurora-blue)',
    'var(--aurora-extra-glow)',
];

// The hash is unsigned; shifts must be too (>>>), or half of all names get a
// negative index: no second hue (an invalid gradient) and off-card origins.
export function genreAurora(name: string): React.CSSProperties {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
    }
    return {
        '--g-1': AURORA_HUES[h % AURORA_HUES.length],
        '--g-2': h % 11 === 0
            ? 'var(--aurora-pink)'
            : AURORA_HUES[(h >>> 4) % AURORA_HUES.length],
        '--g-angle': `${h % 360}deg`,
        '--g-ox': `${22 + ((h >>> 9) % 56)}%`,
        '--g-oy': `${18 + ((h >>> 16) % 50)}%`,
    } as React.CSSProperties;
}

/** A square aurora cover with the genre name below (Library → Genres). */
export const GenreCard: React.FC<{ genre: string }> = ({ genre }) => {
    const [ref, inView] = useInView();
    const { imageUrl } = useExternalImage(() => fetchGenreImage(genre), [genre], { enabled: inView });
    const aurora = useMemo(() => genreAurora(genre), [genre]);

    // The bloom follows the pointer over the cover. Writing CSS custom properties
    // (never layout properties) keeps this off the main-thread layout path.
    // Skipped on touch, where there is no hover and the move only fires mid-scroll.
    const trackPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.pointerType === 'touch') return;
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--gx', `${((e.clientX - r.left) / r.width) * 100}%`);
        el.style.setProperty('--gy', `${((e.clientY - r.top) / r.height) * 100}%`);
    }, []);

    const resetPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.style.removeProperty('--gx');
        e.currentTarget.style.removeProperty('--gy');
    }, []);

    return (
        <div ref={ref} className="genre-card">
            <div
                className="genre-card__cover"
                style={aurora}
                onPointerMove={trackPointer}
                onPointerLeave={resetPointer}
            >
                {imageUrl && <img src={imageUrl} alt="" aria-hidden="true" className="genre-card__art" />}
                <span className="genre-card__aurora" aria-hidden="true" />
                <span className="genre-card__ribbon" aria-hidden="true" />
            </div>
            <p className="genre-card__label">{genre}</p>
        </div>
    );
};

