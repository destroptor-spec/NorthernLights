import crypto from 'crypto';
import { getCachedJwtSecret, getJwtSecret } from './auth.service';

/**
 * Signed artwork links (docs/listen-together.md, 6a-4).
 *
 * A track's artworkUrl carries a signature for that one image
 * (`/api/v1/artwork/<hash>?sig=…`), which opens it with no credential. Cast
 * shows artwork to every sender in its session and to anything on the network
 * that sees it (Android's media notifications fetch it too); with a media
 * token in that URL, all of them could stream the whole library. A signature
 * opens only its own image, cannot be forged for another hash, and keeps a
 * known cover's hash from probing whether the library has it.
 *
 * Keyed to the server secret, so regenerating it (which signs everyone out)
 * also retires every link.
 */
const SIG_LENGTH = 22; // 132 bits of HMAC-SHA256, base64url

function sign(secret: string, hash: string): string {
  return crypto.createHmac('sha256', secret).update(`aurora-artwork:${hash}`).digest('base64url').slice(0, SIG_LENGTH);
}

/** The artwork URL for a hash: signed once the server secret is loaded (it is, for any signed-in request). */
export function artworkUrlFor(hash: string): string {
  const base = `/api/v1/artwork/${encodeURIComponent(hash)}`;
  const secret = getCachedJwtSecret();
  return secret ? `${base}?sig=${sign(secret, hash)}` : base;
}

export async function artworkSignatureValid(hash: string, sig: unknown): Promise<boolean> {
  if (typeof sig !== 'string' || sig.length !== SIG_LENGTH) return false;
  const expected = sign(await getJwtSecret(), hash);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
