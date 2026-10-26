/**
 * @jest-environment node
 */
jest.mock('../database', () => ({}));
jest.mock('./lastfm.service', () => ({}));
jest.mock('./listenbrainz.service', () => ({}));

import { reportedListenStartS, scrobblePlaybackReport } from './scrobbleProviders.service';

const row = { id: 't1', title: 'One', artist: 'A', album: 'Album', duration: 200, mb_recording_id: 'rec-1' };

describe('reportedListenStartS', () => {
  it('dates the listen from receipt time minus the reported position', () => {
    expect(reportedListenStartS(1_700_000_101_000, undefined, 101_000)).toBe(1_700_000_000);
  });

  it("uses the client's occurredAt when it sent one", () => {
    expect(reportedListenStartS(9_999_999_999_000, '2026-10-26T12:01:41.000Z', 101_000)).toBe(Date.parse('2026-10-26T12:00:00.000Z') / 1000);
  });

  it('falls back to the report time without a position', () => {
    expect(reportedListenStartS(1_700_000_000_900)).toBe(1_700_000_000);
  });
});

describe('scrobblePlaybackReport', () => {
  it('scrobbles a play with the time the listen started', async () => {
    const send = jest.fn(async () => undefined);
    await scrobblePlaybackReport('u1', 't1', 'played', 1_700_000_000, async () => row, send);
    expect(send).toHaveBeenCalledWith('u1', [expect.objectContaining({ artist: 'A', track: 'One', album: 'Album', timestamp: 1_700_000_000, mbid: 'rec-1' })], true);
  });

  it('sends "now playing" without a timestamp', async () => {
    const send = jest.fn(async () => undefined);
    await scrobblePlaybackReport('u1', 't1', 'nowPlaying', 1_700_000_000, async () => row, send);
    expect(send).toHaveBeenCalledWith('u1', [expect.not.objectContaining({ timestamp: expect.anything() })], false);
  });

  it('sends nothing for a track without an artist or title', async () => {
    const send = jest.fn(async () => undefined);
    await scrobblePlaybackReport('u1', 't1', 'played', 1, async () => ({ id: 't1', title: '' }), send);
    await scrobblePlaybackReport('u1', 'gone', 'played', 1, async () => null, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws into the report request', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(scrobblePlaybackReport('u1', 't1', 'played', 1, async () => { throw new Error('db down'); })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider_error provider=report action=played count=1 message=db down'));
    warn.mockRestore();
  });
});
