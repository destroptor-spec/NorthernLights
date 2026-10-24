/**
 * @jest-environment node
 */
jest.mock('../database', () => ({}));
jest.mock('../state', () => ({ addToSessionHistory: jest.fn() }));
jest.mock('./scrobbleProviders.service', () => ({}));

import { noteSessionReport, resetSessionListens, type SessionListenDeps } from './sessionListens.service';

const tracks: Record<string, Record<string, unknown>> = {
  e1: { id: 't1', title: 'One', artist: 'A', duration: 200 },
  e2: { id: 't2', title: 'Two', artist: 'B', duration: 600 },
  short: { id: 't3', title: 'Jingle', artist: 'C', duration: 20 },
};

function harness(start = 1_000_000) {
  let clock = start;
  const calls: string[] = [];
  const deps: SessionListenDeps = {
    loadEntryTrack: async (_session, entry) => tracks[entry] ?? null,
    thresholdPercent: async () => 50,
    recordPlay: jest.fn(async (_u, trackId, playedAt) => { calls.push(`play ${trackId} @${playedAt.getTime()}`); }),
    recordSkip: jest.fn(async (_u, trackId) => { calls.push(`skip ${trackId}`); }),
    addHistory: jest.fn((_u, trackId) => { calls.push(`history ${trackId}`); }),
    scrobble: jest.fn(async (_u, track, submission, ts) => { calls.push(`${submission ? 'scrobble' : 'now-playing'} ${track.id} @${ts}`); }),
    now: () => clock,
    log: () => undefined,
  };
  const report = (queueEntryId: string | null, positionS: number, state = 'playing', session = 's1') =>
    noteSessionReport('u1', session, { state, queueEntryId, positionMs: positionS * 1000 }, deps);
  return { calls, report, deps, tick: (s: number) => { clock += s * 1000; } };
}

beforeEach(() => resetSessionListens());

it('sends now playing when an entry plays, then counts the play and scrobbles once past the threshold', async () => {
  const h = harness();
  await h.report('e1', 0);
  h.tick(60); await h.report('e1', 60);
  h.tick(50); await h.report('e1', 110); // past 50% of 200 s
  h.tick(10); await h.report('e1', 120);
  expect(h.calls).toEqual(['history t1', 'now-playing t1 @1000', 'play t1 @1000000', 'scrobble t1 @1000']);
});

it('caps the threshold at 4 minutes', async () => {
  const h = harness();
  await h.report('e2', 0);
  await h.report('e2', 239);
  expect(h.calls).not.toContain('play t2 @1000000');
  await h.report('e2', 241);
  expect(h.calls).toContain('play t2 @1000000');
});

it('records a skip when the output moves on before the threshold, and none after it', async () => {
  const h = harness();
  await h.report('e1', 0);
  await h.report('e1', 30);
  await h.report('e2', 0); // Next at 30 s
  expect(h.calls).toContain('skip t1');

  const after = harness();
  await after.report('e1', 0);
  await after.report('e1', 150);
  await after.report('e2', 0);
  expect(after.calls).not.toContain('skip t1');
});

it('counts nothing for an entry that never played (loaded, paused), and no skip when moving on', async () => {
  const h = harness();
  await h.report('e1', 0, 'paused');
  await h.report('e1', 0, 'stopped');
  await h.report('e2', 0, 'paused');
  expect(h.calls).toEqual([]);
});

it('a pause continues the same listen', async () => {
  const h = harness();
  await h.report('e1', 0);
  await h.report('e1', 40, 'paused');
  await h.report('e1', 40);
  await h.report('e1', 101);
  expect(h.calls.filter((c) => c.startsWith('now-playing'))).toHaveLength(1);
  expect(h.calls).toContain('play t1 @1000000');
});

it('counts the same entry again when it starts over (repeat one)', async () => {
  const h = harness();
  await h.report('e1', 0);
  await h.report('e1', 190);
  h.tick(200); await h.report('e1', 2); // back at the start
  await h.report('e1', 120);
  expect(h.calls.filter((c) => c.startsWith('play t1'))).toHaveLength(2);
  expect(h.calls.filter((c) => c.startsWith('scrobble t1'))).toHaveLength(2);
});

it('does not count a listen first seen past the threshold (the server restarted mid-track)', async () => {
  const h = harness();
  await h.report('e1', 150);
  await h.report('e1', 180);
  expect(h.calls.some((c) => c.startsWith('play') || c.startsWith('scrobble') || c.startsWith('now-playing'))).toBe(false);
});

it('never counts a track of 30 s or less', async () => {
  const h = harness();
  await h.report('short', 0);
  await h.report('short', 19);
  expect(h.calls.some((c) => c.startsWith('play'))).toBe(false);
});

it('keeps one listen per session across a handover, and sessions apart', async () => {
  const h = harness();
  await h.report('e1', 0);          // the phone plays
  await h.report('e1', 60);         // the receiver takes over, same session and entry
  await h.report('e1', 110);
  await h.report('e1', 0, 'playing', 's2'); // another session plays the same track
  expect(h.calls.filter((c) => c.startsWith('play t1'))).toHaveLength(1);
  expect(h.calls.filter((c) => c.startsWith('now-playing t1'))).toHaveLength(2);
});

it('takes the reports of a session in order, even when they arrive together', async () => {
  const h = harness();
  await Promise.all([h.report('e1', 0), h.report('e1', 110), h.report('e2', 0)]);
  expect(h.calls).toEqual(['history t1', 'now-playing t1 @1000', 'play t1 @1000000', 'scrobble t1 @1000', 'history t2', 'now-playing t2 @1000']);
});
