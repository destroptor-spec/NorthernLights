jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

import { decodeRankedSearchCursor, InvalidSearchCursorError, RECORD_PLAYBACK_STATS_SQL } from './index';

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
