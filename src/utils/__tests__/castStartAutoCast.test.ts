import { CastManager } from '../CastManager';
import type { FollowedOutput } from '../sessionFollow';

let storeState: Record<string, unknown> = {};
jest.mock('../PlaybackManager', () => ({
  playbackManager: { getCurrentTime: () => 0, getLocalAudioElement: () => ({ pause: jest.fn() }) },
}));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => storeState, setState: jest.fn() } }));

/**
 * Prod 2026-10-22 13:47:17–27: the phone, idle and following Stue TV on
 * "Fix You" at 0:43, tapped Cast. The new Cast session ended the TV's, and
 * the phone loaded its queue at its own idle position, 0:00.
 */
type Harness = {
  noteFollowAtLaunch(): void;
  handleCastConnected(): Promise<void>;
  castQueue: jest.Mock;
  logCast: jest.Mock;
};

const playlist = [
  { queueEntryId: 'viva', title: 'Viva La Vida', duration: 242 },
  { queueEntryId: 'fix-you', title: 'Fix You', duration: 295 },
];
const tv = (overrides: Partial<FollowedOutput> = {}): FollowedOutput => ({
  sessionId: 's1', outputId: 'receiver:651ba6aa', name: 'Stue TV', kind: 'receiver', generation: 356,
  state: 'playing', entryId: 'fix-you', positionMs: 40_000, anchorMs: 1_000_000, ...overrides,
});

function harness() {
  const manager = Object.create(CastManager.prototype) as Harness;
  Object.assign(manager, {
    autoCastInProgress: false,
    followAtLaunch: null,
    ensureStoreQueueEntryIds: () => playlist,
    castQueue: jest.fn().mockResolvedValue(undefined),
    logCast: jest.fn(),
  });
  return manager;
}

beforeEach(() => jest.useFakeTimers({ now: 1_003_000 }));
afterEach(() => jest.useRealTimers());

it('starts the new Cast session where the followed TV was when Cast was tapped', async () => {
  storeState = { currentIndex: 1, repeat: 'off', playbackState: 'paused', sessionFollow: tv() };
  const manager = harness();
  manager.noteFollowAtLaunch();
  // The TV's session ends while the dialog is open; the new one connects later.
  storeState = { ...storeState, sessionFollow: null };
  jest.setSystemTime(1_012_000);
  await manager.handleCastConnected();
  expect(manager.castQueue).toHaveBeenCalledWith(expect.any(Array), 1, 'off', 43);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'Auto-casting current local queue', 'index=1 title=Fix You position=43.0 source=followed');
});

it('keeps its own position while it plays itself', async () => {
  storeState = { currentIndex: 1, repeat: 'off', playbackState: 'playing', sessionFollow: null };
  const manager = harness();
  manager.noteFollowAtLaunch();
  await manager.handleCastConnected();
  expect(manager.castQueue).toHaveBeenCalledWith(expect.any(Array), 1, 'off', 0);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'Auto-casting current local queue', expect.stringContaining('source=local'));
});
