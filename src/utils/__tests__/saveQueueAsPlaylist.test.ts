import { saveQueueAsPlaylist } from '../saveQueueAsPlaylist';

/** "Save queue as playlist", now through API v1 instead of /api/playlists. */
describe('saveQueueAsPlaylist', () => {
  const fetchMock = jest.fn();
  const ok = (data: unknown, status = 200) => ({ ok: true, status, json: async () => ({ data }), headers: { get: () => null } });
  const fail = (status: number, code: string, message: string) => ({ ok: false, status, json: async () => ({ error: { code, message } }), headers: { get: () => null } });
  const calls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit)?.method || 'GET'} ${url}`);

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });

  it('creates the playlist, then sets its tracks, through v1', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'user_1' }, 201)).mockResolvedValueOnce(ok({ id: 'user_1' }));
    const result = await saveQueueAsPlaylist('Road Mix', ['a', 'b'], { Authorization: 'Bearer jwt' });
    expect(calls()).toEqual(['POST /api/v1/playlists', 'PUT /api/v1/playlists/user_1/tracks']);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ title: 'Road Mix', description: 'Saved from play queue with 2 tracks.' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ trackIds: ['a', 'b'] });
    expect(result).toEqual({ id: 'user_1', trackCount: 2 });
  });

  it('saves a repeated queue track once, and counts it once', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'user_1' }, 201)).mockResolvedValueOnce(ok({}));
    await saveQueueAsPlaylist('Mix', ['a', 'b', 'a', null, undefined, ''], {});
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).description).toBe('Saved from play queue with 2 tracks.');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ trackIds: ['a', 'b'] });
  });

  it('removes the new playlist again when its tracks cannot be saved', async () => {
    // The legacy flow left an empty playlist behind on this path.
    fetchMock
      .mockResolvedValueOnce(ok({ id: 'user_1' }, 201))
      .mockResolvedValueOnce(fail(409, 'TRACKS_UNAVAILABLE', 'One or more playlist tracks are unavailable.'))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => null, headers: { get: () => null } });
    await expect(saveQueueAsPlaylist('Mix', ['gone'], {})).rejects.toThrow('One or more playlist tracks are unavailable.');
    expect(calls()).toEqual(['POST /api/v1/playlists', 'PUT /api/v1/playlists/user_1/tracks', 'DELETE /api/v1/playlists/user_1']);
  });

  it('still reports the original error if the cleanup also fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(ok({ id: 'user_1' }, 201))
      .mockResolvedValueOnce(fail(409, 'TRACKS_UNAVAILABLE', 'One or more playlist tracks are unavailable.'))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(saveQueueAsPlaylist('Mix', ['gone'], {})).rejects.toThrow('One or more playlist tracks are unavailable.');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('surfaces a rejected title without creating anything', async () => {
    fetchMock.mockResolvedValueOnce(fail(400, 'VALIDATION_ERROR', 'Title is required.'));
    await expect(saveQueueAsPlaylist('   ', ['a'], {})).rejects.toThrow('Title is required.');
    expect(calls()).toEqual(['POST /api/v1/playlists']);
  });

  it('refuses an empty queue without calling the server', async () => {
    await expect(saveQueueAsPlaylist('Mix', [null, ''], {})).rejects.toThrow('Queue is empty.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
