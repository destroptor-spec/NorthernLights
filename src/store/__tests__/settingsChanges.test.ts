import { usePlayerStore } from '../index';

test('saves only edits, keeps rejected edits retryable and skips an unchanged save', async () => {
  const originalFetch = global.fetch;
  const fetcher = jest.fn();
  global.fetch = fetcher;
  try {
    usePlayerStore.setState({ authToken: 'settings-test' });
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ loudnessPreampDb: 0 }) });
    const { loadSettings, saveSettings } = usePlayerStore.getState();
    await loadSettings();
    await saveSettings();
    expect(fetcher).toHaveBeenCalledTimes(1);
    usePlayerStore.getState().setSettings({ loudnessPreampDb: -2 });
    fetcher.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Try again' }) });
    await expect(saveSettings()).rejects.toThrow('Try again');
    fetcher.mockResolvedValueOnce({ ok: true });
    await saveSettings();
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ loudnessPreampDb: -2 });
    await saveSettings();
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { global.fetch = originalFetch; }
});
