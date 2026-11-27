/**
 * @jest-environment node
 */
import { fitPrincipalComponents } from './soundMap.service';
import { rankIn } from './libraryRanks.service';

jest.mock('../database', () => ({}));

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

test('fits the direction the points spread along most, then the next one at right angles', async () => {
  // Points spread widely along (1, 1, 0) and a little along (0, 0, 1).
  const rows: number[][] = [];
  for (let i = -20; i <= 20; i++) for (const z of [-1, 1]) rows.push([i * 0.5, i * 0.5, z * 0.2]);
  const [first, second] = await fitPrincipalComponents(rows, 2, 80);
  expect(Math.abs(dot(first, [Math.SQRT1_2, Math.SQRT1_2, 0]))).toBeCloseTo(1, 4);
  expect(Math.abs(dot(second, [0, 0, 1]))).toBeCloseTo(1, 4);
  expect(Math.abs(dot(first, second))).toBeLessThan(1e-6);
});

test('needs a few points before it fits anything', async () => {
  expect(await fitPrincipalComponents([[1, 0], [0, 1]], 2)).toEqual([]);
});

test('ranks a value by the share of the library strictly below it', () => {
  const sorted = [0.1, 0.2, 0.2, 0.5, 0.9];
  expect(rankIn(sorted, 0.05)).toBe(0);
  expect(rankIn(sorted, 0.2)).toBe(0.2);
  expect(rankIn(sorted, 0.3)).toBe(0.6);
  expect(rankIn(sorted, 1)).toBe(1);
  expect(rankIn([], 0.5)).toBe(0);
});
