jest.mock('../services/auth.service', () => ({
  getJwtSecret: jest.fn(async () => 'server-secret'),
  getCachedJwtSecret: jest.fn(() => 'server-secret'),
}));
import type { Request, Response } from 'express';
import { artworkSignatureValid, artworkUrlFor } from '../services/artworkLink.service';
import { getCachedJwtSecret } from '../services/auth.service';
import { signedArtworkLinks } from './signedArtwork';

/**
 * 6a-4 (docs/listen-together.md): a track's artwork link is signed for that
 * one image, so Cast and media notifications never carry a media token.
 */
const HASH = 'ab12cd34';
const sigOf = (url: string) => new URL(url, 'https://a.example').searchParams.get('sig');

describe('artwork links', () => {
  it('signs each image separately; a signature opens only its own', async () => {
    const url = artworkUrlFor(HASH);
    expect(url).toMatch(/^\/api\/v1\/artwork\/ab12cd34\?sig=[A-Za-z0-9_-]{22}$/);
    await expect(artworkSignatureValid(HASH, sigOf(url))).resolves.toBe(true);
    await expect(artworkSignatureValid('ab12cd35', sigOf(url))).resolves.toBe(false);
    await expect(artworkSignatureValid(HASH, 'x'.repeat(22))).resolves.toBe(false);
    await expect(artworkSignatureValid(HASH, undefined)).resolves.toBe(false);
  });

  it('stays unsigned before the server secret is loaded (a token still opens it)', () => {
    (getCachedJwtSecret as jest.Mock).mockReturnValueOnce(null);
    expect(artworkUrlFor(HASH)).toBe('/api/v1/artwork/ab12cd34');
  });
});

describe('the signed route, ahead of authentication', () => {
  const run = async (query: Record<string, string>, headers: Record<string, string> = {}) => {
    const serve = jest.fn();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response;
    const req = { method: 'GET', path: `/${HASH}`, query, headers, requestId: 'r1' } as unknown as Request;
    await signedArtworkLinks(serve)(req, res, next);
    return { serve, next, res: res as unknown as { status: jest.Mock } };
  };

  it('serves a signed link with no credential', async () => {
    const { serve, next } = await run({ sig: sigOf(artworkUrlFor(HASH))! });
    expect(serve).toHaveBeenCalledWith(expect.anything(), expect.anything(), HASH);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a bad signature, unless a credential can open it the usual way', async () => {
    const bare = await run({ sig: 'x'.repeat(22) });
    expect(bare.serve).not.toHaveBeenCalled();
    expect(bare.res.status).toHaveBeenCalledWith(403);

    const withToken = await run({ sig: 'x'.repeat(22), token: 'media-token' });
    expect(withToken.next).toHaveBeenCalled();
    expect(withToken.serve).not.toHaveBeenCalled();
  });

  it('leaves a request without a signature to authentication', async () => {
    const { serve, next } = await run({ token: 'media-token' });
    expect(next).toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });
});
