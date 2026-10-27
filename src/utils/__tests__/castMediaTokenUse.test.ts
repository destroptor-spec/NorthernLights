import { CastManager } from '../CastManager';
import { ReceiverFollowAcks } from '../receiverSessionFollow';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ streamingQuality: 'auto', playlist: [], currentIndex: 0 }), setState: jest.fn() } }));

/**
 * 6a-2 (docs/listen-together.md): what a Cast session shows every sender
 * carries the 12-hour Cast media token, never the login's 30-day one.
 */
type Internals = {
  buildMediaInfo(track: Record<string, unknown>, options?: Record<string, unknown>): any;
  loadRequestCustomData(url: string): Record<string, string> | undefined;
  noteBroadcastTokens(mediaSession: unknown): void;
  handOverSessionToReceiver(handover: Record<string, unknown>, reason: string): Promise<boolean>;
  attachAuroraStatusListener(session: unknown, sessionId: string): void;
};

beforeAll(() => {
  class MediaInfo { metadata: any; customData: any; streamType: any; hlsSegmentFormat: any; constructor(public contentId: string, public contentType: string) {} }
  (globalThis as any).chrome = { cast: {
    Image: class { constructor(public url: string) {} },
    media: {
      MediaInfo, MusicTrackMediaMetadata: class {}, StreamType: { BUFFERED: 'BUFFERED' }, HlsSegmentFormat: { TS: 'TS' },
    },
  } };
});

const held = (token: string | null) => ({ current: () => token, renewAt: () => Number.MAX_SAFE_INTEGER, ensure: async () => token });

function manager(token: string | null, customAppId: string | null = '041FEA05') {
  const m = Object.create(CastManager.prototype) as Internals & { logCast: jest.Mock; castContext: unknown };
  Object.assign(m, { customAppId, diagnosticsVerbose: false, castMediaTokenHolder: held(token), logCast: jest.fn() });
  return m;
}

const track = {
  queueEntryId: 'e1', title: 'Lonely', artist: 'A',
  url: 'https://aurora.example/api/stream/t1/playlist.m3u8?quality=auto&token=login-30d',
  artUrl: 'https://aurora.example/api/v1/artwork/h1?token=login-30d',
};

it('our receiver: no token in the URL or the media customData; the Cast token in the LOAD request (6a-3)', () => {
  const m = manager('cast-12h');
  const info = m.buildMediaInfo(track);
  expect(info.contentId).not.toContain('token=');
  expect(info.customData.token).toBeUndefined();
  expect(m.loadRequestCustomData(track.url)).toEqual({ token: 'cast-12h' });
  // Artwork keeps a token until it has signed links (6a-4): the Cast one.
  expect(info.metadata.images[0].url).toContain('token=cast-12h');
  expect(JSON.stringify(info)).not.toContain('login-30d');
});

it("the LOAD request falls back to the URL's own token when no Cast token could be minted", () => {
  expect(manager(null).loadRequestCustomData(track.url)).toEqual({ token: 'login-30d' });
});

it('the default receiver fetches the URL as given: it keeps a token, the Cast one', () => {
  const m = manager('cast-12h', null);
  expect(m.buildMediaInfo({ ...track, rawUrl: 'https://aurora.example/api/stream/t1/raw?token=login-30d' }).contentId).toContain('token=cast-12h');
  expect(m.loadRequestCustomData(track.url)).toBeUndefined();
});

it('logs whether a media token shows in what the session broadcasts, once per place and session', () => {
  const m = manager('cast-12h');
  m.castContext = { getCurrentSession: () => ({ getSessionId: () => 'cast-77' }) };
  const clean = { media: { contentId: 'https://a/x.m3u8?codec=aac', customData: { queueEntryId: 'e1' } }, items: [] };
  m.noteBroadcastTokens(clean);
  m.noteBroadcastTokens(clean);
  m.noteBroadcastTokens({ media: { contentId: 'https://a/x.m3u8?token=t', customData: { token: 't' } } });
  expect(m.logCast.mock.calls.map(([level, marker, detail]) => `${level} ${marker} ${detail}`)).toEqual([
    'ok cast-broadcast-token seen=none',
    'warn cast-broadcast-token seen=contentId',
    'warn cast-broadcast-token seen=customData',
  ]);
});

it('hands the receiver the Cast token with the session', async () => {
  const NS = 'urn:x-cast:aurora.status';
  let onMessage: (ns: string, message: string) => void = () => undefined;
  const sent: any[] = [];
  const session = {
    getSessionId: () => 'cast-77',
    addMessageListener: (_ns: string, listener: typeof onMessage) => { onMessage = listener; },
    sendMessage: jest.fn(async (_ns: string, message: any) => {
      sent.push(message);
      queueMicrotask(() => onMessage(NS, JSON.stringify({ type: 'aurora.session.follow.ack', requestId: message.requestId, ok: true })));
    }),
  };
  const m = manager('cast-12h');
  Object.assign(m, {
    castContext: { getCurrentSession: () => session }, auroraControlRequestId: 0, auroraControlCapLoggedSid: null,
    sessionFollowCapSid: '', receiverFollowListeners: new Set(), receiverFollowStateListeners: new Set(),
    receiverFollowAcks: new ReceiverFollowAcks(), probeAcks: new Map(), applyAuroraStatus: jest.fn(),
    syncReceiverDiagnostics: jest.fn(), isConnected: () => true,
  });
  m.attachAuroraStatusListener(session, 'cast-77');
  onMessage(NS, JSON.stringify({ type: 'aurora.status', caps: ['session-follow'], queueEntryId: 'e1' }));
  await expect(m.handOverSessionToReceiver({
    sessionId: 's1', outputId: 'receiver:cast-77', generation: 3, token: 'receiver-credential', expiresAt: '2026-10-28T00:00:00.000Z',
  }, 'claim')).resolves.toBe(true);
  expect(sent[0]).toMatchObject({ type: 'aurora.session.follow', mediaToken: 'cast-12h' });
});

it('a signed artwork link goes without a token: it opens its one image by itself (6a-4)', () => {
  const info = manager('cast-12h').buildMediaInfo({ ...track, artUrl: 'https://aurora.example/api/v1/artwork/h1?sig=abcdefghijklmnopqrstuv&token=login-30d' });
  expect(info.metadata.images[0].url).toBe('https://aurora.example/api/v1/artwork/h1?sig=abcdefghijklmnopqrstuv');
});

it('counts artwork with a token as broadcast (6a-4)', () => {
  const m = manager('cast-12h');
  m.castContext = { getCurrentSession: () => ({ getSessionId: () => 'cast-88' }) };
  m.noteBroadcastTokens({ media: { contentId: 'https://a/x.m3u8', metadata: { images: [{ url: 'https://a/api/v1/artwork/h1?token=t' }] } } });
  expect(m.logCast).toHaveBeenCalledWith('warn', 'cast-broadcast-token', 'seen=artwork');
});
