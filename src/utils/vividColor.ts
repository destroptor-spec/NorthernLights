// A picture's own light, for glows that take their colour from album art or
// an artist's portrait (a track's rays, the artist page's About card).

/**
 * The picture's colour with the most light in it: saturation weighted towards
 * mid lightness, so neither near-black nor near-white wins. Undefined when
 * the picture has no colour worth glowing (the CSS falls back to emerald).
 */
export function mostVivid(hexes: string[]): string | undefined {
  let best: { hex: string; score: number } | undefined;
  for (const hex of hexes) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map(v => parseInt(v, 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const chroma = max - min;
    const score = chroma * (1 - Math.abs(2 * lightness - 1) * 0.6);
    if (!best || score > best.score) best = { hex, score };
  }
  return best && best.score >= 0.12 ? best.hex : undefined;
}
