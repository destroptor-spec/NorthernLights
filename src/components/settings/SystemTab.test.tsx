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
