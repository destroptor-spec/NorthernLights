import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MetadataTab } from './MetadataTab';
import { usePlayerStore } from '../../store';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const quota = (count = 12) => ({ enabled: true, hasKey: true, usage: {
  day: '2026-10-17', count, cap: 9000, stopped: false, hardStopActive: true, lastCallAt: null,
} });
const originalFetch = global.fetch;
let fetchMock: jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;
let statusResponse: () => Promise<Response>;

beforeEach(() => {
  usePlayerStore.setState({ youtubeEnabled: true, youtubeApiKey: 'test-key',
    youtubeCacheTtlDays: 14, youtubeDailyQuotaCap: 9000, youtubeHardStop: true });
  statusResponse = async () => response(quota());
  fetchMock = jest.fn(async (url) => {
    if (url === '/api/providers/youtube/status') return statusResponse();
    if (url === '/api/providers/youtube/test') return response({ status: 'ok', sample: 'YouTube' });
    return response({});
  });
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = originalFetch; });

function openYouTube() {
  render(<MetadataTab />);
  fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
}

test('failed save stops the connection test instead of testing the old server key', async () => {
  openYouTube();
  await screen.findByText('12');
  fetchMock.mockImplementation(async url => url === '/api/settings' ? response({}, 503) : response({ status: 'ok' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));
  await screen.findByText(/Could not save YouTube settings \(HTTP 503\)/);
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/providers/youtube/test')).toBe(false);
  expect(screen.queryByText(/Connected \(/)).toBeNull();
});

test('successful save finishes before testing and then reloads quota usage', async () => {
  openYouTube();
  await screen.findByText('12');
  let finishSave!: (value: Response) => void;
  fetchMock.mockImplementation(async url => {
    if (url === '/api/settings') return new Promise(resolve => { finishSave = resolve; });
    if (url === '/api/providers/youtube/test') return response({ status: 'ok', sample: 'YouTube' });
    return response(quota(13));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));
  await waitFor(() => expect(finishSave).toBeDefined());
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/providers/youtube/test')).toBe(false);
  const saved = fetchMock.mock.calls.find(([url]) => url === '/api/settings')!;
  expect(JSON.parse(saved[1]!.body as string)).toEqual({ youtubeEnabled: true, youtubeApiKey: 'test-key',
    youtubeCacheTtlDays: 14, youtubeDailyQuotaCap: 9000, youtubeHardStop: true });
  await act(async () => finishSave(response({})));
  await screen.findByText('✓ Connected (YouTube)');
  await screen.findByText('13');
});

test.each(['http', 'network'] as const)('quota %s failure is unavailable and can be retried', async failure => {
  statusResponse = async () => {
    if (failure === 'network') throw new Error('offline');
    return response({}, 500);
  };
  openYouTube();
  await screen.findByText('Quota usage unavailable.');
  expect(screen.queryByText('0')).toBeNull();
  statusResponse = async () => response(quota());
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('12');
  expect(screen.queryByText('Quota usage unavailable.')).toBeNull();
});

test('pending quota load does not present a fabricated zero', async () => {
  let finishStatus!: (value: Response) => void;
  statusResponse = () => new Promise(resolve => { finishStatus = resolve; });
  openYouTube();
  expect(screen.getByText('Loading quota usage…')).toBeTruthy();
  expect(screen.queryByText('0')).toBeNull();
  await act(async () => finishStatus(response(quota(0))));
  expect(screen.getByText('0')).toBeTruthy();
});

test('a failed refresh discards the earlier quota instead of showing it as current', async () => {
  openYouTube();
  await screen.findByText('12');
  statusResponse = async () => response({}, 503);
  fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));
  await screen.findByText('Quota usage unavailable.');
  expect(screen.queryByText('12')).toBeNull();
  expect(screen.queryByText('0')).toBeNull();
});

test('a late response from an earlier tab visit cannot replace the latest quota', async () => {
  let finishOldStatus!: (value: Response) => void;
  statusResponse = () => new Promise(resolve => { finishOldStatus = resolve; });
  openYouTube();
  fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
  statusResponse = async () => response(quota(25));
  fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
  await screen.findByText('25');
  await act(async () => finishOldStatus(response(quota(12))));
  expect(screen.queryByText('12')).toBeNull();
  expect(screen.getByText('25')).toBeTruthy();
});

test('a key Google rejected shows in the provider status with Google\'s reason', async () => {
  statusResponse = async () => response({ ...quota(), keyProblem: { message: 'Permission denied on the service.', since: '2026-11-27T08:00:00Z' } });
  openYouTube();
  await screen.findByText('Google rejected the API key: Permission denied on the service.');
  expect(screen.queryByText('Configured for artist videos and mobile backgrounds')).toBeNull();
});

const creditStatus = (over: Record<string, unknown>) => ({
  state: 'running', eligible: 30000, lookedUp: 12345, withCredits: 8021, withoutCredits: 4000, failed: 324,
  creditRows: 40210, remaining: 17655, resumesAt: null, pauseReason: null, lastFinishedAt: null, ...over,
});

test('the Genius tab only shows the server-side credit import: progress while it runs, no button to start it', async () => {
  usePlayerStore.setState({ geniusApiKey: 'genius-key' } as never);
  fetchMock.mockImplementation(async url => url === '/api/library/credits/import/genius'
    ? response(creditStatus({})) : response({}));
  render(<MetadataTab />);
  fireEvent.click(screen.getByRole('button', { name: 'Genius' }));
  await screen.findByText(/Importing in the background\. 12,345 of 30,000 tracks looked up · 8,021 with credits/);
  expect(screen.getByRole('progressbar', { name: 'Producer and writer credits: tracks looked up' }).getAttribute('aria-valuenow')).toBe('41');
  expect(screen.getByText(/17,655 to go/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Import credits/ })).toBeNull();
  // It only ever reads the import; nothing is started from here.
  expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
});

test('a paused or finished MusicBrainz import says so in words', async () => {
  usePlayerStore.setState({ musicBrainzEnabled: true, musicBrainzConnected: true } as never);
  let status = creditStatus({ state: 'paused', pauseReason: 'rate-limit', resumesAt: new Date(2026, 10, 10, 14, 30).getTime() });
  fetchMock.mockImplementation(async url => url === '/api/library/credits/import/musicbrainz' ? response(status) : response({}));
  const { unmount } = render(<MetadataTab />);
  fireEvent.click(screen.getByRole('button', { name: 'MusicBrainz' }));
  const at = new Date(Number(status.resumesAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  await screen.findByText(new RegExp(`Paused: MusicBrainz asked Aurora to slow down\\. Carries on at ${at}\\.`));
  unmount();

  status = creditStatus({ state: 'idle', lookedUp: 30000, withCredits: 9100, remaining: 0 });
  render(<MetadataTab />);
  fireEvent.click(screen.getByRole('button', { name: 'MusicBrainz' }));
  await screen.findByText(/Every track is looked up: 9,100 of 30,000 have credits \(40,210 credit rows\)\. New tracks are looked up as they arrive\./);
  expect(screen.queryByRole('progressbar', { name: /Role credits/ })).toBeNull();
});
