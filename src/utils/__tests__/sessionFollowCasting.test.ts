import { followFromSession } from '../sessionFollow';
import type { PlaybackSession } from '../../../shared/api/v1';

// Which device casts, so "Play there" to it can ask "End cast?" (Connect, 2026-10-27).
const session = (output: Partial<NonNullable<PlaybackSession['output']>>, ownerClientId = 'desktop'): PlaybackSession => ({
  id: 's1', name: 'Listening', ownerClientId, currentEntryId: null, positionMs: 0, playbackState: 'playing',
  repeatMode: 'none', shuffle: false, infinity: false, source: null, revision: 1, queue: [],
  createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z',
  output: { id: 'x', kind: 'browser', name: 'X', generation: 1, claimedAt: '2026-10-27T12:00:00.000Z', status: 'active', report: null, ...output },
} as PlaybackSession);

it('names the device that casts: the output itself for cast, the claiming device for receiver', () => {
  expect(followFromSession(session({ id: 'desktop', kind: 'cast', name: 'NAD Forstærker' }), 'phone', 0)?.castingClientId).toBe('desktop');
  expect(followFromSession(session({ id: 'receiver:cast-77', kind: 'receiver', name: 'NAD Forstærker' }), 'phone', 0)?.castingClientId).toBe('desktop');
  expect(followFromSession(session({ id: 'desktop', kind: 'browser', name: 'Chrome on Linux' }), 'phone', 0)?.castingClientId).toBeUndefined();
});
