jest.mock('../database', () => ({
  initDB: jest.fn(),
  invalidateGenreEntityCache: jest.fn(),
  setSystemSetting: jest.fn(),
}));

import { initDB, invalidateGenreEntityCache, setSystemSetting } from '../database';
import { groupGenres } from './genreCanonicalization.service';

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';
const ALIAS_ID = '22222222-2222-4222-8222-222222222222';

function reviewRows(paths: [string | null, string | null] = ['electronic', 'electronic']) {
  return [
    {
      id: CANONICAL_ID,
      name: 'Drum & Bass',
      normalized_key: 'drum and bass',
      track_count: 20,
      album_count: 3,
      taxonomy_path: paths[0],
      is_mb_genre: false,
    },
    {
      id: ALIAS_ID,
      name: 'Drum n Bass',
      normalized_key: 'drum and bass',
      track_count: 8,
      album_count: 2,
      taxonomy_path: paths[1],
      is_mb_genre: false,
    },
  ];
}

function makeDb(rows = reviewRows()) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM genres g') && sql.includes('COUNT(DISTINCT tt.track_id)')) {
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: jest.fn() };
  const db = { connect: jest.fn(async () => client) };
  (initDB as jest.Mock).mockResolvedValue(db);
  return { db, client, query };
}

describe('genre grouping transaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (setSystemSetting as jest.Mock).mockResolvedValue(undefined);
  });

  it('groups the spellings for the tag mapping, leaves track genres to fusion, and invalidates consumers', async () => {
    const { query, client } = makeDb();

    await groupGenres({
      canonicalGenreId: CANONICAL_ID,
      aliasGenreIds: [ALIAS_ID],
      candidateKey: 'genre-normalized:drum and bass',
      signature: 'signature',
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('BEGIN');
    expect(statements.some(sql => sql.includes('UPDATE genres SET merged_into'))).toBe(true);
    // Track genres come from the fused genres and styles, never from a grouping.
    expect(statements.some(sql => sql.includes('UPDATE tracks SET genre_id'))).toBe(false);
    expect(statements.some(sql => /track_genres/.test(sql))).toBe(false);
    expect(statements.some(sql => sql.includes('INSERT INTO genre_duplicate_reviews'))).toBe(true);
    expect(statements).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(invalidateGenreEntityCache).toHaveBeenCalled();
    expect(setSystemSetting).toHaveBeenCalledWith('systemPlaylistConfigUpdatedAt', expect.any(Number));
  });

  it('rolls back taxonomy-root conflicts until explicitly acknowledged', async () => {
    const { query } = makeDb(reviewRows(['electronic', 'jazz']));

    await expect(groupGenres({
      canonicalGenreId: CANONICAL_ID,
      aliasGenreIds: [ALIAS_ID],
    })).rejects.toMatchObject({ code: 'GENRE_TAXONOMY_CONFLICT' });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('ROLLBACK');
    expect(statements.some(sql => sql.includes('UPDATE genres SET merged_into'))).toBe(false);
    expect(invalidateGenreEntityCache).not.toHaveBeenCalled();
  });

});
