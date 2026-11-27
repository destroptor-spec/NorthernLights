import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDominantColor } from '../../hooks/useDominantColor';
import { mostVivid } from '../../utils/vividColor';
import type { TrackInfo } from '../../utils/fileSystem';

// The "About {artist}" and "About {album}" cards: a plain surface lit by the
// picture's own colour, the picture and name at the top, then small-headed
// blocks stacked. With provider pictures (`gallery`, an AboutCarousel) the
// text keeps to a column beside the picture frame (on top on phones).
// Styles: `.about-card*` in index.css.

const sectionTitle = 'font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2';

export const AboutCard: React.FC<{
    /** The section's heading, "About Daysend". */
    title: string;
    name: string;
    /** The line under the name: Group, "Album · Foo Fighters · 2011". */
    kind?: React.ReactNode;
    /** The picture whose colour lights the card. */
    imageUrl?: string;
    /** Round for an artist, square for a cover. */
    shape: 'round' | 'square';
    /** What fills the picture frame. */
    picture: React.ReactNode;
    /** Provider pictures beside the text (an AboutCarousel); none, no frame. */
    gallery?: React.ReactNode;
    className?: string;
    children?: React.ReactNode;
}> = ({ title, name, kind, imageUrl, shape, picture, gallery, className = 'mb-12', children }) => {
    // Its most vivid colour glows behind the picture and washes into the
    // card's corner, as a track's cover lights its rays page. Emerald when
    // the picture has no colour to give.
    const source = useMemo(() => (imageUrl ? [{ artUrl: imageUrl } as TrackInfo] : []), [imageUrl]);
    const { colors } = useDominantColor(source);
    const glow = useMemo(() => mostVivid(colors), [colors]);

    return (
        <section className={className} aria-label={title}>
            <h2 className={sectionTitle}>{title}</h2>
            <div className="about-card" style={glow ? ({ '--about-glow': glow } as React.CSSProperties) : undefined}>
                <div className={gallery ? 'about-card__layout' : undefined}>
                    <div className="about-card__main">
                        <div className="flex items-start gap-4 md:items-center md:gap-5">
                            <div className="about-card__portrait-wrap">
                                <span className="about-card__glow" aria-hidden="true" data-shape={shape} />
                                <div className="about-card__portrait" data-shape={shape}>{picture}</div>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="about-card__name">{name}</p>
                                {kind && <p className="about-card__kind">{kind}</p>}
                            </div>
                        </div>
                        {children}
                    </div>
                    {gallery && <div className="about-card__gallery">{gallery}</div>}
                </div>
            </div>
        </section>
    );
};

/** A block in the card under a small heading. */
export const AboutBlock: React.FC<{ heading: string; children: React.ReactNode }> = ({ heading, children }) => (
    <div className="about-card__block">
        <h3 className="about-card__heading">{heading}</h3>
        {children}
    </div>
);

/**
 * Longer text (a bio, an album's description): collapsed to three lines on a
 * phone and two wider up, fading out over the last; Read more only when there
 * is more. Unmeasured (not laid out yet, or no layout at all), it is offered.
 */
export const CollapsibleText: React.FC<{ text: string }> = ({ text }) => {
    const [expanded, setExpanded] = useState(false);
    useEffect(() => setExpanded(false), [text]);
    const ref = useRef<HTMLParagraphElement>(null);
    const id = useId();
    const [overflows, setOverflows] = useState(true);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || expanded) return;
        const measure = () => setOverflows(el.clientHeight === 0 || el.scrollHeight > el.clientHeight + 1);
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [text, expanded]);

    return (
        <>
            <p
                ref={ref}
                id={id}
                className="about-card__text whitespace-pre-line"
                data-collapsed={expanded ? undefined : 'true'}
                data-faded={!expanded && overflows ? 'true' : undefined}
            >
                {text}
            </p>
            {(overflows || expanded) && (
                <button
                    type="button"
                    onClick={() => setExpanded(!expanded)}
                    aria-expanded={expanded}
                    aria-controls={id}
                    className="about-card__more"
                >
                    {expanded ? 'Show less' : 'Read more'}
                </button>
            )}
        </>
    );
};

/** Tags as pills, every one alike; `title` says where one came from. */
export const TagPills: React.FC<{ tags: Array<{ name: string; title?: string }> }> = ({ tags }) => (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
        {tags.map(tag => (
            <li key={tag.name}>
                <span title={tag.title} className="about-card__tag">{tag.name}</span>
            </li>
        ))}
    </ul>
);
