import { fetchCurrentUser } from '../currentUser';

/**
 * App's session check moved from /api/auth/me to v1 /me. The legacy route
 * returned the raw token payload — { userId, username, role, iat, exp } — so
 * currentUser.id was undefined and AdminDashboard offered admins a delete
 * button on their own row.
 */
const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as never;
});
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

it('asks v1 /me with the session header and returns { id, username, role }', async () => {
  respond(200, { data: {
    user: { id: 'u-1', username: 'andreas', role: 'admin' },
    client: { id: 'web:u-1', name: 'Aurora Web', authKind: 'jwt', scope: 'listener' },
  } });
  await expect(fetchCurrentUser({ Authorization: 'Bearer jwt' })).resolves.toEqual({ id: 'u-1', username: 'andreas', role: 'admin' });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/v1/me');
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jwt');
});

it('rejects on an expired session instead of clearing currentUser', async () => {
  respond(401, { error: { code: 'INVALID_SESSION', message: 'expired' } });
  await expect(fetchCurrentUser({ Authorization: 'Bearer old' })).rejects.toMatchObject({ status: 401 });
});
