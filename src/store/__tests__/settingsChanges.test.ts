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

test('a save while the settings GET is out makes the load read again instead of dropping it', async () => {
  const originalFetch = global.fetch;
  let finishFirstGet!: (value: unknown) => void;
  const gets: string[] = [];
  const fetcher = jest.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true });
    gets.push('get');
    if (gets.length === 1) return new Promise(resolve => { finishFirstGet = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({ loudnessPreampDb: -4, discoveryLevel: 70, hasYouTubeKey: true }) });
  });
  global.fetch = fetcher as unknown as typeof fetch;
  try {
    usePlayerStore.setState({ authToken: 'settings-race-test' });
    const { loadSettings, saveSettings, setSettings } = usePlayerStore.getState();
    const load = loadSettings();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(gets).toHaveLength(1);
    setSettings({ loudnessPreampDb: -4 });
    await saveSettings();
    // The first GET answers with values from before the save.
    finishFirstGet({ ok: true, json: async () => ({ loudnessPreampDb: 0, discoveryLevel: 50, hasYouTubeKey: true }) });
    await load;
    expect(gets).toHaveLength(2);
    const state = usePlayerStore.getState();
    expect(state.loudnessPreampDb).toBe(-4);
    expect(state.discoveryLevel).toBe(70);
    expect(state.hasYouTubeKey).toBe(true);
    // Applied as the saved baseline: nothing left to save.
    await saveSettings();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  } finally { global.fetch = originalFetch; }
});
