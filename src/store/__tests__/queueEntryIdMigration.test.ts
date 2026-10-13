/**
 * Queues saved before entry IDs became UUIDs are re-keyed when the store
 * loads, so they can be mirrored to a playback session. Not while a Cast
 * session may be rejoined: its receiver matches the queue window by the old
 * IDs, so that queue keeps them.
 */
jest.mock('../../utils/PlaybackManager', () => ({
  playbackManager: {
    setCallbacks: jest.fn(), getLocalAudioElement: () => ({ pause: jest.fn() }), play: jest.fn(), pause: jest.fn(),
    stop: jest.fn(), seek: jest.fn(), setVolume: jest.fn(), loadTrack: jest.fn(), prepareNextUrl: jest.fn(),
  },
}));
jest.mock('../../utils/CastManager', () => ({
  castManager: {
    isConnected: () => false,
    hasStoredSession: () => window.localStorage.getItem('cast_session_id') !== null,
    setDiagnosticsVerbose: jest.fn(), addStateChangeListener: jest.fn(), addHealthListener: jest.fn(),
    getHealthStatus: () => ({ phase: 'idle', message: '' }), getDeviceName: () => 'Test Device',
  },
}));

import { isUuid } from '../../utils/uuid';

const LEGACY = ['queue-lx2k9a-aaaaaaaa', 'queue-lx2k9b-bbbbbbbb'];

function loadStoreWithSavedQueue(): { playlist: Array<{ id: string; queueEntryId?: string }>; currentIndex: number | null } {
  window.localStorage.setItem('player-store', JSON.stringify({
    state: {
      playlist: [{ id: 'a', path: '/a.flac', title: 'A', queueEntryId: LEGACY[0] }, { id: 'b', path: '/b.flac', title: 'B', queueEntryId: LEGACY[1] }],
      currentIndex: 1,
    },
    version: 0,
  }));
  let state: ReturnType<typeof loadStoreWithSavedQueue> | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    state = require('../index').usePlayerStore.getState();
  });
  return state!;
}

beforeEach(() => window.localStorage.clear());

it('gives a saved queue UUID entry IDs, keeping its order and position', () => {
  const { playlist, currentIndex } = loadStoreWithSavedQueue();
  expect(playlist.map((t) => t.id)).toEqual(['a', 'b']);
  expect(playlist.every((t) => isUuid(t.queueEntryId))).toBe(true);
  expect(currentIndex).toBe(1);
});

it('keeps the old IDs while a Cast session may still be rejoined', () => {
  window.localStorage.setItem('cast_session_id', 'session-1');
  const { playlist } = loadStoreWithSavedQueue();
  expect(playlist.map((t) => t.queueEntryId)).toEqual(LEGACY);
});
