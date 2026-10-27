import { accessFor, commandNeed, decideSessionAccess, missingScope, OWNER_ONLY, patchNeed, READ, type SessionNeed } from './sessionAccess';

/**
 * Who may do what with a playback session (docs/listen-together.md, 6b): one
 * table of every kind of operation against the owner, a guest with all scopes,
 * a guest with one scope, and a stranger.
 */
const owner = accessFor({ ownerId: 'andreas', viewerId: 'andreas', memberPermissions: null });
const guestAll = accessFor({ ownerId: 'andreas', viewerId: 'guest', memberPermissions: ['transport', 'queue', 'replace'] });
const guestTransport = accessFor({ ownerId: 'andreas', viewerId: 'guest', memberPermissions: ['transport'] });
const stranger = accessFor({ ownerId: 'andreas', viewerId: 'stranger', memberPermissions: null });

const patch = (operations: object[]) => patchNeed({ expectedRevision: 1, operations } as never);
const OPERATIONS: Array<[string, SessionNeed]> = [
  ['read the session', READ],
  ['play / pause / seek (setTransport)', patch([{ type: 'setTransport', playbackState: 'playing', positionMs: 0 }])],
  ['jump to an entry (setTransport currentEntryId)', patch([{ type: 'setTransport', currentEntryId: null }])],
  ['repeat / shuffle', patch([{ type: 'setTransport', repeatMode: 'all', shuffle: true }])],
  ['Infinity on/off', patch([{ type: 'setTransport', infinity: true }])],
  ['insert / play next', patch([{ type: 'insert', trackIds: ['t'] }])],
  ['move', patch([{ type: 'move', queueEntryId: 'e' }])],
  ['remove', patch([{ type: 'remove', queueEntryIds: ['e'] }])],
  ['start something new (replaceQueue)', patch([{ type: 'replaceQueue', trackIds: ['t'] }])],
  ['command play', commandNeed({ type: 'play' })],
  ['command next', commandNeed({ type: 'next' })],
  ['command load', commandNeed({ type: 'load', revision: 1, entryId: 'e' })],
  ['claim the output / transfer / refresh / delete', OWNER_ONLY],
];

it.each(OPERATIONS)('%s', (_name, need) => {
  expect(decideSessionAccess(owner, need)).toBe('allow');
  expect(decideSessionAccess(stranger, need)).toBe('not-found');
  expect(decideSessionAccess(guestAll, need)).toBe(need.kind === 'owner' ? 'owner-only' : 'allow');
  const transportOnly = decideSessionAccess(guestTransport, need);
  if (need.kind === 'owner') expect(transportOnly).toBe('owner-only');
  else if (need.kind === 'read' || need.scopes.every((scope) => scope === 'transport')) expect(transportOnly).toBe('allow');
  else expect(transportOnly).toBe('scope-denied');
});

it('maps each operation to the scope agreed with Andreas (2026-10-27)', () => {
  expect(patch([{ type: 'setTransport', playbackState: 'paused' }])).toEqual({ kind: 'scopes', scopes: ['transport'] });
  expect(patch([{ type: 'setTransport', shuffle: true }])).toEqual({ kind: 'scopes', scopes: ['queue'] });
  expect(patch([{ type: 'setTransport', infinity: false }])).toEqual({ kind: 'scopes', scopes: ['replace'] });
  expect(patch([{ type: 'replaceQueue', trackIds: [] }])).toEqual({ kind: 'scopes', scopes: ['replace'] });
  expect(commandNeed({ type: 'seek', positionMs: 1 })).toEqual({ kind: 'scopes', scopes: ['transport'] });
  expect(commandNeed({ type: 'load', revision: 1, entryId: 'e' })).toEqual({ kind: 'scopes', scopes: ['replace'] });
  // A patch that does two things needs both.
  expect(patch([{ type: 'insert', trackIds: ['t'] }, { type: 'setTransport', currentEntryId: null }]).kind === 'scopes'
    && (patch([{ type: 'insert', trackIds: ['t'] }, { type: 'setTransport', currentEntryId: null }]) as { scopes: string[] }).scopes.sort())
    .toEqual(['queue', 'transport']);
});

it('names the scope a guest lacks, and ignores scopes it does not know', () => {
  expect(missingScope(guestTransport!, patch([{ type: 'remove', queueEntryIds: ['e'] }]))).toBe('queue');
  expect(accessFor({ ownerId: 'a', viewerId: 'g', memberPermissions: ['transport', 'admin'] })?.permissions).toEqual(['transport']);
});
