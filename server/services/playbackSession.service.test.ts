jest.mock('../database', () => ({ initDB: jest.fn() }));
jest.mock('./apiV1Dto.service', () => ({ getApiV1TracksByIds: jest.fn().mockResolvedValue([]) }));
jest.mock('./apiV1Events.service', () => ({ publishApiV1Event: jest.fn() }));

import { initDB } from '../database';
import {
  deletePlaybackSession,
  patchPlaybackSession,
  PlaybackSessionOwnershipError,
  PlaybackSessionRevisionError,
} from './playbackSession.service';

describe('playback-session ownership', () => {
  it('requires explicit handoff before another client can mutate a session', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM playback_sessions')) return { rows: [{
          id: 'session-1', user_id: 'user-1', name: 'Listening', owner_client_id: 'client-a',
          current_entry_id: null, position_ms: 0, playback_state: 'paused', repeat_mode: 'none',
          shuffle: false, source_kind: null, source_id: null, revision: 1,
          created_at: new Date(), updated_at: new Date(),
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    (initDB as jest.MockedFunction<typeof initDB>).mockResolvedValue({ connect: jest.fn().mockResolvedValue(client) } as any);

    await expect(patchPlaybackSession({
      userId: 'user-1', clientId: 'client-b', sessionId: 'session-1',
      patch: { expectedRevision: 1, operations: [{ type: 'setTransport', playbackState: 'playing' }] },
    })).rejects.toBeInstanceOf(PlaybackSessionOwnershipError);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('also requires ownership before deleting a session', async () => {
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('DELETE FROM playback_sessions')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT * FROM playback_sessions')) return { rows: [{
          id: 'session-1', user_id: 'user-1', name: 'Listening', owner_client_id: 'client-a',
          current_entry_id: null, position_ms: 0, playback_state: 'paused', repeat_mode: 'none',
          shuffle: false, source_kind: null, source_id: null, revision: 1,
          created_at: new Date(), updated_at: new Date(),
        }] };
        if (sql.includes('FROM playback_session_entries')) return { rows: [] };
        return { rows: [] };
      }),
    };
    (initDB as jest.MockedFunction<typeof initDB>).mockResolvedValue(pool as any);

    await expect(deletePlaybackSession('user-1', 'client-b', 'session-1', 1))
      .rejects.toBeInstanceOf(PlaybackSessionOwnershipError);
  });

  it('rejects stale deletion revisions even for the owning client', async () => {
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('DELETE FROM playback_sessions')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT * FROM playback_sessions')) return { rows: [{
          id: 'session-1', user_id: 'user-1', name: 'Listening', owner_client_id: 'client-a',
          current_entry_id: null, position_ms: 0, playback_state: 'paused', repeat_mode: 'none',
          shuffle: false, source_kind: null, source_id: null, revision: 3,
          created_at: new Date(), updated_at: new Date(),
        }] };
        if (sql.includes('FROM playback_session_entries')) return { rows: [] };
        return { rows: [] };
      }),
    };
    (initDB as jest.MockedFunction<typeof initDB>).mockResolvedValue(pool as any);

    await expect(deletePlaybackSession('user-1', 'client-a', 'session-1', 2))
      .rejects.toBeInstanceOf(PlaybackSessionRevisionError);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('revision = $4'),
      ['session-1', 'user-1', 'client-a', 2],
    );
  });
});
