import type { Request } from 'express';

// Client IP for SECURITY decisions (rate-limit keys, auth logging, captcha
// remoteip). Express's `trust proxy: true` is kept for req.protocol/req.host
// (OAuth callbacks, HSTS), but it makes req.ip the LEFT-most X-Forwarded-For
// entry — which the client itself controls. Never key security state on it.
//
// TRUSTED_PROXY_MODE picks the one source the deployment actually trusts:
//   direct      (default) the TCP peer address. Unspoofable. Correct when
//               clients hit the node server directly (dev, LAN).
//   proxy       right-most X-Forwarded-For entry — the address appended by
//               the directly-connected reverse proxy (Caddy, nginx).
//   cloudflare  CF-Connecting-IP, set by the Cloudflare edge. Correct for
//               the production Cloudflare → Caddy chain.

export type TrustedProxyMode = 'direct' | 'proxy' | 'cloudflare';

export function getTrustedProxyMode(): TrustedProxyMode {
  const raw = (process.env.TRUSTED_PROXY_MODE || '').trim().toLowerCase();
  if (raw === 'proxy' || raw === 'cloudflare') return raw;
  return 'direct';
}

type HeaderMap = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderMap, name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rightmostForwardedFor(headers: HeaderMap): string | null {
  const xff = headerValue(headers, 'x-forwarded-for');
  if (!xff) return null;
  const entries = xff.split(',').map(entry => entry.trim()).filter(Boolean);
  return entries.length ? entries[entries.length - 1] : null;
}

/** Pure resolution logic — exported for unit tests. */
export function resolveClientIp(
  mode: TrustedProxyMode,
  headers: HeaderMap,
  socketAddress: string | undefined | null,
): string {
  const socketIp = socketAddress || 'unknown';
  switch (mode) {
    case 'cloudflare':
      return headerValue(headers, 'cf-connecting-ip') || rightmostForwardedFor(headers) || socketIp;
    case 'proxy':
      return rightmostForwardedFor(headers) || socketIp;
    default:
      return socketIp;
  }
}

const mode = getTrustedProxyMode();

export function getTrustedClientIp(req: Request): string {
  return resolveClientIp(mode, req.headers, req.socket?.remoteAddress);
}
