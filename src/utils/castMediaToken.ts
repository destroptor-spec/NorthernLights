/**
 * The media token Cast URLs carry (docs/listen-together.md, 6a-2).
 *
 * Everything a Cast session shows its senders (item URLs, customData, artwork)
 * used to carry the login's own media token, which lives 30 days with
 * "remember me" and streams the whole library. Anything on the network that
 * sees the Cast session (Android's Cast media controls on a visitor's phone)
 * could read it. Cast now gets a token of its own that lives 12 hours, minted
 * for it alone and renewed while this device is connected; a receiver that
 * follows the session renews its own with its credential.
 */

/** Renewed this long before it runs out. */
export const CAST_MEDIA_TOKEN_RENEW_BEFORE_MS = 2 * 60 * 60_000;

export interface CastMediaTokenDeps {
  mint: () => Promise<{ token: string; expiresAt: string }>;
  now: () => number;
}

export class CastMediaToken {
  private token: string | null = null;
  private expiresAt = 0;
  private minting: Promise<string | null> | null = null;

  constructor(private readonly deps: CastMediaTokenDeps) {}

  /** The token while it is still valid, or null. */
  current(): string | null {
    return this.token && this.deps.now() < this.expiresAt ? this.token : null;
  }

  /** When it should be renewed (ms since epoch), or 0 without one. */
  renewAt(): number {
    return this.token ? this.expiresAt - CAST_MEDIA_TOKEN_RENEW_BEFORE_MS : 0;
  }

  /**
   * A token good for at least the renewal margin: the one held, or a new one.
   * Null when minting fails; callers then keep the URL's own token, as before.
   */
  ensure(): Promise<string | null> {
    if (this.token && this.deps.now() < this.renewAt()) return Promise.resolve(this.token);
    if (!this.minting) {
      this.minting = Promise.resolve().then(() => this.deps.mint()).then((minted) => {
        const expiresAt = Date.parse(minted.expiresAt);
        if (typeof minted.token !== 'string' || !minted.token || !Number.isFinite(expiresAt)) return this.current();
        this.token = minted.token;
        this.expiresAt = expiresAt;
        return minted.token;
      }, () => this.current()).finally(() => { this.minting = null; });
    }
    return this.minting;
  }
}

/** The URL with its `token` parameter set to `token`; unchanged when it has none, or on a bad URL. */
export function withCastToken(url: string, token: string | null): string {
  if (!url || !token) return url;
  try {
    const parsed = new URL(url, window.location.href);
    if (!parsed.searchParams.has('token')) return url;
    parsed.searchParams.set('token', token);
    return parsed.toString();
  } catch {
    return url;
  }
}
