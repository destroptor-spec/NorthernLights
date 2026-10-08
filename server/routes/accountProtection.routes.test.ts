/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  changeProtectedAccount: jest.fn(),
  getAccountProtection: jest.fn(),
  getUserByUsername: jest.fn(),
  updateUser: jest.fn(),
}));
jest.mock('../services/auth.service', () => ({
  ...jest.requireActual('../services/auth.service'),
  verifyPassword: jest.fn(async () => true),
  hashPassword: jest.fn(async () => 'hash'),
}));
import type { Request, Response } from 'express';
import adminRouter from './admin.routes';
import authRouter from './auth.routes';
import { changeProtectedAccount, getAccountProtection, getUserByUsername, updateUser } from '../database';

/**
 * Removing an account goes through the owner / last-admin guard on every
 * path: self-deletion, an admin deleting a user, an admin demoting one.
 */
async function call(router: any, method: string, path: string, req: Record<string, unknown>) {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.stack.some((h: any) => h.method === method));
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const handlers = layer.route.stack.map((h: any) => h.handle);
  await handlers[handlers.length - 1]({ params: {}, query: {}, body: {}, ip: '127.0.0.1', headers: {}, ...req } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
const adminUser = { userId: 'me', username: 'andreas', role: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserByUsername).mockResolvedValue({ id: 'me', username: 'andreas', role: 'admin', password_hash: 'h' } as never);
});

describe('DELETE /api/auth/delete-account', () => {
  it('refuses the owner with a reason and deletes nothing else', async () => {
    jest.mocked(changeProtectedAccount).mockResolvedValue('owner');
    const res = await call(authRouter, 'delete', '/delete-account', { user: adminUser, body: { password: 'pw' } });
    expect(changeProtectedAccount).toHaveBeenCalledWith('me', 'delete');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ protection: 'owner' });
  });

  it('deletes an unprotected account', async () => {
    jest.mocked(changeProtectedAccount).mockResolvedValue('done');
    const res = await call(authRouter, 'delete', '/delete-account', { user: adminUser, body: { password: 'pw' } });
    expect(res.json).toHaveBeenCalledWith({ status: 'deleted' });
  });
});

it('GET /api/auth/account-protection reports the signed-in account', async () => {
  jest.mocked(getAccountProtection).mockResolvedValue('last-admin');
  const res = await call(authRouter, 'get', '/account-protection', { user: adminUser });
  expect(getAccountProtection).toHaveBeenCalledWith('me');
  expect(res.json).toHaveBeenCalledWith({ protection: 'last-admin' });
});

describe('Admin → Users', () => {
  it('refuses to delete the last admin', async () => {
    jest.mocked(changeProtectedAccount).mockResolvedValue('last-admin');
    const res = await call(adminRouter, 'delete', '/users/:id', { user: adminUser, params: { id: 'u2' } });
    expect(changeProtectedAccount).toHaveBeenCalledWith('u2', 'delete');
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses to demote the owner and applies none of the other changes', async () => {
    jest.mocked(changeProtectedAccount).mockResolvedValue('owner');
    const res = await call(adminRouter, 'put', '/users/:id', { user: adminUser, params: { id: 'owner' }, body: { role: 'user', username: 'renamed' } });
    expect(changeProtectedAccount).toHaveBeenCalledWith('owner', 'demote');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('demotes through the guard, then applies the rest', async () => {
    jest.mocked(changeProtectedAccount).mockResolvedValue('done');
    await call(adminRouter, 'put', '/users/:id', { user: adminUser, params: { id: 'u2' }, body: { role: 'user', username: 'renamed' } });
    expect(updateUser).toHaveBeenCalledWith('u2', { username: 'renamed' });
  });

  it('promotes without the guard', async () => {
    await call(adminRouter, 'put', '/users/:id', { user: adminUser, params: { id: 'u3' }, body: { role: 'admin' } });
    expect(changeProtectedAccount).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith('u3', { role: 'admin' });
  });
});
