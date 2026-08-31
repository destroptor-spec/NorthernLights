jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

import {
  decodeRankedSearchCursor,
  InvalidSearchCursorError,
  RECORD_PLAYBACK_STATS_SQL,
  replacePlaylistTracksInTransaction,
} from './index';

describe('record playback stats SQL', () => {
  it('keeps last_played_at monotonic when importing older timed scrobbles', () => {
    expect(RECORD_PLAYBACK_STATS_SQL).toContain(
      'last_played_at = GREATEST(COALESCE(user_playback_stats.last_played_at, $3), $3)',
    );
    expect(RECORD_PLAYBACK_STATS_SQL).toContain('play_count = user_playback_stats.play_count + 1');
  });
});

describe('ranked library search cursor', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  it('accepts a complete cursor bound to the same normalized query', () => {
    const cursor = encode({
      query: 'nto',
      relevance: 100,
      similarity: 1,
      sortLabel: 'nto',
      typeRank: 1,
      id: 'artist-id',
    });

    expect(decodeRankedSearchCursor(cursor, '  NTO  ')).toEqual({
      query: 'nto',
      relevance: 100,
      similarity: 1,
      sortLabel: 'nto',
      typeRank: 1,
      id: 'artist-id',
    });
  });

  it('rejects malformed, out-of-range, and cross-query cursors', () => {
    expect(() => decodeRankedSearchCursor('not-json', 'NTO')).toThrow(InvalidSearchCursorError);
    expect(() => decodeRankedSearchCursor(encode({
      query: 'nto',
      relevance: 49,
      similarity: 1,
      sortLabel: 'nto',
      typeRank: 1,
      id: 'artist-id',
    }), 'NTO')).toThrow(InvalidSearchCursorError);
    expect(() => decodeRankedSearchCursor(encode({
      query: 'nto',
      relevance: 100,
      similarity: 1,
      sortLabel: 'nto',
      typeRank: 1,
      id: 'artist-id',
    }), 'different')).toThrow(InvalidSearchCursorError);
  });
});

describe('atomic playlist track replacement', () => {
  it('validates every requested track before deleting the existing playlist', async () => {
    const client = {
      query: jest.fn(async (sql: string, _values?: any[]) => {
        if (sql.includes('FROM tracks')) return { rows: [{ id: 'track-1' }] };
        return { rows: [] };
      }),
    };

    await expect(replacePlaylistTracksInTransaction(client, 'playlist-1', ['track-1', 'missing']))
      .rejects.toMatchObject({ missingIds: ['missing'] });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM playlist_tracks'))).toBe(false);
  });

  it('replaces validated tracks and preserves existing added timestamps', async () => {
    const addedAt = new Date('2026-08-01T10:00:00.000Z');
    const client = {
      query: jest.fn(async (sql: string, _values?: any[]) => {
        if (sql.includes('FROM tracks')) return { rows: [{ id: 'track-1' }] };
        if (sql.includes('SELECT track_id, added_at')) return { rows: [{ track_id: 'track-1', added_at: addedAt }] };
        return { rows: [] };
      }),
    };

    await replacePlaylistTracksInTransaction(client, 'playlist-1', ['track-1']);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes('SELECT id FROM tracks')))
      .toBeLessThan(statements.findIndex((sql) => sql.includes('DELETE FROM playlist_tracks')));
    const insertCall = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO playlist_tracks'));
    expect(insertCall?.[1]).toEqual(['playlist-1', 'track-1', 0, addedAt.toISOString()]);
  });
});
