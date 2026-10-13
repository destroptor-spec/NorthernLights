import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DatabaseBackups } from './DatabaseBackups';

const mockStore = { getAuthHeader: () => ({ Authorization: 'Bearer t' }) }; // stable, like the real store
jest.mock('../../store/index', () => ({ usePlayerStore: (select: (s: unknown) => unknown) => select(mockStore) }));
const addToast = jest.fn();
jest.mock('../../hooks/useToast', () => ({ useToast: () => ({ addToast }) }));

const manifest = {
  name: 'aurora-20261013T074103Z-2fb18b6.dump', label: null, createdAt: '2026-10-13T07:41:03.000Z',
  app: { version: '1.0.0-rc.6', commit: '2fb18b6' }, schemaFingerprint: '3c33e2d965c176d4', rowCounts: { tracks: 28379 },
  dump: { bytes: 196380776 },
};

function respond(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

describe('DatabaseBackups', () => {
  beforeEach(() => { addToast.mockReset(); });

  it('lists exports and downloads through a single-use ticket, never with the login token in the URL', async () => {
    const fetchMock = jest.fn((url: string) => url.endsWith('/download-ticket')
      ? respond({ url: '/api/admin/db/exports/download?ticket=abc' })
      : respond({ available: { ok: true, method: 'container' }, job: null, exports: [manifest], keep: 10 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<DatabaseBackups />);
    expect(await screen.findByText(/187\.3 MB · 28,379 tracks/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Download export/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe('/api/admin/db/exports/download?ticket=abc');
    click.mockRestore();
  });

  it('explains how to restore, with the newest export filled in and a link to the full steps', async () => {
    global.fetch = jest.fn(() => respond({ available: { ok: true, method: 'container' }, job: null, exports: [manifest], keep: 10 })) as unknown as typeof fetch;
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DatabaseBackups />);
    const command = `npm run db:import -- backups/${manifest.name} --keep-secrets`;
    expect(await screen.findByText(command)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the restore command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    const guide = screen.getByRole('link', { name: /Full steps/ });
    expect(guide.getAttribute('href')).toMatch(/docs\/production_guide\.md#moving-to-a-new-server$/);
    expect(guide.getAttribute('target')).toBe('_blank');
  });

  it('explains why exporting is unavailable and disables the button', async () => {
    global.fetch = jest.fn(() => respond({ available: { ok: false, reason: 'No running database container' }, job: null, exports: [], keep: 10 })) as unknown as typeof fetch;
    render(<DatabaseBackups />);
    expect(await screen.findByText('No running database container')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Export database now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows only the spinner while exporting, and reports a failure once', async () => {
    let state: 'running' | 'failed' = 'running';
    global.fetch = jest.fn(() => respond({
      available: { ok: true, method: 'container' }, keep: 10, exports: [],
      job: state === 'running' ? { state } : { state, error: 'pg_dump exited with code 1' },
    })) as unknown as typeof fetch;
    render(<DatabaseBackups pollIntervalMs={20} />);
    const button = await screen.findByRole('button', { name: 'Export database now' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.queryByText(/in progress|starting|exporting/i)).toBeNull();
    state = 'failed';
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Export failed: pg_dump exited with code 1', 'error'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(addToast).toHaveBeenCalledTimes(1); // polling stopped once settled
  });
});
