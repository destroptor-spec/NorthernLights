import { useState, useEffect } from 'react';
import { TrackInfo } from '../utils/fileSystem';

const FALLBACK_COLOR = 'var(--color-primary)';

function extractDominantColor(imageUrl: string, quality: number = 10): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));

      const size = Math.min(img.width, 64);
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(img, 0, 0, size, size);

      const { data } = ctx.getImageData(0, 0, size, size);
      const colorCounts: Record<string, number> = {};

      for (let i = 0; i < data.length; i += 4 * quality) {
        const r = Math.round(data[i] / 16) * 16;
        const g = Math.round(data[i + 1] / 16) * 16;
        const b = Math.round(data[i + 2] / 16) * 16;
        const key = `${r},${g},${b}`;
        colorCounts[key] = (colorCounts[key] || 0) + 1;
      }

      let maxCount = 0;
      let dominant = '0,0,0';
      for (const [key, count] of Object.entries(colorCounts)) {
        if (count > maxCount) {
          maxCount = count;
          dominant = key;
        }
      }

      const [r, g, b] = dominant.split(',').map(Number);
      resolve(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
}

export const useDominantColor = (tracks: TrackInfo[], options?: { crossOrigin?: string; quality?: number }) => {
  const artUrls = Array.from(new Set(tracks.map(t => t.artUrl).filter(Boolean) as string[])).slice(0, 4);
  const primaryArt = artUrls[0] || '';
  const [bgColor, setBgColor] = useState<string>(FALLBACK_COLOR);

  useEffect(() => {
    if (!primaryArt) {
      setBgColor(FALLBACK_COLOR);
      return;
    }

    let cancelled = false;
    extractDominantColor(primaryArt, options?.quality ?? 10)
      .then(color => { if (!cancelled) setBgColor(color); })
      .catch(() => { if (!cancelled) setBgColor(FALLBACK_COLOR); });

    return () => { cancelled = true; };
  }, [primaryArt, options?.quality]);

  return { artUrls, primaryArt, bgColor };
};
