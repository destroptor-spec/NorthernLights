import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MusicVideoDiagnostics } from './MusicVideoDiagnostics';
import { beginMusicVideoDiagnostics, musicVideoDiagnosticReport, recordMusicVideoEvent } from '../../store/musicVideoDiagnostics';

const originalMatchMedia = window.matchMedia;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  window.matchMedia = jest.fn().mockReturnValue({ matches: true });
});
afterEach(() => {
  jest.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

test('shows and copies the last player failure and the actual loaded build', async () => {
  beginMusicVideoDiagnostics('track-id', 'lookup');
  recordMusicVideoEvent('embed-error', 153);
  const script = document.createElement('script');
  script.src = '/assets/index-oldBuild.js?token=secret';
  document.head.appendChild(script);
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { unmount } = render(<MusicVideoDiagnostics />);
  expect(screen.getByText(/could not identify the app/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy video report' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied.'));
  const report = writeText.mock.calls[0][0];
  expect(JSON.parse(report)).toMatchObject({ build: '/assets/index-oldBuild.js', trackId: 'track-id', events: expect.arrayContaining([expect.objectContaining({ event: 'embed-error', code: 153 })]) });
  expect(report).not.toContain('secret');
  unmount();
  script.remove();
});

test('clipboard denial leaves a selectable report', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) } });
  render(<MusicVideoDiagnostics />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy video report' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Select and copy the report below.'));
  expect((screen.getByRole('textbox', { name: 'Music video diagnostic report' }) as HTMLTextAreaElement).value).toContain('events');
});

test('keeps a bounded history without storing exception messages or credentials', () => {
  beginMusicVideoDiagnostics('bounded', 'lookup');
  for (let i = 0; i < 100; i++) recordMusicVideoEvent('state', 3);
  expect(JSON.parse(musicVideoDiagnosticReport()).events).toHaveLength(20);
});
