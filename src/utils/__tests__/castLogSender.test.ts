import { CastManager, castLogSenderTag } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ authToken: 'jwt' }), setState: jest.fn() } }));

/**
 * Prod 2026-10-13 19:50–19:54: the phone and the desktop were both attached
 * to the NAD's Cast session, and their log lines were indistinguishable.
 */
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

it('names the device that wrote each sender line', () => {
  localStorage.setItem('aurora.listenerClientId', 'b1c2d3e4-0000-4000-8000-00000000abcd');
  const fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock as never;
  const manager = Object.create(CastManager.prototype) as { state: string; castContext: unknown; logCast: (level: string, message: string, detail?: string) => void };
  Object.assign(manager, {
    state: 'CONNECTED',
    castContext: { getCurrentSession: () => ({ getSessionId: () => 'e0aec07e' }) },
    getSafeDeviceName: () => 'NAD Forstærker',
    sanitizeLogDetail: (detail: string) => detail,
  });

  manager.logCast('ok', 'SESSION_ENDED');
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.detail).toBe(`state=CONNECTED sid=e0aec07e sender=${castLogSenderTag()}`);
  // This browser, then the end of its client ID.
  expect(castLogSenderTag()).toMatch(/^[A-Za-z]+(-on-[A-Za-z]+)?\/abcd$/);
  expect(castLogSenderTag()).not.toMatch(/\s/);
});
