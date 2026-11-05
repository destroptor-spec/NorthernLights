import { SESSION_SCOPES, type PlaybackCommandRequest, type PlaybackSessionPatch } from '../../shared/api/v1';

/**
 * Who may do what with a playback session (docs/listen-together.md, 6b).
 *
 * The owner (the user who started it) may do everything, and alone chooses
 * where it plays. A guest (a member, 6c) may do what its scopes allow. Anyone
 * else does not see the session at all: the answer is 404, so a session ID
 * never confirms that a session exists.
 *
 * Every session operation maps to one need below; the routes and the service
 * ask decideSessionAccess, and its tests are one table.
 */
export type SessionScope = typeof SESSION_SCOPES[number];

export type SessionAccess =
  | { role: 'owner'; ownerId: string; permissions: SessionScope[] }
  | { role: 'guest'; ownerId: string; permissions: SessionScope[] };

/** What an operation needs: to see the session, a set of scopes, or the owner. */
export type SessionNeed = { kind: 'read' } | { kind: 'scopes'; scopes: SessionScope[] } | { kind: 'owner' };

export type SessionDecision = 'allow' | 'not-found' | 'owner-only' | 'scope-denied';

export const READ: SessionNeed = { kind: 'read' };
export const OWNER_ONLY: SessionNeed = { kind: 'owner' };

export function accessFor(input: { ownerId: string; viewerId: string; memberPermissions: string[] | null }): SessionAccess | null {
  if (input.ownerId === input.viewerId) return { role: 'owner', ownerId: input.ownerId, permissions: [...SESSION_SCOPES] };
  if (!input.memberPermissions) return null;
  const permissions = SESSION_SCOPES.filter((scope) => input.memberPermissions!.includes(scope));
  return { role: 'guest', ownerId: input.ownerId, permissions };
}

export function decideSessionAccess(access: SessionAccess | null, need: SessionNeed): SessionDecision {
  if (!access) return 'not-found';
  if (access.role === 'owner') return 'allow';
  if (need.kind === 'read') return 'allow';
  if (need.kind === 'owner') return 'owner-only';
  return need.scopes.every((scope) => access.permissions.includes(scope)) ? 'allow' : 'scope-denied';
}

/** The first scope a guest lacks for a need, for the error's details. */
export function missingScope(access: SessionAccess, need: SessionNeed): SessionScope | null {
  if (need.kind !== 'scopes') return null;
  return need.scopes.find((scope) => !access.permissions.includes(scope)) ?? null;
}

/**
 * The scopes a patch needs, operation by operation: start something new
 * (replace the queue, Infinity) is `replace`; editing the queue, repeat and
 * shuffle are `queue`; moving through it (current entry, position, play
 * state) is `transport`.
 */
export function patchNeed(patch: PlaybackSessionPatch): SessionNeed {
  const scopes = new Set<SessionScope>();
  for (const operation of patch.operations) {
    switch (operation.type) {
      case 'replaceQueue':
        scopes.add('replace');
        break;
      case 'insert':
      case 'remove':
      case 'move':
        scopes.add('queue');
        break;
      case 'setTransport':
        if (operation.currentEntryId !== undefined || operation.positionMs !== undefined || operation.playbackState !== undefined) scopes.add('transport');
        if (operation.repeatMode !== undefined || operation.shuffle !== undefined) scopes.add('queue');
        if (operation.infinity !== undefined) scopes.add('replace');
        break;
    }
  }
  return { kind: 'scopes', scopes: [...scopes] };
}

/**
 * A remote command: `load` starts something new (replace); the rest move
 * through the queue, and set the volume (transport: Playback Control).
 */
export function commandNeed(command: PlaybackCommandRequest['command']): SessionNeed {
  return { kind: 'scopes', scopes: [command.type === 'load' ? 'replace' : 'transport'] };
}
