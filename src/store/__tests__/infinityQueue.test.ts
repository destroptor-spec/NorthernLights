/**
 * Infinity Mode tops the queue up from `playAtIndex`. While casting, the
 * receiver advances its own queue, so `playAtIndex` never runs — the sender
 * only learns about the change through `onTrackChange`. Before this was wired
 * up, a cast Infinity session played exactly one prefetched track and then
 * stopped dead (prod, 2026-08-30 21:02→21:07). The `onEnded` fallback cannot
 * cover it either: that path needs `idleReason === FINISHED`, and the receiver
 * reported `none` on all 53 observations that session.
 */
// Captured at import time, when the store registers with PlaybackManager —
// a plain jest.fn() would lose it to clearAllMocks() in beforeEach.
let mockCallbacks: { onTrackChange: (index: number) => void };
const appendToQueue = jest.fn();
const isConnected = jest.fn(() => true);

jest.mock('../../utils/PlaybackManager', () => ({
  playbackManager: {
    setCallbacks: (cb: { onTrackChange: (index: number) => void }) => { mockCallbacks = cb; },
    getLocalAudioElement: () => ({ pause: jest.fn() }),
    play: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(),
    seek: jest.fn(),
    setVolume: jest.fn(),
    loadTrack: jest.fn(),
  },
}));

jest.mock('../../utils/CastManager', () => ({
  castManager: {
    isConnected: () => isConnected(),
    appendToQueue: (t: unknown) => appendToQueue(t),
    setDiagnosticsVerbose: jest.fn(),
    addStateChangeListener: jest.fn(),
    addHealthListener: jest.fn(),
    getHealthStatus: () => ({ phase: 'idle', message: '' }),
    getDeviceName: () => 'Test Device',
    onTrackChange: undefined,
  },
}));

import { usePlayerStore } from '../index';

const track = (id: string) => ({ id, path: `/${id}.mp3`, title: id, duration: 100 });

const callbacks = () => mockCallbacks;

describe('Infinity Mode while casting', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    isConnected.mockReturnValue(true);
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ track: { id: 'next', path: '/next.mp3', title: 'Next Up' } }),
    });
    usePlayerStore.setState({
      isInfinityMode: true,
      isFetchingInfinity: false,
      playlist: [track('a'), track('b')],
      currentIndex: 0,
      sessionHistoryTrackIds: [],
    });
  });

  it('tops the queue up when the receiver advances onto the last track', async () => {
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith('/api/recommend', expect.anything());
    expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['a', 'b', 'next']);
  });

  it('pushes the appended track to the Cast receiver, not just the local queue', async () => {
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(appendToQueue).toHaveBeenCalledTimes(1);
    expect(appendToQueue.mock.calls[0][0]).toMatchObject({ id: 'next' });
  });

  it('does not fetch while tracks remain ahead in the queue', async () => {
    usePlayerStore.setState({ playlist: [track('a'), track('b'), track('c')], currentIndex: 0 });
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when Infinity Mode is off', async () => {
    usePlayerStore.setState({ isInfinityMode: false });
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playlist).toHaveLength(2);
  });

  it('still syncs the current index when it does not need to fetch', () => {
    usePlayerStore.setState({ isInfinityMode: false });
    callbacks().onTrackChange(1);
    expect(usePlayerStore.getState().currentIndex).toBe(1);
  });

  it('ignores an out-of-range index from the receiver', async () => {
    callbacks().onTrackChange(99);
    await new Promise((r) => setTimeout(r, 0));

    expect(usePlayerStore.getState().currentIndex).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
