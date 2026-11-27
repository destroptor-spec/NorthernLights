import React, { useEffect, useMemo, useState } from 'react';
import { useSwipe } from '../../hooks/useSwipe';
import { proxyImageUrl } from '../../utils/externalImagery';

export interface CarouselImage {
    url: string;
    /** What the picture is ("Back", "Booklet"); its alt text. */
    label?: string | null;
}

/**
 * The About card's picture frame: provider images one at a time, crossfading,
 * with dots centred at the frame's foot (one per picture, the current one
 * marked). Swipe on touch screens, arrow keys on the dots. Never advances by
 * itself. A picture that fails to load is dropped; nothing renders when none
 * is left. Styles: `.about-carousel*` in index.css.
 */
export const AboutCarousel: React.FC<{
    images: CarouselImage[];
    /** "Pictures of Daysend": names the carousel for screen readers. */
    label: string;
    /** Wide for an artist's backgrounds, square for an album's artwork. */
    shape: 'wide' | 'square';
    className?: string;
}> = ({ images, label, shape, className = '' }) => {
    const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
    const shown = useMemo(() => images.filter(image => !broken.has(image.url)), [images, broken]);
    const [index, setIndex] = useState(0);
    const count = shown.length;
    const current = count ? Math.min(index, count - 1) : 0;
    useEffect(() => setIndex(0), [images]);

    const go = (next: number) => setIndex((next + count) % count);
    const swipeRef = useSwipe<HTMLDivElement>({
        onSwipeLeft: () => count > 1 && go(current + 1),
        onSwipeRight: () => count > 1 && go(current - 1),
    });

    if (count === 0) return null;

    const onDotsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
        setIndex(next);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    };

    return (
        <div
            ref={swipeRef}
            className={`about-carousel ${className}`}
            data-shape={shape}
            role="group"
            aria-roledescription="carousel"
            aria-label={label}
        >
            {shown.map((image, i) => {
                // The current picture and its neighbours load; the rest wait.
                const near = Math.abs(i - current) <= 1 || (current === 0 && i === count - 1) || (current === count - 1 && i === 0);
                return (
                    <div
                        key={image.url}
                        className="about-carousel__slide"
                        data-active={i === current ? 'true' : undefined}
                        role="group"
                        aria-roledescription="slide"
                        aria-label={`${i + 1} of ${count}`}
                        aria-hidden={i === current ? undefined : true}
                    >
                        {near && (
                            <img
                                src={proxyImageUrl(image.url)}
                                alt={image.label || ''}
                                decoding="async"
                                draggable={false}
                                onError={() => setBroken(prev => new Set(prev).add(image.url))}
                            />
                        )}
                    </div>
                );
            })}
            {count > 1 && (
                <div className="about-carousel__dots" onKeyDown={onDotsKeyDown}>
                    {shown.map((image, i) => (
                        <button
                            key={image.url}
                            type="button"
                            className="about-carousel__dot"
                            aria-label={`Show picture ${i + 1} of ${count}${image.label ? `: ${image.label}` : ''}`}
                            aria-current={i === current ? 'true' : undefined}
                            tabIndex={i === current ? 0 : -1}
                            onClick={() => setIndex(i)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
