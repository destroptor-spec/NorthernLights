/** @jest-environment node */
import { chooseMix, mixSize, type MixCandidate } from './browse.service';

// A fixed sequence, so the "random" draw is the same every run.
const seeded = (seed = 7) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

describe('Shuffle mix', () => {
  test('starts with a quarter of a genre or style, 15 to 30 tracks; a small one plays whole', () => {
    expect(mixSize(0)).toBe(0);
    expect(mixSize(9)).toBe(9);
    expect(mixSize(15)).toBe(15);
    expect(mixSize(40)).toBe(15);
    expect(mixSize(100)).toBe(25);
    expect(mixSize(439)).toBe(30);
    expect(mixSize(9734)).toBe(30);
  });

  test('takes at most 2 tracks per artist and never plays one artist twice in a row when it can avoid it', () => {
    const candidates: MixCandidate[] = [];
    for (let a = 0; a < 20; a++) for (let t = 0; t < 10; t++) candidates.push({ trackId: `a${a}-t${t}`, artist: `a${a}` });
    const mix = chooseMix(candidates, 30, seeded());
    expect(mix).toHaveLength(30);
    expect(new Set(mix).size).toBe(30);
    const artistOf = (id: string) => id.split('-')[0];
    const perArtist = new Map<string, number>();
    for (const id of mix) perArtist.set(artistOf(id), (perArtist.get(artistOf(id)) || 0) + 1);
    expect(Math.max(...perArtist.values())).toBeLessThanOrEqual(2);
    for (let i = 1; i < mix.length; i++) expect(artistOf(mix[i])).not.toBe(artistOf(mix[i - 1]));
  });

  test('relaxes the per-artist limit only when there are too few artists to fill the mix', () => {
    const candidates: MixCandidate[] = [];
    for (let a = 0; a < 3; a++) for (let t = 0; t < 10; t++) candidates.push({ trackId: `a${a}-t${t}`, artist: `a${a}` });
    expect(chooseMix(candidates, 15, seeded())).toHaveLength(15);
  });

  test('a different draw gives a different mix', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({ trackId: `t${i}`, artist: `a${i}` }));
    expect(chooseMix(candidates, 25, seeded(1))).not.toEqual(chooseMix(candidates, 25, seeded(2)));
  });
});

test('spreads a dominant artist through the mix instead of piling them up at the end', () => {
  // Glitch on dev: Pretty Lights has most of it.
  const candidates: MixCandidate[] = [
    ...Array.from({ length: 12 }, (_, i) => ({ trackId: `pl${i}`, artist: 'Pretty Lights' })),
    ...Array.from({ length: 6 }, (_, i) => ({ trackId: `o${i}`, artist: `other${i}` })),
  ];
  for (let seed = 1; seed <= 20; seed++) {
    const mix = chooseMix(candidates, 15, seeded(seed));
    const artists = mix.map(id => (id.startsWith('pl') ? 'Pretty Lights' : id));
    const repeats = artists.filter((a, i) => i > 0 && a === artists[i - 1]).length;
    // 15 tracks with at most 6 others means Pretty Lights plays 9 times;
    // 6 others can separate 7 of them, so at most 2 back-to-back pairs.
    expect(repeats).toBeLessThanOrEqual(2);
  }
});
