import { genreAurora } from './GenreCard';

test('every genre name gets two palette hues and an origin on the card', () => {
  // Rock, Pop, Funk / Soul and Blues hash above 2^31: signed shifts left them without a second hue.
  for (const name of ['Rock', 'Pop', 'Funk / Soul', 'Blues', 'Electronic', 'Jazz', 'Classical', 'Folk, World, & Country']) {
    const style = genreAurora(name) as Record<string, string>;
    expect(style['--g-1']).toMatch(/^var\(--aurora-/);
    expect(style['--g-2']).toMatch(/^var\(--aurora-/);
    for (const key of ['--g-ox', '--g-oy']) {
      const value = parseFloat(style[key]);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  }
});
