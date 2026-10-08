import { fireEvent, render, screen } from '@testing-library/react';
import { ScrobblingTab } from './ScrobblingTab';
import { usePlayerStore } from '../../store';

/**
 * "Sync loved/liked songs across all platforms" controls whether a star from
 * an OpenSubsonic client (Symfonium) is mirrored to Last.fm and MusicBrainz.
 * On by default; stored per user alongside the scrobble bridge.
 */
const LABEL = 'Sync loved/liked songs across all platforms';
const originalFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  global.fetch = fetchMock;
  usePlayerStore.setState({ subsonicProviderLoveSyncEnabled: true, subsonicProviderScrobbleEnabled: false, toasts: [] });
});
afterEach(() => { global.fetch = originalFetch; });

test('sits under OpenSubsonic Clients as a named switch, on by default', () => {
  render(<ScrobblingTab />);
  const toggle = screen.getByRole('switch', { name: LABEL });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  const section = toggle.closest('.account-provider');
  expect(section?.querySelector('h5')?.textContent).toBe('OpenSubsonic Clients');
});

test('flips the preference in the store', () => {
  render(<ScrobblingTab />);
  fireEvent.click(screen.getByRole('switch', { name: LABEL }));
  expect(usePlayerStore.getState().subsonicProviderLoveSyncEnabled).toBe(false);
  expect(screen.getByRole('switch', { name: LABEL }).getAttribute('aria-checked')).toBe('false');
});

test('leaves the scrobble bridge alone', () => {
  render(<ScrobblingTab />);
  fireEvent.click(screen.getByRole('switch', { name: LABEL }));
  expect(usePlayerStore.getState().subsonicProviderScrobbleEnabled).toBe(false);
  expect(screen.getByRole('switch', { name: 'Bridge Subsonic scrobbles' }).getAttribute('aria-checked')).toBe('false');
});

test('is saved with the other settings', async () => {
  usePlayerStore.setState({ subsonicProviderLoveSyncEnabled: false });
  await usePlayerStore.getState().saveSettings();
  const saves = fetchMock.mock.calls.filter(([url, init]) => url === '/api/settings' && (init as RequestInit)?.method === 'POST');
  expect(saves.length).toBeGreaterThan(0);
  expect(JSON.parse(String((saves[0][1] as RequestInit).body)).subsonicProviderLoveSyncEnabled).toBe(false);
});

describe('loading from the server', () => {
  const load = async (data: Record<string, unknown>) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => data });
    await usePlayerStore.getState().loadSettings();
    return usePlayerStore.getState().subsonicProviderLoveSyncEnabled;
  };

  it('treats a never-set preference as on', async () => {
    usePlayerStore.setState({ subsonicProviderLoveSyncEnabled: false });
    expect(await load({})).toBe(true);
  });

  it('keeps an explicit off, as a boolean or a stored string', async () => {
    expect(await load({ subsonicProviderLoveSyncEnabled: false })).toBe(false);
    expect(await load({ subsonicProviderLoveSyncEnabled: 'false' })).toBe(false);
  });
});
