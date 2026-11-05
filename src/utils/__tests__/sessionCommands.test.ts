import type { PlaybackSession } from '../../../shared/api/v1';
import { applySessionCommand, type CommandPlayer } from '../sessionCommands';
import type { TrackInfo } from '../fileSystem';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = (n: number): TrackInfo => ({ id: `t${n}`, path: `p${n}`, queueEntryId: uuid(n) });
const sessionWith = (entries: number[], revision: number) => ({
  id: 's1', revision,
  queue: entries.map((n, position) => ({ queueEntryId: uuid(n), position, track: { id: `t${n}` } })),
}) as unknown as PlaybackSession;

function player(overrides: Partial<CommandPlayer> = {}) {
  const calls: string[] = [];
  const p: CommandPlayer = {
    resume: jest.fn(async () => { calls.push('resume'); }),
    pause: jest.fn(() => { calls.push('pause'); }),
    next: jest.fn(async () => { calls.push('next'); }),
    previous: jest.fn(async () => { calls.push('previous'); }),
    seek: jest.fn((s: number) => { calls.push(`seek:${s}`); }),
    setVolume: jest.fn((level: number) => { calls.push(`volume:${level}`); }),
    playlist: () => [track(1), track(2), track(3)],
    playAtIndex: jest.fn(async (i: number) => { calls.push(`play:${i}`); }),
    playQueue: jest.fn(async (tracks: TrackInfo[], i: number) => { calls.push(`queue:${tracks.map((t) => t.id).join(',')}@${i}`); }),
    fetchSession: jest.fn(async () => sessionWith([7, 8, 9], 20)),
    toTracks: (session) => session.queue.map((entry) => ({ id: entry.track.id, path: entry.track.id, queueEntryId: entry.queueEntryId })),
    wait: jest.fn(async () => undefined),
    ...overrides,
  };
  return { p, calls };
}

it('carries out the transport commands on this device (and so on its Cast device)', async () => {
  const { p, calls } = player();
  for (const command of [{ type: 'play' }, { type: 'pause' }, { type: 'next' }, { type: 'previous' }, { type: 'seek', positionMs: 42_500 }] as const) {
    expect(await applySessionCommand('s1', command, p)).toBe(true);
  }
  expect(calls).toEqual(['resume', 'pause', 'next', 'previous', 'seek:42.5']);
});

it('sets the volume here (and so on its Cast device)', async () => {
  const { p, calls } = player();
  expect(await applySessionCommand('s1', { type: 'setVolume', level: 0.35 }, p)).toBe(true);
  expect(calls).toEqual(['volume:0.35']);
});

it('jumps to a queue entry, and ignores one this queue does not have', async () => {
  const { p, calls } = player();
  expect(await applySessionCommand('s1', { type: 'jump', entryId: uuid(3) }, p)).toBe(true);
  expect(await applySessionCommand('s1', { type: 'jump', entryId: uuid(99) }, p)).toBe(false);
  expect(calls).toEqual(['play:2']);
});

it('loads the queue another device put in the session, and plays the chosen entry', async () => {
  const { p, calls } = player();
  expect(await applySessionCommand('s1', { type: 'load', revision: 20, entryId: uuid(8) }, p)).toBe(true);
  expect(calls).toEqual(['queue:t7,t8,t9@1']);
});

it('asks once more when the session does not show that queue yet, then gives up', async () => {
  const fetchSession = jest.fn()
    .mockResolvedValueOnce(sessionWith([1, 2, 3], 19))
    .mockResolvedValueOnce(sessionWith([7, 8, 9], 20));
  const { p, calls } = player({ fetchSession });
  expect(await applySessionCommand('s1', { type: 'load', revision: 20, entryId: uuid(9) }, p)).toBe(true);
  expect(p.wait).toHaveBeenCalledWith(500);
  expect(calls).toEqual(['queue:t7,t8,t9@2']);

  const stale = jest.fn().mockResolvedValue(sessionWith([1, 2, 3], 19));
  const late = player({ fetchSession: stale });
  expect(await applySessionCommand('s1', { type: 'load', revision: 20, entryId: uuid(9) }, late.p)).toBe(false);
  expect(stale).toHaveBeenCalledTimes(2);
  expect(late.calls).toEqual([]);
});
