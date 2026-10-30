import { EventEmitter } from 'events';
import crypto from 'crypto';
import { initDB } from '../database';
import { getLibraryRevision } from './apiV1Dto.service';

export type ApiV1EventType =
  | 'playbackSession.created'
  | 'playbackSession.updated'
  | 'playbackSession.handedOff'
  | 'playbackSession.deleted'
  | 'playbackSession.progress'
  | 'playbackSession.command'
  | 'playlist.changed'
  | 'annotation.changed'
  | 'library.revision'
  | 'playbackSync.changed'
  | 'devices.changed'
  | 'playbackSession.transferRequested'
  // Listen together (docs/listen-together.md, 6c)
  | 'playbackSession.memberJoined'
  | 'playbackSession.memberLeft'
  | 'playbackSession.visibilityChanged'
  | 'playbackSession.togetherEnded'
  | 'playbackSession.invitePrompt'
  | 'playbackSession.accessChanged'
  | 'playbackSession.discoverable';

export interface ApiV1Event {
  id: string;
  type: ApiV1EventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(250);
const history = new Map<string, ApiV1Event[]>();
const HISTORY_LIMIT = 200;

/**
 * A `transient` event goes to connected clients only and is never replayed:
 * position heartbeats every ten seconds would otherwise push the events a
 * reconnecting client needs out of the replay window. The next heartbeat
 * replaces a missed one anyway.
 */
export function publishApiV1Event(
  userId: string,
  type: ApiV1EventType,
  data: Record<string, unknown>,
  options: { transient?: boolean } = {},
) {
  const event: ApiV1Event = {
    id: crypto.randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
  if (!options.transient) {
    const events = history.get(userId) || [];
    events.push(event);
    if (events.length > HISTORY_LIMIT) events.splice(0, events.length - HISTORY_LIMIT);
    history.set(userId, events);
  }
  emitter.emit(userId, event);
  return event;
}

/** Broadcast a global library change into each user's isolated event stream. */
export async function publishApiV1LibraryRevision(data: Record<string, unknown> = {}) {
  try {
    const db = await initDB();
    const [revision, users] = await Promise.all([
      getLibraryRevision(),
      db.query('SELECT id FROM users'),
    ]);
    for (const row of users.rows) {
      publishApiV1Event(String(row.id), 'library.revision', { revision, ...data });
    }
    return revision;
  } catch (error) {
    // Invalidations are best-effort and must never turn a successful library
    // mutation into a failed scan. Reconnect/resync still repairs missed SSE.
    console.error('[API v1] failed to publish library revision:', error);
    return null;
  }
}

/**
 * Which of a user's devices have an event stream open right now, by client
 * ID. Remote commands reach a device only through its stream, so one sent to
 * a device with none would go nowhere (a phone whose app was closed).
 */
export type ConnectedDeviceKind = 'browser' | 'receiver' | 'app';
export type ConnectedDevice = { clientId: string; name: string | null; kind: ConnectedDeviceKind };

// The user's devices with an event stream open now: those remote commands
// and transfers can reach, and the Connect menu lists (GET /devices).
// Each with the address its stream comes from, for gigs nearby (6e).
const listening = new Map<string, Map<string, { count: number; name: string | null; kind: ConnectedDeviceKind; ip: string | null }>>();

/** The users with Aurora open somewhere now (an event stream open): who can be prompted to join. */
export function listOnlineUserIds(): string[] {
  return Array.from(listening.keys());
}

/** The public addresses the user's open streams come from (docs/listen-together.md, Discovery). */
export function addressesOf(userId: string): Set<string> {
  const addresses = new Set<string>();
  for (const device of listening.get(userId)?.values() ?? []) if (device.ip) addresses.add(device.ip);
  return addresses;
}

/** The users with a stream open from any of `addresses`: who is "nearby". */
export function usersAt(addresses: Set<string>): string[] {
  if (addresses.size === 0) return [];
  return Array.from(listening.entries())
    .filter(([, clients]) => Array.from(clients.values()).some((device) => !!device.ip && addresses.has(device.ip)))
    .map(([userId]) => userId);
}

/** The user's devices that have Aurora open now, one entry per device. */
export function listConnectedDevices(userId: string): ConnectedDevice[] {
  return Array.from(listening.get(userId)?.entries() ?? [], ([clientId, device]) => ({ clientId, name: device.name, kind: device.kind }));
}

// A device appeared or went away: every open stream of the user hears the
// new list (live only), so device lists update without polling.
function publishDevicesChanged(userId: string) {
  publishApiV1Event(userId, 'devices.changed', { devices: listConnectedDevices(userId) }, { transient: true });
}

/** Records an open stream for `clientId`; call the returned function when it closes. */
export function noteClientListening(
  userId: string,
  clientId: string,
  device: { name?: string | null; kind?: ConnectedDeviceKind; ip?: string | null } = {},
): () => void {
  const clients = listening.get(userId) ?? new Map();
  const existing = clients.get(clientId);
  clients.set(clientId, {
    count: (existing?.count ?? 0) + 1,
    name: device.name ?? existing?.name ?? null,
    kind: device.kind ?? existing?.kind ?? 'browser',
    ip: device.ip ?? existing?.ip ?? null,
  });
  listening.set(userId, clients);
  if (!existing) publishDevicesChanged(userId);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const current = clients.get(clientId);
    if (!current) return;
    if (current.count > 1) {
      clients.set(clientId, { ...current, count: current.count - 1 });
      return;
    }
    clients.delete(clientId);
    if (clients.size === 0) listening.delete(userId);
    publishDevicesChanged(userId);
  };
}

export function isClientListening(userId: string, clientId: string): boolean {
  return (listening.get(userId)?.get(clientId)?.count ?? 0) > 0;
}

export function subscribeApiV1Events(userId: string, listener: (event: ApiV1Event) => void) {
  emitter.on(userId, listener);
  return () => emitter.off(userId, listener);
}

export function replayApiV1Events(userId: string, afterId?: string): ApiV1Event[] | null {
  if (!afterId) return [];
  const events = history.get(userId) || [];
  const index = events.findIndex((event) => event.id === afterId);
  return index === -1 ? null : events.slice(index + 1);
}
