import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SystemTab } from './SystemTab';
import { usePlayerStore } from '../../store';

/**
 * Settings → System → Reset Hub does what the Hub's own generate button does,
 * through the same v1 endpoint, and reports the outcome rather than assuming it.
 */
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
let regenerate: unknown;

beforeEach(() => {
  regenerate = { skipped: false, reason: null, generated: 3 };
  fetchMock = jest.fn(async (url: string) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => (url === '/api/v1/hub/regenerate' ? { data: regenerate } : {}),
  }));
  global.fetch = fetchMock as never;
  usePlayerStore.setState({ authToken: 'jwt', toasts: [] } as never);
});
afterEach(() => { global.fetch = originalFetch; });

async function resetHub() {
  render(<SystemTab />);
  fireEvent.click(screen.getByRole('button', { name: 'Hub Playlists' }));
  fireEvent.click(screen.getByRole('button', { name: /Reset Hub/ }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset Hub' }));
}
const regenerateCall = () => fetchMock.mock.calls.find(([url]) => url === '/api/v1/hub/regenerate');

test('forces a regeneration through v1 with a JSON body', async () => {
  await resetHub();
  await waitFor(() => expect(regenerateCall()).toBeTruthy());
  const [, init] = regenerateCall()!;
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  expect(JSON.parse(init.body)).toEqual({ force: true });
  expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/hub'))).toBe(false);
  expect(usePlayerStore.getState().toasts[0].message).toBe('Resetting Hub… regenerating playlists can take a minute.');
  await waitFor(() => expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain('Hub reset. 3 playlists generated.'));
});

test('says so when the reset was skipped', async () => {
  regenerate = { skipped: true, reason: 'No LLM base URL configured', generated: 0 };
  await resetHub();
  await waitFor(() => expect(usePlayerStore.getState().toasts.map((t) => t.message))
    .toContain('Hub reset skipped: No LLM base URL configured.'));
});

test('reports a failed request instead of success', async () => {
  fetchMock.mockImplementation(async (url: string) => (url === '/api/v1/hub/regenerate'
    ? { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { message: 'boom' } }) }
    : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }));
  await resetHub();
  await waitFor(() => expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain('Failed to request reset'));
});

describe('Sync playback across devices', () => {
  const settingsPosts = () => fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/settings' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));

  it("is the admin's choice of off, on for everyone, or each user", async () => {
    usePlayerStore.setState({ playbackSyncMode: 'off', playbackSyncUserEnabled: true, syncPlaybackAcrossDevices: false } as never);
    render(<SystemTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    const choice = screen.getByRole('radiogroup', { name: 'Sync playback across devices' });
    expect(within(choice).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(choice).getByRole('radio', { name: 'Each user decides' }));
    await waitFor(() => expect(settingsPosts()).toEqual([{ playbackSyncMode: 'user' }]));
    // This admin had chosen it for themselves already.
    expect(usePlayerStore.getState()).toMatchObject({ playbackSyncMode: 'user', syncPlaybackAcrossDevices: true });
  });

  it('goes back and says so when the server refuses', async () => {
    usePlayerStore.setState({ playbackSyncMode: 'off', playbackSyncUserEnabled: false, syncPlaybackAcrossDevices: false } as never);
    fetchMock.mockImplementation(async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: 'Admin access required' }) }));
    render(<SystemTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On for everyone' }));
    await waitFor(() => expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain('Admin access required'));
    expect(usePlayerStore.getState()).toMatchObject({ playbackSyncMode: 'off', syncPlaybackAcrossDevices: false });
  });
});

