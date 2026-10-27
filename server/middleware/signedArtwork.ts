import type { NextFunction, Request, Response } from 'express';
import { artworkSignatureValid } from '../services/artworkLink.service';
import { sendApiV1Error } from './apiV1Auth';

/**
 * Mounted at /artwork ahead of authentication: a signed artwork link opens
 * its one image with no credential (6a-4, artworkLink.service.ts). A request
 * that also carries a credential goes on to the normal route when its
 * signature fails; one without gets 403. Anything without `sig` goes on.
 */
export function signedArtworkLinks(serve: (req: Request, res: Response, hash: string) => void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || typeof req.query.sig !== 'string') return next();
    const hash = req.path.slice(1);
    if (!/^[0-9a-f]{1,64}$/.test(hash)) return next();
    if (await artworkSignatureValid(hash, req.query.sig)) return serve(req, res, hash);
    if (req.headers.authorization || typeof req.query.token === 'string') return next();
    sendApiV1Error(req, res, 403, 'INVALID_ARTWORK_SIGNATURE', 'The artwork link is not valid.');
  };
}
