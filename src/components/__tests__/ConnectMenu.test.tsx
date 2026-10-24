import { act, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { CHOICE_CONFIRM_MS, ConnectMenuContent, DEVICE_LEAVE_MS } from '../ConnectMenu';
import type { FollowedOutput } from '../../utils/sessionFollow';
import { getAuroraClientId } from '../../api/auroraApi';

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
      audioOutputSupported: true, audioOutputActive: false, audioOutputDeviceLabel: '', audioOutputDevices: [],
      syncPlaybackAcrossDevices: true, connectedDevices: [],
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
  const { resolvePlayWhere } = setup({ sessionFollow: follow() });
  expect(screen.getByText('Playing on NAD Forstærker')).toBeTruthy();
  expect(screen.getByRole('button', { name: /NAD Forstærker Control it from here/ })).toBeTruthy();
  screen.getByRole('button', { name: /This device Play here instead/ }).click();
  expect(resolvePlayWhere).toHaveBeenCalledWith('here');
});

test('a choice acts at once, then stays lit about a second before the card closes', () => {
  // Andreas, 2026-10-24: closing at once left him tapping again to be sure.
  jest.useFakeTimers();
  try {
    const { resolvePlayWhere, onDone } = setup({ sessionFollow: follow() });
    act(() => { screen.getByRole('button', { name: /NAD Forstærker Control it from here/ }).click(); });
    expect(resolvePlayWhere).toHaveBeenCalledWith('remote');
    const nad = screen.getByText('NAD Forstærker', { selector: '.connect-option-title' }).closest('button')!;
    expect(nad.className).toContain('is-chosen');
    expect(onDone).not.toHaveBeenCalled();

    // A second tap meanwhile does nothing.
    act(() => { screen.getByText('This device').closest('button')!.click(); });
    expect(resolvePlayWhere).toHaveBeenCalledTimes(1);

    act(() => { jest.advanceTimersByTime(CHOICE_CONFIRM_MS); });
    expect(onDone).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
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

test('has no output row where this browser cannot choose an output (the phone PWA)', () => {
  setup({ audioOutputSupported: false });
  expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull();
});

test('while casting, says where, and leaves the output to the Cast device', () => {
  setup({ castConnected: true });
  expect(screen.getByText(/^Casting to /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull();
});

describe("the user's other devices", () => {
  const me = () => getAuroraClientId();
  const devices = () => [
    { clientId: me(), name: 'Chrome on Linux', kind: 'browser' as const },
    { clientId: 'phone-0002', name: 'Chrome on Android', kind: 'browser' as const },
    { clientId: 'receiver:nad', name: null, kind: 'receiver' as const },
  ];

  test('lists each other device with Aurora open, and moves the music there', () => {
    jest.useFakeTimers();
    try {
      const transferPlaybackTo = jest.fn(async () => undefined);
      const { onDone } = setup({ connectedDevices: devices(), transferPlaybackTo });
      expect(screen.queryByRole('button', { name: /Chrome on Linux/ })).toBeNull(); // this device
      act(() => { screen.getByRole('button', { name: /Chrome on Android Play there/ }).click(); });
      expect(transferPlaybackTo).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'phone-0002' }));
      act(() => { jest.advanceTimersByTime(CHOICE_CONFIRM_MS); });
      expect(onDone).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('shows the playing device once (to control it), and no Cast receivers', () => {
    setup({ connectedDevices: devices(), sessionFollow: follow({ outputId: 'phone-0002', name: 'Chrome on Android', kind: 'browser' }) });
    expect(screen.getAllByRole('button', { name: /Chrome on Android/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Chrome on Android Control it from here/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Another device/ })).toBeNull();
  });

  test('updates live: a device that comes fades in, one that goes fades and folds away', () => {
    jest.useFakeTimers();
    try {
      setup({ connectedDevices: devices().slice(0, 1) });
      act(() => { usePlayerStore.setState({ connectedDevices: devices() } as never); });
      const row = () => screen.getByText('Chrome on Android').closest('.connect-device')!;
      expect(row().className).toContain('is-entering');

      act(() => { usePlayerStore.setState({ connectedDevices: devices().slice(0, 1) } as never); });
      // Still there while it folds away, but hidden and inert.
      expect(row().className).toContain('is-leaving');
      expect(screen.queryByRole('button', { name: /Chrome on Android/ })).toBeNull();
      act(() => { jest.advanceTimersByTime(DEVICE_LEAVE_MS); });
      expect(screen.queryByText('Chrome on Android')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('devices already there when the card opens do not animate', () => {
    setup({ connectedDevices: devices() });
    expect(screen.getByText('Chrome on Android').closest('.connect-device')!.className).toBe('connect-device');
  });

  test('lists none with sync off', () => {
    setup({ connectedDevices: devices(), syncPlaybackAcrossDevices: false });
    expect(screen.queryByRole('button', { name: /Chrome on Android/ })).toBeNull();
  });
});
