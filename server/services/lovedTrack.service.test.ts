const getTrackById = jest.fn();
const setTrackLovedForUser = jest.fn();
const getUserSetting = jest.fn();
const getSystemSetting = jest.fn();
const loveTrack = jest.fn();
const unloveTrack = jest.fn();
const submitMbRecordingRating = jest.fn();
const publishApiV1Event = jest.fn();

jest.mock('../database', () => ({
  getTrackById: (...a: unknown[]) => getTrackById(...a),
  setTrackLovedForUser: (...a: unknown[]) => setTrackLovedForUser(...a),
  getUserSetting: (...a: unknown[]) => getUserSetting(...a),
  getSystemSetting: (...a: unknown[]) => getSystemSetting(...a),
}));
jest.mock('./lastfm.service', () => ({
  loveTrack: (...a: unknown[]) => loveTrack(...a),
  unloveTrack: (...a: unknown[]) => unloveTrack(...a),
}));
jest.mock('./musicbrainz.service', () => ({
  submitMbRecordingRating: (...a: unknown[]) => submitMbRecordingRating(...a),
}));
jest.mock('./apiV1Events.service', () => ({
  publishApiV1Event: (...a: unknown[]) => publishApiV1Event(...a),
}));

import { setTrackLovedAndSync } from './lovedTrack.service';

/**
 * API v1's `PUT /tracks/:id/loved` used to store the flag and stop. Moving the
 * web client onto it would have silently ended Last.fm loves and MusicBrainz
 * ratings, which only the legacy `/api/library/love` route performed. Both now
 * call this one function.
 */
describe('setTrackLovedAndSync', () => {
  const track = { id: 't1', artist: 'Tove Lo', title: 'Habits', mbRecordingId: 'mb-1' };
  const connected = () => {
    getUserSetting.mockImplementation(async (_u: string, key: string) => (key === 'lastFmConnected' ? 'true' : null));
    getSystemSetting.mockImplementation(async (key: string) => (key === 'musicBrainzConnected' ? true : null));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getTrackById.mockResolvedValue(track);
    loveTrack.mockResolvedValue(undefined);
    unloveTrack.mockResolvedValue(undefined);
    submitMbRecordingRating.mockResolvedValue(undefined);
  });

  it('stores the flag and syncs both providers when connected', async () => {
    connected();
    const providers = await setTrackLovedAndSync('u1', 't1', true);
    expect(setTrackLovedForUser).toHaveBeenCalledWith('u1', 't1', true);
    expect(loveTrack).toHaveBeenCalledWith('u1', 'Tove Lo', 'Habits');
    expect(submitMbRecordingRating).toHaveBeenCalledWith('mb-1', 100);
    expect(providers).toEqual([
      { provider: 'lastfm', status: 'ok' },
      { provider: 'musicbrainz', status: 'ok' },
    ]);
  });

  it('unloves on Last.fm and rates 0 on MusicBrainz', async () => {
    connected();
    await setTrackLovedAndSync('u1', 't1', false);
    expect(unloveTrack).toHaveBeenCalledWith('u1', 'Tove Lo', 'Habits');
    expect(loveTrack).not.toHaveBeenCalled();
    expect(submitMbRecordingRating).toHaveBeenCalledWith('mb-1', 0);
  });

  it('skips providers that are not connected, without failing', async () => {
    getUserSetting.mockResolvedValue(null);
    getSystemSetting.mockResolvedValue(false);
    const providers = await setTrackLovedAndSync('u1', 't1', true);
    expect(setTrackLovedForUser).toHaveBeenCalled();
    expect(loveTrack).not.toHaveBeenCalled();
    expect(submitMbRecordingRating).not.toHaveBeenCalled();
    expect(providers?.map((p) => p.status)).toEqual(['skipped', 'skipped']);
  });

  it('skips a provider when the track lacks what it needs', async () => {
    connected();
    getTrackById.mockResolvedValue({ id: 't1', artist: null, title: 'Habits', mbRecordingId: null });
    const providers = await setTrackLovedAndSync('u1', 't1', true);
    expect(providers).toEqual([
      { provider: 'lastfm', status: 'skipped', reason: 'not_connected_or_missing_metadata' },
      { provider: 'musicbrainz', status: 'skipped', reason: 'not_connected_or_missing_recording_mbid' },
    ]);
  });

  it('keeps the local write when a provider fails, and names the provider', async () => {
    connected();
    loveTrack.mockRejectedValue(new Error('Last.fm 503'));
    const providers = await setTrackLovedAndSync('u1', 't1', true);
    expect(setTrackLovedForUser).toHaveBeenCalledWith('u1', 't1', true);
    expect(providers).toEqual([
      { provider: 'lastfm', status: 'failed', error: 'Last.fm 503' },
      { provider: 'musicbrainz', status: 'ok' },
    ]);
  });

  it('writes locally before contacting any provider', async () => {
    connected();
    const order: string[] = [];
    setTrackLovedForUser.mockImplementation(async () => { order.push('db'); });
    loveTrack.mockImplementation(async () => { order.push('lastfm'); });
    submitMbRecordingRating.mockImplementation(async () => { order.push('musicbrainz'); });
    await setTrackLovedAndSync('u1', 't1', true);
    expect(order[0]).toBe('db');
  });

  it('stores the love but contacts no provider when sync is off', async () => {
    connected();
    const providers = await setTrackLovedAndSync('u1', 't1', true, { syncProviders: false });
    expect(setTrackLovedForUser).toHaveBeenCalledWith('u1', 't1', true);
    expect(loveTrack).not.toHaveBeenCalled();
    expect(submitMbRecordingRating).not.toHaveBeenCalled();
    expect(providers).toEqual([
      { provider: 'lastfm', status: 'skipped', reason: 'sync_disabled' },
      { provider: 'musicbrainz', status: 'skipped', reason: 'sync_disabled' },
    ]);
  });

  it('syncs unless told not to', async () => {
    connected();
    await setTrackLovedAndSync('u1', 't1', true, { syncProviders: true });
    await setTrackLovedAndSync('u1', 't1', true, {});
    expect(loveTrack).toHaveBeenCalledTimes(2);
  });

  it('returns null and writes nothing for an unknown track', async () => {
    getTrackById.mockResolvedValue(null);
    expect(await setTrackLovedAndSync('u1', 'missing', true)).toBeNull();
    expect(setTrackLovedForUser).not.toHaveBeenCalled();
    expect(publishApiV1Event).not.toHaveBeenCalled();
  });

  it('carries the source into the change event only when given', async () => {
    connected();
    await setTrackLovedAndSync('u1', 't1', true, { source: 'web' });
    expect(publishApiV1Event).toHaveBeenLastCalledWith('u1', 'annotation.changed', { trackId: 't1', loved: true, source: 'web' });
    await setTrackLovedAndSync('u1', 't1', false);
    expect(publishApiV1Event).toHaveBeenLastCalledWith('u1', 'annotation.changed', { trackId: 't1', loved: false });
  });
});
