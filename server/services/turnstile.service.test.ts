jest.mock('../database', () => ({
  getSystemSetting: jest.fn(),
}));

import { getSystemSetting } from '../database';
import { buildPublicAuthConfig, getTurnstileConfig, verifyTurnstileToken } from './turnstile.service';

const mockGetSystemSetting = getSystemSetting as jest.Mock;

const settings = (values: Record<string, unknown>) => {
  mockGetSystemSetting.mockImplementation(async (key: string) => values[key] ?? null);
};

describe('getTurnstileConfig', () => {
  beforeEach(() => mockGetSystemSetting.mockReset());

  it('is enabled only when the toggle is on AND a secret is present', async () => {
    settings({ turnstileEnabled: true, turnstileSiteKey: 'site', turnstileSecretKey: 'secret' });
    expect((await getTurnstileConfig()).enabled).toBe(true);

    settings({ turnstileEnabled: true, turnstileSiteKey: 'site', turnstileSecretKey: '' });
    expect((await getTurnstileConfig()).enabled).toBe(false);

    settings({ turnstileEnabled: false, turnstileSiteKey: 'site', turnstileSecretKey: 'secret' });
    expect((await getTurnstileConfig()).enabled).toBe(false);
  });
});

describe('buildPublicAuthConfig', () => {
  it('advertises the widget only when fully configured, and never leaks the secret', () => {
    expect(buildPublicAuthConfig({ enabled: true, siteKey: 'site', secretKey: 'secret' }))
      .toEqual({ turnstile: { enabled: true, siteKey: 'site' } });
    // Enabled flag without a site key: nothing to render client-side.
    expect(buildPublicAuthConfig({ enabled: true, siteKey: '', secretKey: 'secret' }))
      .toEqual({ turnstile: { enabled: false, siteKey: null } });
    expect(buildPublicAuthConfig({ enabled: false, siteKey: 'site', secretKey: 'secret' }))
      .toEqual({ turnstile: { enabled: false, siteKey: null } });
    expect(JSON.stringify(buildPublicAuthConfig({ enabled: true, siteKey: 'site', secretKey: 'secret' })))
      .not.toContain('secret');
  });
});

describe('verifyTurnstileToken', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('rejects missing/non-string/oversized tokens without calling Cloudflare', async () => {
    expect(await verifyTurnstileToken(undefined, 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'missing_token' });
    expect(await verifyTurnstileToken('', 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'missing_token' });
    expect(await verifyTurnstileToken(42, 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'missing_token' });
    expect(await verifyTurnstileToken('x'.repeat(2049), 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'missing_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a form-encoded body with secret, response, and remoteip', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    expect(await verifyTurnstileToken('the-token', 'the-secret', '1.2.3.4')).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const body = init.body as URLSearchParams;
    expect(body.get('secret')).toBe('the-secret');
    expect(body.get('response')).toBe('the-token');
    expect(body.get('remoteip')).toBe('1.2.3.4');
  });

  it('maps success:false to invalid_token', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
    expect(await verifyTurnstileToken('bad', 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('maps non-200, network errors, and bad JSON to unavailable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    expect(await verifyTurnstileToken('t', 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'unavailable' });

    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await verifyTurnstileToken('t', 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'unavailable' });

    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json'); } });
    expect(await verifyTurnstileToken('t', 'sk', '1.2.3.4')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
