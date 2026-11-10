import { blendStyleVectors, engineOf, styleBeta, styleCosine, type StyleVector } from './styleOverlap.service';

const v = (entries: Record<string, number>): StyleVector => {
  const m = new Map(Object.entries(entries));
  const n = Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0));
  for (const [k, x] of m) m.set(k, x / n);
  return m;
};

test('cosine of style vectors: shared styles count, labels alone do not', () => {
  expect(styleCosine(v({ s1: 1 }), v({ s1: 1 }))).toBeCloseTo(1);
  expect(styleCosine(v({ s1: 1 }), v({ s2: 1 }))).toBe(0);
  // A track with many labels gains nothing for having them.
  expect(styleCosine(v({ s1: 1 }), v({ s1: 1, s2: 1, s3: 1, s4: 1 }))).toBeCloseTo(0.5);
  expect(styleCosine(null, v({ s1: 1 }))).toBe(0);
});

test('a run of seeds blends towards the newest, like the acoustic centroid', () => {
  const blended = blendStyleVectors([v({ s1: 1 }), null, v({ s2: 1 })])!;
  expect(blended.get('s2')!).toBeGreaterThan(blended.get('s1')!);
  expect(Math.hypot(...blended.values())).toBeCloseTo(1);
  expect(blendStyleVectors([null, undefined])).toBeNull();
});

test('genre strictness sets beta, from 0 to 0.2; the classic engine stays the default', () => {
  expect(styleBeta(0)).toBe(0);
  expect(styleBeta(50)).toBeCloseTo(0.1);
  expect(styleBeta(100)).toBeCloseTo(0.2);
  expect(styleBeta(250)).toBeCloseTo(0.2);
  expect(engineOf('styles')).toBe('styles');
  expect(engineOf(undefined)).toBe('classic');
  expect(engineOf('nonsense')).toBe('classic');
});
