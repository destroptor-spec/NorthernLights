/** @jest-environment node */
import { analysisWorkerCount } from './analysisResources';

test('explicit process selections are independent of CPU count and native threads', () => {
  const previous = process.env.AURORA_ANALYSIS_THREADS;
  process.env.AURORA_ANALYSIS_THREADS = '2';
  try {
    expect(analysisWorkerCount('Intensive', 16)).toBe(16);
    expect(analysisWorkerCount('Intensive', 8)).toBe(16);
    expect(analysisWorkerCount('Maximum', 16)).toBe(16);
    process.env.AURORA_ANALYSIS_THREADS = '4';
    expect(analysisWorkerCount('Maximum', 32)).toBe(32);
    expect(analysisWorkerCount('Intensive', 16)).toBe(16);
  } finally {
    if (previous === undefined) delete process.env.AURORA_ANALYSIS_THREADS;
    else process.env.AURORA_ANALYSIS_THREADS = previous;
  }
});

test('preserves smaller presets and the default fallback', () => {
  expect(analysisWorkerCount('Background', 16)).toBe(1);
  expect(analysisWorkerCount('Balanced', 16)).toBe(4);
  expect(analysisWorkerCount('Performance', 16)).toBe(8);
  expect(analysisWorkerCount(undefined, 16)).toBe(4);
  expect(analysisWorkerCount('unknown', 16)).toBe(4);
});
