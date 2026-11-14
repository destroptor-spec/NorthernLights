/** @jest-environment node */
jest.mock('../utils/db', () => ({ queryWithRetry: jest.fn() }));
jest.mock('../database', () => ({ ...jest.requireActual('../database'), initDB: jest.fn(async () => ({})) }));
jest.mock('./styleOverlap.service', () => ({
  ...jest.requireActual('./styleOverlap.service'),
  seedStyleVector: jest.fn(async () => new Map([['s1', 1]])),
  styleVectors: jest.fn(async () => new Map([['styled', new Map([['s1', 1]])]])),
}));
import { queryWithRetry } from '../utils/db';
import { calculateNextInfinityTrack } from './recommendation.service';
import { seedStyleVector } from './styleOverlap.service';

const embedding = JSON.stringify([1, ...Array(1279).fill(0)]);
const acoustic = (energy: number) => JSON.stringify([energy, 0.1, 0.1, 0.5, 0.1, 0.1, 0.1, 0.6]);
let seeds: Array<{ id: string; acoustic_vector_8d: string; embedding_vector: string; feature_version: number }>;
let candidates: Array<{ id: string; title: string; artist: string; distance: number }>;
let fallback: Array<{ id: string; title: string; artist: string }>;
beforeEach(() => {
  seeds = [
    { id: 'old', acoustic_vector_8d: acoustic(1), embedding_vector: embedding, feature_version: 1 },
    { id: 'new', acoustic_vector_8d: acoustic(0.7), embedding_vector: embedding, feature_version: 2 },
  ];
  candidates = [{ id: 'fresh', title: 'Fresh', artist: 'Artist', distance: 0.1 }];
  fallback = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.mocked(queryWithRetry).mockReset().mockImplementation(async sql => {
    let rows: unknown[] = [];
    if (sql.includes('COUNT(*)')) rows = [{ count: '28000' }];
    else if (sql.includes('SELECT t.id, tf.acoustic_vector_8d')) rows = seeds;
    else if (sql.includes('SELECT id, title')) rows = [{ id: 'new', title: 'Heard', artist: 'Artist' }];
    else if (sql.includes('AS distance')) rows = candidates;
    else if (sql.includes('OFFSET')) rows = fallback;
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as Awaited<ReturnType<typeof queryWithRetry>>;
  });
});
afterEach(() => jest.restoreAllMocks());

test.each([['old', 'new', 2, 0.7], ['new', 'old', 1, 1]] as const)('centroids and candidates use the newest seed version: %s -> %s', async (first, last, version, energy) => {
  await calculateNextInfinityTrack([first, last], {}, { excludeTrackIds: ['queued'] });
  const [sql, values] = jest.mocked(queryWithRetry).mock.calls.find(([sql]) => sql.includes('AS distance'))!;
  expect(JSON.parse(values![0])[0]).toBeCloseTo(energy);
  expect(values!.at(-1)).toBe(version);
  expect(sql).toContain('tf.feature_version =');
  expect(values).toEqual(expect.arrayContaining(['old', 'new', 'queued']));
  // Both centroids come from the same feature read, avoiding a version race.
  expect(jest.mocked(queryWithRetry).mock.calls.filter(([sql]) => sql.includes('SELECT t.id, tf.'))).toHaveLength(1);
});

test('fallback keeps exact-id exclusions and rejects remastered copies of recently heard songs', async () => {
  candidates = [];
  fallback = [{ id: 'remaster', title: 'Heard (Remastered)', artist: 'Artist' }, { id: 'fresh', title: 'Fresh', artist: 'Other' }];
  const result = await calculateNextInfinityTrack(['old', 'new'], { artistAmnesiaLimit: 0 }, { excludeTrackIds: ['queued'] });
  expect(result?.id).toBe('fresh');
  const [sql, values] = jest.mocked(queryWithRetry).mock.calls.find(([sql]) => sql.includes('OFFSET'))!;
  expect(sql).toContain('NOT (t.id = ANY($1::text[]))');
  expect(values![0]).toEqual(expect.arrayContaining(['old', 'new', 'queued']));
  for (const [, values] of jest.mocked(queryWithRetry).mock.calls.filter(([sql]) => sql.includes('AS distance'))) {
    expect(values).toEqual(expect.arrayContaining(['old', 'new', 'queued']));
  }
});

test('exhausted library returns no track instead of repeating a queued or heard song', async () => {
  candidates = [];
  fallback = [{ id: 'remaster', title: 'Heard (Remastered)', artist: 'Artist' }];
  await expect(calculateNextInfinityTrack(['new'])).resolves.toBeUndefined();
});

test('fallback searches past a page of duplicate editions without changing shuffle order', async () => {
  candidates = [];
  const query = jest.mocked(queryWithRetry).getMockImplementation()!;
  jest.mocked(queryWithRetry).mockImplementation(async (sql, values) => {
    if (!sql.includes('OFFSET')) return query(sql, values);
    const rows = values?.[2] === 0
      ? Array.from({ length: 100 }, (_, index) => ({ id: `edition-${index}`, title: 'Heard (Remastered)', artist: 'Artist' }))
      : [{ id: 'fresh', title: 'Fresh', artist: 'Other' }];
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
  });
  expect((await calculateNextInfinityTrack(['new']))?.id).toBe('fresh');
  const pages = jest.mocked(queryWithRetry).mock.calls.filter(([sql]) => sql.includes('OFFSET'));
  expect(pages.map(([, values]) => values![2])).toEqual([0, 100]);
  expect(pages[0][1]![1]).toBe(pages[1][1]![1]);
});

test('queue seeds steer the centroid and style seed while history still blocks repeats', async () => {
  seeds = [
    { id: 'queued-a', acoustic_vector_8d: acoustic(0.2), embedding_vector: embedding, feature_version: 2 },
    { id: 'queued-b', acoustic_vector_8d: acoustic(0.3), embedding_vector: embedding, feature_version: 2 },
  ];
  await calculateNextInfinityTrack(['heard-1', 'heard-2'], { artistAmnesiaLimit: 5 }, { seedTrackIds: ['queued-a', 'queued-b'] });
  const calls = jest.mocked(queryWithRetry).mock.calls;
  expect(calls.find(([sql]) => sql.includes('SELECT t.id, tf.acoustic_vector_8d'))![1]).toEqual(['queued-a', 'queued-b']);
  // The style seed is the queue tail too.
  expect(seedStyleVector).toHaveBeenCalledWith(expect.anything(), ['queued-a', 'queued-b']);
  const [, values] = calls.find(([sql]) => sql.includes('AS distance'))!;
  // Centroid comes from the queue (energy 0.2–0.3), not the history rows.
  expect(JSON.parse(values![0])[0]).toBeLessThan(0.3);
  expect(values).toEqual(expect.arrayContaining(['heard-1', 'heard-2', 'queued-a', 'queued-b']));
});

test('only the last ten queue seeds are used', async () => {
  const queue = Array.from({ length: 15 }, (_, i) => `q-${i}`);
  await calculateNextInfinityTrack([], {}, { seedTrackIds: queue });
  expect(jest.mocked(queryWithRetry).mock.calls.find(([sql]) => sql.includes('SELECT t.id, tf.acoustic_vector_8d'))![1])
    .toEqual(queue.slice(-10));
});

test('repeat protection keeps its full limit through every relaxation attempt', async () => {
  candidates = [];
  fallback = [{ id: 'fresh', title: 'Fresh', artist: 'Other' }];
  const history = ['h1', 'h2', 'h3', 'h4'];
  await calculateNextInfinityTrack(history, { artistAmnesiaLimit: 4 });
  const attempts = jest.mocked(queryWithRetry).mock.calls.filter(([sql]) => sql.includes('AS distance'));
  expect(attempts).toHaveLength(3);
  for (const [, values] of attempts) expect(values).toEqual(expect.arrayContaining(history));
});

test('a track that shares the seed\'s styles moves past a closer-sounding one; at 0 % style match sound alone decides', async () => {
  candidates = [
    { id: 'near', title: 'Near', artist: 'A', distance: 0.10 },
    { id: 'styled', title: 'Styled', artist: 'B', distance: 0.15 },
  ];
  jest.spyOn(Math, 'random').mockReturnValue(0);
  const styled = await calculateNextInfinityTrack(['old', 'new'], { genreStrictness: 100 });
  expect(styled?.id).toBe('styled');
  expect(styled?.styleOverlap).toBeCloseTo(1);

  const soundOnly = await calculateNextInfinityTrack(['old', 'new'], { genreStrictness: 0 });
  expect(soundOnly?.id).toBe('near');
});
