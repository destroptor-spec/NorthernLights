import { castEndSnapshot, shouldContinuePlayingAfterCast, USER_STOP_WINDOW_MS } from '../castEndHandoff';

/**
 * Prod 2026-10-13 15:57:23Z: stopping Cast from the phone's Cast dialog while
 * the NAD played left the phone silent. Only the desktop "Stop casting" button
 * ever handed playback back, and only when the browser's own player still held
 * the right track.
 */
describe('shouldContinuePlayingAfterCast', () => {
  const now = 1_000_000;

  it('continues after the Stop casting button', () => {
    expect(shouldContinuePlayingAfterCast({ userStopRequested: true, dialogOpenedAt: 0, now, wasPlaying: true })).toBe(true);
  });

  it('continues after a stop from the Cast dialog opened on this device', () => {
    expect(shouldContinuePlayingAfterCast({ userStopRequested: false, dialogOpenedAt: now - 6_000, now, wasPlaying: true })).toBe(true);
    expect(shouldContinuePlayingAfterCast({ userStopRequested: false, dialogOpenedAt: now - USER_STOP_WINDOW_MS, now, wasPlaying: true })).toBe(true);
  });

  it('stays paused when the session ended anywhere else', () => {
    expect(shouldContinuePlayingAfterCast({ userStopRequested: false, dialogOpenedAt: 0, now, wasPlaying: true })).toBe(false);
    expect(shouldContinuePlayingAfterCast({ userStopRequested: false, dialogOpenedAt: now - USER_STOP_WINDOW_MS - 1, now, wasPlaying: true })).toBe(false);
  });

  it('never starts sound when the Cast device was paused', () => {
    expect(shouldContinuePlayingAfterCast({ userStopRequested: true, dialogOpenedAt: now, now, wasPlaying: false })).toBe(false);
  });
});

describe('castEndSnapshot', () => {
  const playlist = [
    { queueEntryId: 'a', duration: 200 },
    { queueEntryId: 'b', duration: 170 },
    { queueEntryId: 'c', duration: 180 },
  ];

  it('takes the track and position from the last trusted Cast position, carried forward while playing', () => {
    expect(castEndSnapshot({
      anchor: { position: 130, atMs: 10_000, entryId: 'b' },
      now: 12_500,
      playlist,
      currentIndex: 0,
      wasPlaying: true,
      storePositionSeconds: 0,
    })).toEqual({ index: 1, positionSeconds: 132.5, wasPlaying: true });
  });

  it('does not carry a paused position forward', () => {
    expect(castEndSnapshot({
      anchor: { position: 130, atMs: 10_000, entryId: 'b' }, now: 70_000, playlist, currentIndex: 1, wasPlaying: false, storePositionSeconds: 0,
    })?.positionSeconds).toBe(130);
  });

  it('falls back to the store when there is no anchor for a queued entry', () => {
    expect(castEndSnapshot({
      anchor: { position: 5, atMs: 0, entryId: 'gone' }, now: 1_000, playlist, currentIndex: 2, wasPlaying: true, storePositionSeconds: 42,
    })).toEqual({ index: 2, positionSeconds: 42, wasPlaying: true });
    expect(castEndSnapshot({ anchor: null, now: 0, playlist, currentIndex: null, wasPlaying: false, storePositionSeconds: 0 })).toBeNull();
  });

  it('stays inside the track', () => {
    expect(castEndSnapshot({
      anchor: { position: 168, atMs: 0, entryId: 'b' }, now: 30_000, playlist, currentIndex: 1, wasPlaying: true, storePositionSeconds: 0,
    })?.positionSeconds).toBe(169);
  });
});
