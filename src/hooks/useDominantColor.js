import { useColor } from 'color-thief-react';
const FALLBACK_COLOR = 'var(--color-primary)';
export const useDominantColor = (tracks, options) => {
    const artUrls = Array.from(new Set(tracks.map(t => t.artUrl).filter(Boolean))).slice(0, 4);
    const primaryArt = artUrls[0] || '';
    const { data: dominantColor } = useColor(primaryArt, 'hex', {
        crossOrigin: options?.crossOrigin ?? 'Anonymous',
        quality: options?.quality ?? 10,
    });
    const bgColor = dominantColor || FALLBACK_COLOR;
    return { artUrls, primaryArt, bgColor };
};
