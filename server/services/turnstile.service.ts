import { getSystemSetting } from '../database';

// Cloudflare Turnstile verification for the public credential endpoints
// (login, invite registration). Enforcement is opt-in: an admin supplies the
// site + secret keys in Settings -> System -> Security.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
  secretKey: string;
}

export async function getTurnstileConfig(): Promise<TurnstileConfig> {
  const [enabled, siteKey, secretKey] = await Promise.all([
    getSystemSetting('turnstileEnabled'),
    getSystemSetting('turnstileSiteKey'),
    getSystemSetting('turnstileSecretKey'),
  ]);
  const normalizedSiteKey = typeof siteKey === 'string' ? siteKey.trim() : '';
  const normalizedSecretKey = typeof secretKey === 'string' ? secretKey.trim() : '';
  return {
    // Enabled without a secret would lock everyone out with no way to verify —
    // treat that misconfiguration as disabled (the UI prevents it anyway).
    enabled: enabled === true && normalizedSecretKey.length > 0,
    siteKey: normalizedSiteKey,
    secretKey: normalizedSecretKey,
  };
}

/** Pure helper for the public auth-config endpoint — exported for unit tests. */
export function buildPublicAuthConfig(config: TurnstileConfig): { turnstile: { enabled: boolean; siteKey: string | null } } {
  // Only advertise the widget when it is fully configured; a site key without
  // a secret would render a challenge the server never verifies.
  const enabled = config.enabled && config.siteKey.length > 0;
  return {
    turnstile: {
      enabled,
      siteKey: enabled ? config.siteKey : null,
    },
  };
}

export type TurnstileVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_token' | 'invalid_token' | 'unavailable' };

export async function verifyTurnstileToken(
  token: unknown,
  secretKey: string,
  remoteIp: string,
): Promise<TurnstileVerifyResult> {
  if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'missing_token' };
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[Turnstile] siteverify returned HTTP ${response.status}`);
      return { ok: false, reason: 'unavailable' };
    }
    const data = await response.json();
    return data?.success === true
      ? { ok: true }
      : { ok: false, reason: 'invalid_token' };
  } catch (error: any) {
    // Surface WHY verification is failing closed — an unreachable Cloudflare
    // blocks all sign-ins until fixed or disabled.
    console.warn('[Turnstile] siteverify unreachable:', error?.cause?.code || error?.name || String(error));
    return { ok: false, reason: 'unavailable' };
  }
}
