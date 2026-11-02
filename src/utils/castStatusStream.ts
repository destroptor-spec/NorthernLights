import type { EventSourceLike } from './SessionFollower';

const EVENTS_PATH = '/api/v1/events';

export interface CastStatusStreamState {
  castConnected: boolean;
  syncPlaybackAcrossDevices: boolean;
  currentUser: { id: string } | null;
  authToken: string | null;
  sseAccessToken: string | null;
}

/**
 * The receiver's relayed status (cast.status, docs/cast-takeover.md) with
 * sync off. With sync on, the session follower's event stream carries it;
 * with sync off nothing opens /api/v1/events (only /playback-sessions is
 * switched off), so this opens one while the device casts, for that event
 * alone. A sender with a one-way Cast connection hears the receiver this way.
 */
export class CastStatusStream {
  private source: EventSourceLike | null = null;
  private key = '';

  constructor(private readonly deps: {
    onStatus: (castSessionId: unknown, status: unknown) => void;
    createEventSource?: (url: string) => EventSourceLike;
  }) {}

  update(state: CastStatusStreamState) {
    const token = state.sseAccessToken;
    // Never the full session token in a URL: only the scoped sse token.
    const wanted = state.castConnected && !state.syncPlaybackAcrossDevices && state.currentUser && token && token !== state.authToken
      ? `${state.currentUser.id}\n${token}` : '';
    if (wanted === this.key) return;
    this.close();
    this.key = wanted;
    if (!wanted || !token) return;
    const create = this.deps.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    const source = create(`${EVENTS_PATH}?token=${encodeURIComponent(token)}`);
    this.source = source;
    source.addEventListener('cast.status', (event) => {
      if (this.source !== source) return;
      let data: Record<string, unknown> = {};
      try {
        data = (JSON.parse(event.data) as { data?: Record<string, unknown> }).data ?? {};
      } catch {
        return;
      }
      this.deps.onStatus(data.castSessionId, data.status);
    });
  }

  close() {
    this.source?.close();
    this.source = null;
    this.key = '';
  }
}
