import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServerLoggingSettings } from './ServerLoggingSettings';
import { usePlayerStore } from '../../store';
import { SERVER_LOGGING_SETTINGS } from '../../../shared/logging';

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  usePlayerStore.setState({ scannerLoggingEnabled: false, analyzerLoggingEnabled: false, loudnessLoggingEnabled: false, hlsLoggingEnabled: false, ffmpegLoggingEnabled: false, toasts: [] });
});
afterEach(() => { global.fetch = originalFetch; });

test('switches save immediately, show pending state, then reflect the confirmed value', async () => {
  let resolve!: (value: { ok: boolean }) => void;
  fetchMock.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<ServerLoggingSettings />);
  const scanner = screen.getByRole('switch', { name: 'Library scanner' });
  fireEvent.click(scanner);
  expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'POST', body: JSON.stringify({ scannerLoggingEnabled: true }) }));
  expect(scanner.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('status').textContent).toBe('Saving…');
  expect(screen.getAllByRole('switch').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  await act(async () => { resolve({ ok: true }); });
  expect(scanner.getAttribute('aria-checked')).toBe('true');
  expect((scanner as HTMLButtonElement).disabled).toBe(false);
});

test('failed saves keep the switch unchanged and report the error', async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Failed to update settings' }) });
  render(<ServerLoggingSettings />);
  const analyzer = screen.getByRole('switch', { name: 'Audio analyzer' });
  fireEvent.click(analyzer);
  await waitFor(() => expect(usePlayerStore.getState().toasts).toEqual([expect.objectContaining({ message: 'Failed to update settings', type: 'error' })]));
  expect(analyzer.getAttribute('aria-checked')).toBe('false');
  expect((analyzer as HTMLButtonElement).disabled).toBe(false);
});

test('saved logging settings are loaded and excluded from dialog-close bulk saves', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ scannerLoggingEnabled: true, analyzerLoggingEnabled: true, loudnessLoggingEnabled: true }) });
  await usePlayerStore.getState().loadSettings();
  expect(usePlayerStore.getState()).toMatchObject({ scannerLoggingEnabled: true, analyzerLoggingEnabled: true, loudnessLoggingEnabled: true });
  await usePlayerStore.getState().saveSettings();
  const payload = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
  for (const key of Object.keys(SERVER_LOGGING_SETTINGS)) expect(payload).not.toHaveProperty(key);
});
