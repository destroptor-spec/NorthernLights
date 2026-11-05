import type { PlaybackCommand, PlaybackSession } from '../../shared/api/v1';
import type { TrackInfo } from './fileSystem';

// The output's side of remote control (docs/playback_sessions.md, "Device
// choice and remote control"): another of the user's devices asked this one,
// which plays the session, to act. While casting, the player actions below
// reach the Cast device, so this device relays for it.

export interface CommandPlayer {
  resume: () => Promise<void>;
  pause: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (seconds: number) => void;
  setVolume: (level: number) => void;
  playlist: () => TrackInfo[];
  playAtIndex: (index: number) => Promise<void>;
  /** Replace the queue with these tracks, entry IDs as they are, and play `index`. */
  playQueue: (tracks: TrackInfo[], index: number) => Promise<void>;
  fetchSession: (sessionId: string) => Promise<PlaybackSession>;
  toTracks: (session: PlaybackSession) => TrackInfo[];
  wait?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
}

/** The session may not show the controller's PATCH yet; ask once more after this. */
const LOAD_RETRY_MS = 500;

export async function applySessionCommand(sessionId: string, command: PlaybackCommand, player: CommandPlayer): Promise<boolean> {
  switch (command.type) {
    case 'play':
      await player.resume();
      return true;
    case 'pause':
      player.pause();
      return true;
    case 'next':
      await player.next();
      return true;
    case 'previous':
      await player.previous();
      return true;
    case 'seek':
      player.seek(command.positionMs / 1000);
      return true;
    case 'setVolume':
      player.setVolume(Math.min(1, Math.max(0, command.level)));
      return true;
    case 'jump': {
      const index = player.playlist().findIndex((track) => track.queueEntryId === command.entryId);
      if (index < 0) {
        player.log?.('[SessionCommand] jump to an entry this queue does not have', command.entryId);
        return false;
      }
      await player.playAtIndex(index);
      return true;
    }
    case 'load': {
      let session = await player.fetchSession(sessionId);
      if (session.revision < command.revision) {
        await (player.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(LOAD_RETRY_MS);
        session = await player.fetchSession(sessionId);
      }
      const index = session.queue.findIndex((entry) => entry.queueEntryId === command.entryId);
      if (session.revision < command.revision || index < 0) {
        player.log?.('[SessionCommand] load: the session does not have that queue yet', { revision: session.revision, wanted: command.revision });
        return false;
      }
      await player.playQueue(player.toTracks(session), index);
      return true;
    }
    default:
      return false;
  }
}
