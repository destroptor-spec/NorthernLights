import { render, screen, waitFor, within } from '@testing-library/react';
import { AccountTab } from './AccountTab';
import { AdminDashboard } from './AdminDashboard';
import { usePlayerStore } from '../../store';

/**
 * The server owner and the last admin can't delete their account or be
 * deleted by another admin; the UI hides the action instead of letting the
 * server refuse it after a password prompt.
 */
const originalFetch = global.fetch;
let routes: Record<string, unknown>;
beforeEach(() => {
  routes = {};
  global.fetch = jest.fn(async (url: string) => ({
    ok: true, status: 200, json: async () => routes[url] ?? {}, headers: { get: () => null },
  })) as never;
  usePlayerStore.setState({ authToken: 'jwt', currentUser: { id: 'me', username: 'andreas', role: 'admin' }, toasts: [] } as never);
});
afterEach(() => { global.fetch = originalFetch; });

describe('My Account', () => {
  it.each([
    ['owner', /You own this Aurora server/],
    ['last-admin', /You're the only admin/],
  ])('explains instead of offering Delete Account for the %s', async (protection, message) => {
    routes['/api/auth/account-protection'] = { protection };
    render(<AccountTab onClose={() => {}} />);
    await screen.findByText(message);
    expect(screen.queryByRole('button', { name: 'Delete Account' })).toBeNull();
  });

  it('offers Delete Account to everyone else', async () => {
    routes['/api/auth/account-protection'] = { protection: null };
    render(<AccountTab onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Delete Account' });
  });
});

describe('Admin → Users', () => {
  const user = (id: string, username: string, role: string, isOwner = false) =>
    ({ id, username, role, is_owner: isOwner, created_at: 0, last_login_at: 0 });
  beforeEach(() => { routes['/api/admin/invites'] = { invites: [] }; });
  const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

  it('marks the owner and never offers to delete them', async () => {
    usePlayerStore.setState({ currentUser: { id: 'u2', username: 'second', role: 'admin' } } as never);
    routes['/api/admin/users'] = { users: [user('me', 'andreas', 'admin', true), user('u2', 'second', 'admin'), user('u3', 'listener', 'user')] };
    render(<AdminDashboard />);
    await screen.findByText('andreas');
    expect(within(row('andreas')).getByText('OWNER')).toBeTruthy();
    expect(within(row('andreas')).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(row('listener')).getByRole('button', { name: 'Delete listener' })).toBeTruthy();
  });

  it('never offers to delete the last admin', async () => {
    routes['/api/admin/users'] = { users: [user('me', 'andreas', 'user'), user('u2', 'only-admin', 'admin')] };
    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByText('only-admin')).toBeTruthy());
    expect(within(row('only-admin')).queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});
