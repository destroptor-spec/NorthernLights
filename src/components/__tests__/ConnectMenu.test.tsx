import { act, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { ConnectMenuContent } from '../ConnectMenu';
import type { FollowedOutput } from '../../utils/sessionFollow';

const follow = (overrides: Partial<FollowedOutput> = {}): FollowedOutput => ({
  sessionId: 's1', outputId: 'receiver:nad', name: 'NAD Forstærker', kind: 'receiver', generation: 3,
  state: 'playing', entryId: 'e1', positionMs: 0, anchorMs: 0, ...overrides,
} as FollowedOutput);

const setup = (state: Record<string, unknown>) => {
  const resolvePlayWhere = jest.fn(async () => undefined);
  const openSettingsAt = jest.fn();
  act(() => {
    usePlayerStore.setState({
      sessionFollow: null, remoteControlOutputId: null, castConnected: false,
      audioOutputActive: false, audioOutputDeviceLabel: '', audioOutputDevices: [],
      resolvePlayWhere, openSettingsAt, ...state,
    } as never);
  });
  const onDone = jest.fn();
  render(<ConnectMenuContent onDone={onDone} />);
  return { resolvePlayWhere, openSettingsAt, onDone };
};

afterEach(() => act(() => { usePlayerStore.setState({ sessionFollow: null, remoteControlOutputId: null } as never); }));

test('says the music plays here, with this device chosen and nothing else to pick', () => {
  setup({});
  expect(screen.getByText('Playing on this device')).toBeTruthy();
  const here = screen.getByRole('button', { name: /This device Playing here/ });
  expect(here.className).toContain('is-selected');
  expect(screen.queryByRole('button', { name: /Control/ })).toBeNull();
});

test('while another device plays: one button to control it, one to play here', () => {
  const { resolvePlayWhere, onDone } = setup({ sessionFollow: follow() });
  expect(screen.getByText('Playing on NAD Forstærker')).toBeTruthy();
  screen.getByRole('button', { name: /NAD Forstærker Control it from here/ }).click();
  expect(resolvePlayWhere).toHaveBeenLastCalledWith('remote');
  screen.getByRole('button', { name: /This device Play here instead/ }).click();
  expect(resolvePlayWhere).toHaveBeenLastCalledWith('here');
  expect(onDone).toHaveBeenCalledTimes(2);
});

test('marks the device this one controls', () => {
  setup({ sessionFollow: follow(), remoteControlOutputId: 'receiver:nad' });
  const nad = screen.getByRole('button', { name: /NAD Forstærker Controlled from here/ });
  expect(nad.className).toContain('is-selected');
  expect(nad.getAttribute('aria-pressed')).toBe('true');
});

test('a device that stopped answering cannot be chosen; playing here can', () => {
  setup({ sessionFollow: follow({ silent: true } as Partial<FollowedOutput>) });
  expect(screen.getByText("NAD Forstærker isn't responding")).toBeTruthy();
  expect((screen.getByRole('button', { name: /NAD Forstærker Isn't responding/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: /This device Play here instead/ }) as HTMLButtonElement).disabled).toBe(false);
});

test("names this device's output and opens Settings → Playback → Output", () => {
  const { openSettingsAt, onDone } = setup({ audioOutputActive: true, audioOutputDeviceLabel: 'Headphones' });
  screen.getByRole('button', { name: /Output Headphones/ }).click();
  expect(openSettingsAt).toHaveBeenCalledWith('Playback', 'output');
  expect(onDone).toHaveBeenCalled();
});

test('names the system default output when none is chosen', () => {
  setup({ audioOutputDevices: [{ deviceId: 'default', label: 'Built-in Audio', isDefault: true }] });
  expect(screen.getByRole('button', { name: /Output Built-in Audio/ })).toBeTruthy();
});

test('while casting, says where, and leaves the output to the Cast device', () => {
  setup({ castConnected: true });
  expect(screen.getByText(/^Casting to /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull();
});
