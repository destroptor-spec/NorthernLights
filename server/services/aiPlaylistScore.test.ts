import { artistCap, conceptMatch, distanceSpread, rankByScore, scoreBeta, targetWeight } from './aiPlaylistScore.service';

test('targets weigh 1, 0.9, 0.8, then 0.7', () => {
  expect([0, 1, 2, 3, 6].map(targetWeight)).toEqual([1, 0.9, 0.8, 0.7, 0.7]);
});

test('a track matches by its best membership, weight times strength', () => {
  const concept = new Map([['s1', 1], ['s2', 0.9], ['gElectronic', 0.5]]);
  expect(conceptMatch(concept, new Map([['s1', 1], ['gElectronic', 1]]))).toBe(1);
  // Tagged only "Dance": the genre, not the style.
  expect(conceptMatch(concept, new Map([['gElectronic', 1]]))).toBe(0.5);
  // A weak sound guess counts for little.
  expect(conceptMatch(concept, new Map([['s2', 0.15]]))).toBeCloseTo(0.135);
  expect(conceptMatch(concept, new Map([['s9', 1]]))).toBe(0);
  expect(conceptMatch(concept, undefined)).toBe(0);
});

test('β follows Genre Cohesion and how much of the concept the library has', () => {
  expect(scoreBeta(0.5, 200, 20)).toBeCloseTo(2);
  expect(scoreBeta(0.5, 40, 20)).toBeCloseTo(1);
  expect(scoreBeta(0, 200, 20)).toBe(0);
  expect(scoreBeta(1, 0, 20)).toBe(0);
});

test('distances are measured in the spread from p10 to p90, never below 0.02', () => {
  expect(distanceSpread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ low: 1, spread: 8 });
  expect(distanceSpread([0.5, 0.5, 0.5]).spread).toBe(0.02);
});

test('a strong match overtakes closer-sounding tracks; without cohesion sound alone decides', () => {
  const rows = [
    { id: 'near', distance: 0.40, novelty_boost: 0 },
    { id: 'mid', distance: 0.45, novelty_boost: 0 },
    { id: 'styled', distance: 0.50, novelty_boost: 0 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `far${i}`, distance: 0.6 + i * 0.01, novelty_boost: 0 })),
  ];
  const match = (r: { id: string }) => (r.id === 'styled' ? 1 : 0);
  expect(rankByScore(rows, { match, beta: 2, nu: 0 })[0].id).toBe('styled');
  expect(rankByScore(rows, { match, beta: 0, nu: 0 })[0].id).toBe('near');
});

test('the novelty bonus moves a track at most half a spread', () => {
  const rows = [
    { id: 'played', distance: 0.40, novelty_boost: 0 },
    { id: 'fresh', distance: 0.42, novelty_boost: 0.24 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `far${i}`, distance: 0.5 + i * 0.1, novelty_boost: 0 })),
  ];
  const ranked = rankByScore(rows, { match: () => 0, beta: 0, nu: 1 });
  expect(ranked[0].id).toBe('fresh');
  const played = ranked.find(r => r.id === 'played')!;
  const fresh = ranked.find(r => r.id === 'fresh')!;
  expect(played.score - fresh.score).toBeLessThanOrEqual(0.5);
});

test('few fitting artists may each bring more tracks', () => {
  expect(artistCap(20, 30, 0.7)).toBe(2);
  expect(artistCap(20, 8, 0.7)).toBe(3);
  expect(artistCap(10, 30, 0.9)).toBe(1);
});

test('the sound target blends the styles\' sound and the AI\'s, each normalised', () => {
  const { blendEmbeddings } = jest.requireActual('./aiPlaylistScore.service') as typeof import('./aiPlaylistScore.service');
  const mixed = JSON.parse(blendEmbeddings('[2,0]', '[0,5]')!) as number[];
  expect(mixed[0]).toBeCloseTo(Math.SQRT1_2);
  expect(mixed[1]).toBeCloseTo(Math.SQRT1_2);
  expect(blendEmbeddings(null, '[0,1]')).toBe('[0,1]');
  expect(blendEmbeddings('[1,0]', null)).toBe('[1,0]');
});

test('focus: a mood request lets style count half as much and leans to the AI\'s sound', () => {
  const { focusOf, scoreBeta: beta, styleSoundShare } = jest.requireActual('./aiPlaylistScore.service') as typeof import('./aiPlaylistScore.service');
  expect(focusOf(0.1)).toBe(0.1);
  expect(focusOf(3)).toBe(1);
  expect(focusOf(undefined)).toBe(0.6);
  expect(focusOf('x')).toBe(0.6);
  expect(beta(0.5, 200, 20, 1)).toBeCloseTo(2);
  expect(beta(0.5, 200, 20, 0)).toBeCloseTo(1);
  expect(styleSoundShare(0.6)).toBeCloseTo(0.56);
  expect(styleSoundShare(0)).toBeCloseTo(0.35);
  expect(styleSoundShare(1)).toBeCloseTo(0.7);
});

test('moods from the sound: the AI\'s target, the fit, and a weight that grows as the request turns to mood', () => {
  const { moodTargetOf, moodMatch, moodBeta } = jest.requireActual('./aiPlaylistScore.service') as typeof import('./aiPlaylistScore.service');
  expect(moodTargetOf({ sad: 0.8, relaxed: 2, party: 'x', loud: 1 })).toEqual({ sad: 0.8, relaxed: 1 });
  expect(moodTargetOf({})).toBeNull();
  expect(moodTargetOf(undefined)).toBeNull();
  const rainy = { sad: 0.8, relaxed: 0.8, party: 0.1 };
  const ballad = { happy: 0.01, sad: 0.99, relaxed: 1, aggressive: 0, party: 0 };
  const banger = { happy: 0.6, sad: 0.05, relaxed: 0.1, aggressive: 0.4, party: 0.95 };
  expect(moodMatch(rainy, ballad)).toBeGreaterThan(0.8);
  expect(moodMatch(rainy, banger)).toBeLessThan(0.25);
  expect(moodMatch(null, ballad)).toBe(0);
  expect(moodMatch(rainy, undefined)).toBe(0);
  expect(moodBeta(0, true)).toBeCloseTo(1.25);
  expect(moodBeta(1, true)).toBeCloseTo(0.3125);
  expect(moodBeta(0, false)).toBe(0);
});

test('a mood request loosens to the nearest styles, not the whole genre', () => {
  const { neighbourCount, neighbourWeight } = jest.requireActual('./aiPlaylistScore.service') as typeof import('./aiPlaylistScore.service');
  expect(neighbourCount(1)).toBe(3);
  expect(neighbourCount(0.4)).toBe(5);
  expect(neighbourCount(0)).toBe(6);
  expect(neighbourWeight(0.5, 1)).toBeCloseTo(0.25);
  expect(neighbourWeight(0.5, 0.4)).toBeCloseTo(0.49);
  expect(neighbourWeight(1, 0)).toBeCloseTo(0.8);
  expect(neighbourWeight(0, 1)).toBe(0);
});

test('with style targets, mood picks among tracks of the concept instead of replacing them', () => {
  const rows = [
    { id: 'indie-upbeat', distance: 0.5, novelty_boost: 0 },
    { id: 'classic-rock-moody', distance: 0.5, novelty_boost: 0 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `far${i}`, distance: 0.6 + i * 0.05, novelty_boost: 0 })),
  ];
  const match = (r: { id: string }) => (r.id === 'indie-upbeat' ? 1 : r.id === 'classic-rock-moody' ? 0.5 : 0);
  const mood = (r: { id: string }) => (r.id === 'classic-rock-moody' ? 1 : 0.4);
  const ungated = rankByScore(rows, { match, mood, moodBeta: 2.5, beta: 1, nu: 0 });
  const gated = rankByScore(rows, { match, mood, moodBeta: 1.25, moodGate: true, beta: 1, nu: 0 });
  expect(ungated[0].id).toBe('classic-rock-moody');
  expect(gated[0].id).toBe('indie-upbeat');
});
