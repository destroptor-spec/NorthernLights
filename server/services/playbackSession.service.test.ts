jest.mock('../database', () => ({ initDB: jest.fn() }));
jest.mock('./apiV1Dto.service', () => ({ getApiV1TracksByIds: jest.fn().mockResolvedValue([]) }));
jest.mock('./apiV1Events.service', () => ({ publishApiV1Event: jest.fn() }));

import { initDB } from '../database';
import { deletePlaybackSession, PlaybackSessionRevisionError } from './playbackSession.service';

// The Postgres-backed contract suite (server/database/__tests__/playbackSessions.pg.test.ts)
// covers sessions end to end; this keeps the delete guard checked without a database.
describe('playback-session deletion', () => {
  it('rejects a stale revision, whichever of the owner\'s devices asks', async () => {
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('DELETE FROM playback_sessions')) return { rows: [], rowCount: 0 };
        if (sql.trim().startsWith('SELECT s.*') || sql.startsWith('SELECT * FROM playback_sessions')) return { rows: [{
          id: 'session-1', user_id: 'user-1', name: 'Listening', owner_client_id: 'client-a',
          current_entry_id: null, position_ms: 0, playback_state: 'paused', repeat_mode: 'none',
          shuffle: false, source_kind: null, source_id: null, revision: 3,
          output_id: null, output_kind: null, output_name: null, output_generation: 0, output_claimed_at: null,
          created_at: new Date(), updated_at: new Date(),
        }] };
        return { rows: [] };
      }),
    };
    (initDB as jest.MockedFunction<typeof initDB>).mockResolvedValue(pool as any);

    await expect(deletePlaybackSession('user-1', 'session-1', 2)).rejects.toBeInstanceOf(PlaybackSessionRevisionError);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('revision = $3'), ['session-1', 'user-1', 2]);
  });
});
