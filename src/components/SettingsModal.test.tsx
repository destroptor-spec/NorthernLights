import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { usePlayerStore } from '../store';

jest.mock('./settings/AccountTab', () => ({ AccountTab: () => <input aria-label="Account draft" defaultValue="Initial" /> }));
jest.mock('./settings/PlaybackTab', () => ({ PlaybackTab: () => <div>Playback controls</div> }));
jest.mock('./settings/AppearanceTab', () => ({ AppearanceTab: () => <div>Appearance controls</div> }));

const originalMatchMedia = window.matchMedia;
const originalStore = usePlayerStore.getState();
let mediaChange: (event: { matches: boolean }) => void;
let compact: boolean;
let save: jest.Mock;
beforeEach(() => {
  compact = true;
  window.matchMedia = jest.fn().mockImplementation(() => ({
    matches: compact,
    addEventListener: (_type: string, listener: typeof mediaChange) => { mediaChange = listener; },
    removeEventListener: jest.fn(),
  }));
  save = jest.fn().mockResolvedValue(undefined);
  usePlayerStore.setState({
    currentUser: { id: 'test', username: 'Listener', role: 'admin' },
    loadSettings: jest.fn().mockResolvedValue(undefined), saveSettings: save,
  });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  usePlayerStore.setState(originalStore);
});

test('mobile opens on the menu and preserves section drafts across Back', async () => {
  render(<SettingsModal onClose={jest.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(screen.queryByLabelText('Account draft')).toBeNull();
  const account = screen.getByRole('button', { name: 'My Account' });
  fireEvent.click(account);
  const draft = await screen.findByLabelText('Account draft');
  fireEvent.change(draft, { target: { value: 'Unsaved draft' } });
  expect(screen.getByRole('dialog', { name: 'My Account' })).toBeTruthy();
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
  expect(document.activeElement).toBe(account);
  expect(document.getElementById('settings-section')?.hasAttribute('inert')).toBe(true);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(account);
  expect((screen.getByLabelText('Account draft') as HTMLInputElement).value).toBe('Unsaved draft');
});

test('search and menu scroll survive a section visit', async () => {
  render(<SettingsModal onClose={jest.fn()} />);
  const search = screen.getByRole('textbox', { name: 'Search settings' });
  fireEvent.change(search, { target: { value: 'play' } });
  const menu = screen.getByRole('navigation');
  menu.scrollTop = 75;
  fireEvent.click(screen.getByRole('button', { name: 'Playback' }));
  await screen.findByText('Playback controls');
  fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
  expect((search as HTMLInputElement).value).toBe('play');
  expect(menu.scrollTop).toBe(75);
  expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
});

test('Escape backs out of a section, then saves and closes from the menu', async () => {
  const onClose = jest.fn();
  render(<SettingsModal onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
  await screen.findByText('Appearance controls');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('navigation')).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledTimes(1);
});

test('unmatched searches show an empty state and listener accounts exclude admin sections', () => {
  usePlayerStore.setState({ currentUser: { id: 'test', username: 'Listener', role: 'user' } });
  render(<SettingsModal onClose={jest.fn()} />);
  expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'System' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'does not exist' } });
  expect(screen.getByRole('status').textContent).toContain('No matching settings');
  expect(screen.getByRole('button', { name: 'Sign Out' })).toBeTruthy();
});

test('desktop retains its sidebar and content, and resizing exposes the mobile menu', async () => {
  compact = false;
  render(<SettingsModal onClose={jest.fn()} />);
  await screen.findByLabelText('Account draft');
  expect(screen.getByRole('navigation')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Back to settings' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Playback' }));
  await screen.findByText('Playback controls');
  expect(screen.getByRole('navigation')).toBeTruthy();
  act(() => mediaChange({ matches: true }));
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(document.getElementById('settings-section')?.hasAttribute('inert')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Playback' }));
  await screen.findByText('Playback controls');
});
