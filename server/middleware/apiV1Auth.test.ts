jest.mock('../services/auth.service', () => ({ verifyToken: jest.fn() }));
jest.mock('../services/auroraAppAuth.service', () => ({ verifyAuroraAppKey: jest.fn() }));
jest.mock('../services/scopedToken.service', () => ({ verifyScopedToken: jest.fn() }));

import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { verifyScopedToken } from '../services/scopedToken.service';
import { requireApiV1Auth, requireApiV1WebSession } from './apiV1Auth';

function responseMock() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('Aurora API v1 authentication boundaries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a valid scoped bearer token on web-session endpoints', async () => {
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope: 'media',
    } as any);
    const req = {
      headers: { authorization: 'Bearer scoped-token' },
      path: '/app-keys',
      query: {},
      requestId: 'request-1',
    } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as NextFunction;

    await requireApiV1Auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'SCOPED_TOKEN_NOT_ALLOWED' }),
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps an allowed scoped bearer token scoped after authentication', async () => {
    const scoped = { userId: 'user-1', username: 'alice', role: 'user', scope: 'media' as const };
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue(scoped as any);
    (verifyScopedToken as jest.MockedFunction<typeof verifyScopedToken>).mockResolvedValue(scoped);
    const req = {
      headers: { authorization: 'Bearer scoped-token' },
      path: '/artwork/cover',
      query: {},
    } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as NextFunction;

    await requireApiV1Auth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiV1).toMatchObject({ authKind: 'scoped', scope: 'media' });

    const webNext = jest.fn();
    requireApiV1WebSession(req, res, webNext);
    expect(res.status).toHaveBeenLastCalledWith(403);
    expect(webNext).not.toHaveBeenCalled();
  });
});
