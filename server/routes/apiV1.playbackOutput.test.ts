/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
jest.mock('../services/playbackSession.service', () => ({
  ...jest.requireActual('../services/playbackSession.service'),
  claimPlaybackOutput: jest.fn(),
  getCurrentOutputGrant: jest.fn(),
  reportPlaybackOutput: jest.fn(),
  issuePlaybackCommand: jest.fn(),
  patchPlaybackSession: jest.fn(),
  getPlaybackSession: jest.fn(),
}));
jest.mock('../services/sessionInfinity.service', () => ({ topUpSessionInfinity: jest.fn(async () => 0) }));
jest.mock('../services/sessionListens.service', () => ({ noteSessionReport: jest.fn(async () => undefined), forgetSessionListen: jest.fn() }));
jest.mock('../services/scopedToken.service', () => ({
  ...jest.requireActual('../services/scopedToken.service'),
  generateOutputCredential: jest.fn(async () => ({ token: 'output-token', expiresAt: '2026-10-13T12:00:00.000Z' })),
  generateEphemeralScopedToken: jest.fn(async () => 'scoped-token'),
  generateReceiverCredential: jest.fn(async () => ({
    token: 'receiver-token', expiresAt: '2026-10-14T00:00:00.000Z', cap: '2026-10-14T12:00:00.000Z',
  })),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { playbackOutputClaimResultSchema, playbackOutputCredentialSchema, type PlaybackSession } from '../../shared/api/v1';
import {
  claimPlaybackOutput,
  getCurrentOutputGrant,
  PlaybackOutputGrantReplacedError,
  PlaybackOutputIdentityError,
  reportPlaybackOutput,
  issuePlaybackCommand,
  PlaybackOutputNotActiveError,
  PlaybackOutputUnreachableError,
  patchPlaybackSession,
  PlaybackSessionCurrentEntryError,
  getPlaybackSession,
} from '../services/playbackSession.service';
import { generateEphemeralScopedToken, generateOutputCredential, generateReceiverCredential } from '../services/scopedToken.service';
import { isClientListening, noteClientListening, publishApiV1Event, subscribeApiV1Events } from '../services/apiV1Events.service';
import { topUpSessionInfinity } from '../services/sessionInfinity.service';
import { noteSessionReport } from '../services/sessionListens.service';

const principal = { userId: 'user-1', username: 'andreas', role: 'admin', authKind: 'jwt', clientId: 'laptop-5678', clientName: 'Aurora Web' };

async function call(method: 'get' | 'post' | 'patch', path: string, body: unknown, params: Record<string, string> = {}, apiV1: Record<string, unknown> = principal) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === method))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn() };
  const req = { apiV1, requestId: 'r1', body, params, headers: {} } as unknown as Request;
  for (const handler of layer.route!.stack) await handler.handle(req, res as unknown as Response, jest.fn());
  return { status: res.status.mock.calls.at(-1)?.[0] ?? 200, body: res.json.mock.calls.at(-1)?.[0] };
}

const session = (output: PlaybackSession['output']): PlaybackSession => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Listening',
  ownerClientId: 'laptop-5678',
  output,
  currentEntryId: null,
  positionMs: 0,
  playbackState: 'paused',
  repeatMode: 'none',
  shuffle: false,
  infinity: false,
  source: null,
  revision: 4,
  queue: [],
  access: { role: 'owner', permissions: ['transport', 'queue', 'replace'] },
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T11:00:00.000Z',
});
const output = { id: 'laptop-5678', kind: 'browser' as const, name: 'Aurora Web', generation: 2, claimedAt: '2026-10-13T11:00:00.000Z', status: 'active' as const, report: null };

beforeEach(() => jest.clearAllMocks());

it('claims the output for the calling device and returns its grant credential', async () => {
  (claimPlaybackOutput as jest.Mock).mockResolvedValue(session(output));
  const { status, body } = await call('post', '/playback-sessions/:id/output', { kind: 'browser', name: 'Aurora Web' }, { id: 's-1' });
  expect(status).toBe(200);
  expect(claimPlaybackOutput).toHaveBeenCalledWith({
    userId: 'user-1', clientId: 'laptop-5678', sessionId: 's-1', output: { kind: 'browser', name: 'Aurora Web' },
  });
  expect(generateOutputCredential).toHaveBeenCalledWith(principal, {
    sid: '11111111-1111-4111-8111-111111111111', oid: 'laptop-5678', gen: 2,
  });
  expect(playbackOutputClaimResultSchema.safeParse(body.data).success).toBe(true);
  expect(body.data.credential).toMatchObject({ token: 'output-token', outputId: 'laptop-5678', generation: 2 });
});

it('refuses an unknown output kind', async () => {
  const { status } = await call('post', '/playback-sessions/:id/output', { kind: 'speaker' }, { id: 's-1' });
  expect(status).toBe(400);
  expect(claimPlaybackOutput).not.toHaveBeenCalled();
});

it('refreshes the credential for the current grant only', async () => {
  (getCurrentOutputGrant as jest.Mock).mockResolvedValueOnce({ sid: 's-1', oid: 'laptop-5678', gen: 2 });
  const fresh = await call('post', '/playback-sessions/:id/output/refresh', { outputId: 'laptop-5678', generation: 2 }, { id: 's-1' });
  expect(fresh.status).toBe(200);
  expect(playbackOutputCredentialSchema.safeParse(fresh.body.data).success).toBe(true);

  (getCurrentOutputGrant as jest.Mock).mockRejectedValueOnce(new PlaybackOutputGrantReplacedError(session({ ...output, id: 'phone-1234', generation: 3 })));
  const stale = await call('post', '/playback-sessions/:id/output/refresh', { outputId: 'laptop-5678', generation: 2 }, { id: 's-1' });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('OUTPUT_GRANT_REPLACED');
  expect(stale.body.error.details.current.output.id).toBe('phone-1234');
  expect(generateOutputCredential).toHaveBeenCalledTimes(1);
});

it('never mints an output credential from the generic scoped-token endpoint', async () => {
  const { status } = await call('post', '/auth/scoped-token', { scope: 'output' });
  expect(status).toBe(400);
  expect(generateEphemeralScopedToken).not.toHaveBeenCalled();
  expect(generateOutputCredential).not.toHaveBeenCalled();
});

describe('output reports', () => {
  const outputPrincipal = {
    userId: 'user-1', username: 'andreas', role: 'admin', authKind: 'scoped', scope: 'output',
    clientId: 'laptop-5678', clientName: 'Aurora playback output', outputGrant: { sid: 's-1', oid: 'laptop-5678', gen: 2 },
  };
  const body = { seq: 3, state: 'playing', queueEntryId: '22222222-2222-4222-8222-222222222222', positionMs: 41000 };

  it('passes the identity from the credential, not the body', async () => {
    (reportPlaybackOutput as jest.Mock).mockResolvedValue({ accepted: true, revision: 5 });
    const { status, body: response } = await call('post', '/playback-sessions/:id/reports', body, { id: 's-1' }, outputPrincipal);
    expect(status).toBe(200);
    expect(response.data).toEqual({ accepted: true, revision: 5 });
    expect(reportPlaybackOutput).toHaveBeenCalledWith({ userId: 'user-1', grant: { sid: 's-1', oid: 'laptop-5678', gen: 2 }, sessionId: 's-1', report: body });
  });

  it("refuses a controller's own session token, even one that knows the generation", async () => {
    const { status, body: response } = await call('post', '/playback-sessions/:id/reports',
      { ...body, outputId: 'laptop-5678', outputGeneration: 2 }, { id: 's-1' });
    expect(status).toBe(403);
    expect(response.error.code).toBe('OUTPUT_CREDENTIAL_REQUIRED');
    expect(reportPlaybackOutput).not.toHaveBeenCalled();
  });

  it('answers a body that disagrees with its credential with 422, and a replaced grant with 409', async () => {
    (reportPlaybackOutput as jest.Mock).mockRejectedValueOnce(new PlaybackOutputIdentityError());
    const mismatch = await call('post', '/playback-sessions/:id/reports', { ...body, outputGeneration: 1 }, { id: 's-1' }, outputPrincipal);
    expect([mismatch.status, mismatch.body.error.code]).toEqual([422, 'OUTPUT_IDENTITY_MISMATCH']);

    (reportPlaybackOutput as jest.Mock).mockRejectedValueOnce(new PlaybackOutputGrantReplacedError(session({ ...output, id: 'phone-1234', generation: 3 })));
    const replaced = await call('post', '/playback-sessions/:id/reports', body, { id: 's-1' }, outputPrincipal);
    expect([replaced.status, replaced.body.error.code]).toEqual([409, 'OUTPUT_GRANT_REPLACED']);
  });

  it('refuses a malformed report', async () => {
    const { status } = await call('post', '/playback-sessions/:id/reports', { ...body, state: 'dancing' }, { id: 's-1' }, outputPrincipal);
    expect(status).toBe(400);
  });
});

describe('remote commands', () => {
  const body = (command: unknown, extra: Record<string, unknown> = {}) => ({
    requestId: '22222222-2222-4222-8222-222222222222', outputId: 'desktop-5678', outputGeneration: 3, command, ...extra,
  });

  it('sends a command and answers 202', async () => {
    (issuePlaybackCommand as jest.Mock).mockResolvedValue({ accepted: true });
    const { status, body: response } = await call('post', '/playback-sessions/:id/commands', body({ type: 'seek', positionMs: 42_000 }), { id: 's-1' });
    expect(status).toBe(202);
    expect(response.data).toEqual({ accepted: true });
    expect(issuePlaybackCommand).toHaveBeenCalledWith({
      userId: 'user-1', clientId: 'laptop-5678', sessionId: 's-1',
      request: body({ type: 'seek', positionMs: 42_000 }),
    });
  });

  it('refuses a command it does not know, or one with stray fields', async () => {
    for (const command of [{ type: 'shuffle' }, { type: 'pause', positionMs: 1 }, { type: 'jump', entryId: 'not-a-uuid' }]) {
      const { status } = await call('post', '/playback-sessions/:id/commands', body(command), { id: 's-1' });
      expect(status).toBe(400);
    }
    expect(issuePlaybackCommand).not.toHaveBeenCalled();
  });

  it('says when the output has changed or nothing plays', async () => {
    (issuePlaybackCommand as jest.Mock).mockRejectedValueOnce(new PlaybackOutputGrantReplacedError(session(output)));
    expect((await call('post', '/playback-sessions/:id/commands', body({ type: 'next' }), { id: 's-1' })).body.error)
      .toMatchObject({ code: 'OUTPUT_GRANT_REPLACED' });
    (issuePlaybackCommand as jest.Mock).mockRejectedValueOnce(new PlaybackOutputNotActiveError(session(null)));
    const notActive = await call('post', '/playback-sessions/:id/commands', body({ type: 'next' }), { id: 's-1' });
    expect(notActive.status).toBe(409);
    expect(notActive.body.error).toMatchObject({ code: 'OUTPUT_NOT_ACTIVE' });
    (issuePlaybackCommand as jest.Mock).mockRejectedValueOnce(new PlaybackOutputUnreachableError(session(output)));
    expect((await call('post', '/playback-sessions/:id/commands', body({ type: 'next' }), { id: 's-1' })).body.error)
      .toMatchObject({ code: 'OUTPUT_UNREACHABLE' });
  });
});


describe('a Cast receiver as the output', () => {
  const receiverOutput = {
    id: 'receiver:cast-77', kind: 'receiver' as const, name: 'NAD Forstærker', castSessionId: 'cast-77',
    generation: 3, claimedAt: '2026-10-14T11:00:00.000Z', status: 'active' as const, report: null,
  };
  const receiverPrincipal = {
    userId: 'user-1', username: 'andreas', role: 'admin', authKind: 'scoped', scope: 'receiver',
    clientId: 'receiver:cast-77', clientName: 'Aurora Cast receiver',
    outputGrant: { sid: 's-1', oid: 'receiver:cast-77', gen: 3 }, receiverCap: 1_900_000_000,
  };

  it('is claimed by a controller, which gets the receiver credential to hand over', async () => {
    (claimPlaybackOutput as jest.Mock).mockResolvedValue(session(receiverOutput));
    const claim = { kind: 'receiver', name: 'NAD Forstærker', castSessionId: 'cast-77' };
    const { status, body } = await call('post', '/playback-sessions/:id/output', claim, { id: 's-1' });
    expect(status).toBe(200);
    expect(claimPlaybackOutput).toHaveBeenCalledWith({ userId: 'user-1', clientId: 'laptop-5678', sessionId: 's-1', output: claim });
    expect(generateReceiverCredential).toHaveBeenCalledWith(principal, {
      sid: '11111111-1111-4111-8111-111111111111', oid: 'receiver:cast-77', gen: 3,
    });
    expect(generateOutputCredential).not.toHaveBeenCalled();
    expect(playbackOutputClaimResultSchema.safeParse(body.data).success).toBe(true);
    expect(body.data.credential).toEqual({
      token: 'receiver-token', expiresAt: '2026-10-14T00:00:00.000Z', renewableUntil: '2026-10-14T12:00:00.000Z',
      outputId: 'receiver:cast-77', generation: 3,
    });
  });

  it('must name the Cast session the receiver runs in', async () => {
    const { status } = await call('post', '/playback-sessions/:id/output', { kind: 'receiver', name: 'NAD' }, { id: 's-1' });
    expect(status).toBe(400);
    expect(claimPlaybackOutput).not.toHaveBeenCalled();
  });

  it("gets a fresh credential, with a new cap, when a controller refreshes the receiver's grant", async () => {
    (getCurrentOutputGrant as jest.Mock).mockResolvedValueOnce({ sid: 's-1', oid: 'receiver:cast-77', gen: 3, kind: 'receiver' });
    const { status, body } = await call('post', '/playback-sessions/:id/output/refresh', { outputId: 'receiver:cast-77', generation: 3 }, { id: 's-1' });
    expect(status).toBe(200);
    expect(generateReceiverCredential).toHaveBeenCalledWith(principal, { sid: 's-1', oid: 'receiver:cast-77', gen: 3 });
    expect(playbackOutputCredentialSchema.safeParse(body.data).success).toBe(true);
    expect(body.data).toMatchObject({ token: 'receiver-token', renewableUntil: '2026-10-14T12:00:00.000Z' });
  });

  it('renews its own credential for its current grant, keeping the cap', async () => {
    (getCurrentOutputGrant as jest.Mock).mockResolvedValueOnce({ sid: 's-1', oid: 'receiver:cast-77', gen: 3, kind: 'receiver' });
    const { status, body } = await call('post', '/playback-sessions/:id/output/renew', {}, { id: 's-1' }, receiverPrincipal);
    expect(status).toBe(200);
    expect(getCurrentOutputGrant).toHaveBeenCalledWith({ userId: 'user-1', sessionId: 's-1', outputId: 'receiver:cast-77', generation: 3 });
    expect(generateReceiverCredential).toHaveBeenCalledWith(receiverPrincipal, { sid: 's-1', oid: 'receiver:cast-77', gen: 3 }, 1_900_000_000);
    expect(playbackOutputCredentialSchema.safeParse(body.data).success).toBe(true);
    // A fresh 12-hour media token with it, so the receiver never streams with
    // the owner's login one (docs/listen-together.md, 6a-2).
    expect(generateEphemeralScopedToken).toHaveBeenCalledWith('media', expect.objectContaining({ userId: 'user-1' }), '12h');
    expect(body.data.mediaToken).toBe('scoped-token');
  });

  it('cannot renew a replaced grant, or past its cap', async () => {
    (getCurrentOutputGrant as jest.Mock).mockRejectedValueOnce(new PlaybackOutputGrantReplacedError(session(output)));
    const replaced = await call('post', '/playback-sessions/:id/output/renew', {}, { id: 's-1' }, receiverPrincipal);
    expect([replaced.status, replaced.body.error.code]).toEqual([409, 'OUTPUT_GRANT_REPLACED']);
    expect(generateReceiverCredential).not.toHaveBeenCalled();

    (getCurrentOutputGrant as jest.Mock).mockResolvedValueOnce({ sid: 's-1', oid: 'receiver:cast-77', gen: 3, kind: 'receiver' });
    (generateReceiverCredential as jest.Mock).mockResolvedValueOnce(null);
    const capped = await call('post', '/playback-sessions/:id/output/renew', {}, { id: 's-1' }, receiverPrincipal);
    expect([capped.status, capped.body.error.code]).toEqual([401, 'RECEIVER_RENEWAL_EXPIRED']);
  });

  it('renews only with a receiver credential', async () => {
    const outputPrincipal = { ...receiverPrincipal, scope: 'output', receiverCap: undefined };
    for (const caller of [principal, outputPrincipal]) {
      const { status, body } = await call('post', '/playback-sessions/:id/output/renew', {}, { id: 's-1' }, caller);
      expect([status, body.error.code]).toEqual([403, 'RECEIVER_CREDENTIAL_REQUIRED']);
    }
    expect(getCurrentOutputGrant).not.toHaveBeenCalled();
  });

  it('reports with its credential, as its own output', async () => {
    (reportPlaybackOutput as jest.Mock).mockResolvedValue({ accepted: true, revision: 5 });
    const report = { seq: 1, state: 'playing', queueEntryId: null, positionMs: 0 };
    const { status } = await call('post', '/playback-sessions/:id/reports', report, { id: 's-1' }, receiverPrincipal);
    expect(status).toBe(200);
    expect(reportPlaybackOutput).toHaveBeenCalledWith({
      userId: 'user-1', grant: { sid: 's-1', oid: 'receiver:cast-77', gen: 3 }, sessionId: 's-1', report,
    });
  });

  it('is never minted by the generic scoped-token endpoint', async () => {
    const { status } = await call('post', '/auth/scoped-token', { scope: 'receiver', expiresIn: '12h' });
    expect(status).toBe(400);
    expect(generateEphemeralScopedToken).not.toHaveBeenCalled();
  });

  it("hears only its own session's events, and its stream lets commands reach it", async () => {
    const layer = router.stack.find((l) => l.route?.path === '/events')!;
    const written: string[] = [];
    let close = () => undefined as void;
    const req = {
      apiV1: { ...receiverPrincipal, userId: 'user-events' }, requestId: 'r1', headers: {}, query: {},
      on: (event: string, handler: () => void) => { if (event === 'close') close = handler; },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(), setHeader: jest.fn(), flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => { written.push(chunk); return true; }),
    };
    await layer.route!.stack[0].handle(req, res as unknown as Response, jest.fn());
    try {
      expect(isClientListening('user-events', 'receiver:cast-77')).toBe(true);
      publishApiV1Event('user-events', 'playbackSession.updated', { sessionId: 's-1', revision: 6 });
      publishApiV1Event('user-events', 'playbackSession.updated', { sessionId: 's-2', revision: 9 });
      publishApiV1Event('user-events', 'playlist.changed', { playlistId: 'p-1' });
      publishApiV1Event('user-events', 'playbackSync.changed', { enabled: true });
      const events = written.filter((chunk) => chunk.startsWith('event: ')).map((chunk) => chunk.trim());
      expect(events).toEqual(['event: playbackSession.updated', 'event: playbackSync.changed']);
      expect(written.join('')).not.toContain('s-2');
    } finally {
      close();
    }
    expect(isClientListening('user-events', 'receiver:cast-77')).toBe(false);
  });
});

describe('Infinity kept by the server (Phase 4)', () => {
  const outputPrincipal = {
    userId: 'user-1', username: 'andreas', role: 'admin', authKind: 'scoped', scope: 'receiver',
    clientId: 'receiver:cast-77', clientName: 'Aurora Cast receiver', outputGrant: { sid: 's-1', oid: 'receiver:cast-77', gen: 3 },
  };
  const report = { seq: 4, state: 'playing', queueEntryId: '22222222-2222-4222-8222-222222222222', positionMs: 0 };

  it('tops up after a report that moved to another entry, and not after a position report', async () => {
    (reportPlaybackOutput as jest.Mock).mockResolvedValueOnce({ accepted: true, revision: 6, entryChanged: true });
    const moved = await call('post', '/playback-sessions/:id/reports', report, { id: 's-1' }, outputPrincipal);
    expect(moved.body.data).toEqual({ accepted: true, revision: 6 }); // the reporter sees no more than before
    expect(topUpSessionInfinity).toHaveBeenCalledWith('user-1', 's-1');

    (topUpSessionInfinity as jest.Mock).mockClear();
    (reportPlaybackOutput as jest.Mock).mockResolvedValueOnce({ accepted: true, revision: 6, entryChanged: false });
    await call('post', '/playback-sessions/:id/reports', { ...report, seq: 5, positionMs: 10_000 }, { id: 's-1' }, outputPrincipal);
    expect(topUpSessionInfinity).not.toHaveBeenCalled();
  });

  it('counts plays and scrobbles from every accepted report, and never from a stale one', async () => {
    (noteSessionReport as jest.Mock).mockClear();
    (reportPlaybackOutput as jest.Mock).mockResolvedValueOnce({ accepted: true, revision: 6, entryChanged: false });
    await call('post', '/playback-sessions/:id/reports', { ...report, seq: 6, positionMs: 20_000 }, { id: 's-1' }, outputPrincipal);
    expect(noteSessionReport).toHaveBeenCalledWith('user-1', 's-1', expect.objectContaining({ state: 'playing', positionMs: 20_000 }));

    (noteSessionReport as jest.Mock).mockClear();
    (reportPlaybackOutput as jest.Mock).mockResolvedValueOnce({ accepted: false, revision: 6 });
    await call('post', '/playback-sessions/:id/reports', { ...report, seq: 2 }, { id: 's-1' }, outputPrincipal);
    expect(noteSessionReport).not.toHaveBeenCalled();
  });

  it('tops up once a device claims the output, for itself or a receiver', async () => {
    (claimPlaybackOutput as jest.Mock).mockResolvedValueOnce(session(output));
    await call('post', '/playback-sessions/:id/output', { kind: 'browser', name: 'Aurora Web' }, { id: 's-1' });
    expect(topUpSessionInfinity).toHaveBeenCalledWith('user-1', '11111111-1111-4111-8111-111111111111');
    (topUpSessionInfinity as jest.Mock).mockClear();

    (claimPlaybackOutput as jest.Mock).mockResolvedValue(session({
      id: 'receiver:cast-77', kind: 'receiver', name: 'NAD', castSessionId: 'cast-77',
      generation: 3, claimedAt: '2026-10-14T11:00:00.000Z', status: 'active', report: null,
    }));
    await call('post', '/playback-sessions/:id/output', { kind: 'receiver', name: 'NAD', castSessionId: 'cast-77' }, { id: 's-1' });
    expect(topUpSessionInfinity).toHaveBeenCalledWith('user-1', '11111111-1111-4111-8111-111111111111');
  });
});

it('refuses removing the entry that plays with 409 CURRENT_ENTRY_PLAYING and the current session (Phase 3)', async () => {
  const refusal = new PlaybackSessionCurrentEntryError('22222222-2222-4222-8222-222222222222');
  refusal.current = session(output);
  (patchPlaybackSession as jest.Mock).mockRejectedValueOnce(refusal);
  const { status, body } = await call('patch', '/playback-sessions/:id', {
    expectedRevision: 4, operations: [{ type: 'remove', queueEntryIds: ['22222222-2222-4222-8222-222222222222'] }],
  }, { id: 's-1' });
  expect(status).toBe(409);
  expect(body.error).toMatchObject({ code: 'CURRENT_ENTRY_PLAYING', details: { entryId: '22222222-2222-4222-8222-222222222222', current: { revision: 4 } } });
});

describe('the device list and transfers (Connect)', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const watch = () => {
    const heard: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeApiV1Events('user-1', (event) => heard.push(event));
    return { heard, unsubscribe };
  };

  it("lists the user's devices with Aurora open", async () => {
    const closePhone = noteClientListening('user-1', 'phone-0002', { name: 'Chrome on Android', kind: 'browser' });
    const listed = await call('get', '/devices', undefined);
    expect(listed.body.data).toContainEqual({ clientId: 'phone-0002', name: 'Chrome on Android', kind: 'browser' });
    closePhone();
  });

  it('asks the chosen device, and only that one, to take the session over', async () => {
    const closePhone = noteClientListening('user-1', 'phone-0002', { name: 'Chrome on Android', kind: 'browser' });
    (getPlaybackSession as jest.Mock).mockResolvedValue(session(output));
    const { heard, unsubscribe } = watch();
    const sent = await call('post', '/playback-sessions/:id/transfer', { targetClientId: 'phone-0002' }, { id: sessionId });
    expect(sent.status).toBe(202);
    expect(heard).toContainEqual(expect.objectContaining({
      type: 'playbackSession.transferRequested',
      data: { sessionId, revision: 4, targetClientId: 'phone-0002', requestedBy: 'laptop-5678' },
    }));
    unsubscribe();
    closePhone();
  });

  it("refuses a guest: where it plays is the owner's alone (Listen together)", async () => {
    (getPlaybackSession as jest.Mock).mockResolvedValue({ ...session(output), access: { role: 'guest', permissions: ['transport', 'queue', 'replace'] } });
    const refused = await call('post', '/playback-sessions/:id/transfer', { targetClientId: 'phone-0002' }, { id: sessionId });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'SESSION_OWNER_ONLY']);
  });

  it('refuses a device that does not have Aurora open, a Cast receiver, and an unknown session', async () => {
    (getPlaybackSession as jest.Mock).mockResolvedValue(session(output));
    expect((await call('post', '/playback-sessions/:id/transfer', { targetClientId: 'tablet-0003' }, { id: sessionId })).body.error.code).toBe('DEVICE_NOT_CONNECTED');

    const closeReceiver = noteClientListening('user-1', 'receiver:cast-77', { name: null, kind: 'receiver' });
    expect((await call('post', '/playback-sessions/:id/transfer', { targetClientId: 'receiver:cast-77' }, { id: sessionId })).body.error.code).toBe('DEVICE_NOT_CONNECTED');
    closeReceiver();

    (getPlaybackSession as jest.Mock).mockResolvedValue(null);
    expect((await call('post', '/playback-sessions/:id/transfer', { targetClientId: 'phone-0002' }, { id: sessionId })).status).toBe(404);
  });
});
