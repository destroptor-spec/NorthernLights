import { act, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { CHOICE_CONFIRM_MS, ConnectButton, ConnectMenuContent, DEVICE_LEAVE_MS } from '../ConnectMenu';
import type { FollowedOutput } from '../../utils/sessionFollow';
import { getAuroraClientId } from '../../api/auroraApi';
import { castManager } from '../../utils/CastManager';
import { sessionMirror } from '../../utils/SessionMirror';
import type { CastStatus } from '../../hooks/useCastStatus';

const noCast: CastStatus = { available: false, connected: false, busy: false, deviceName: '' };
let mockCast: CastStatus = noCast;
jest.mock('../../hooks/useCastStatus', () => ({ useCastStatus: () => mockCast }));

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
      audioOutputSupported: true, audioOutputPermission: 'granted', audioOutputActive: false, audioOutputDeviceLabel: '', audioOutputDevices: [],
      syncPlaybackAcrossDevices: true, connectedDevices: [],
      resolvePlayWhere, openSettingsAt, ...state,
    } as never);
  });
  const onDone = jest.fn();
  render(<ConnectMenuContent onDone={onDone} />);
  return { resolvePlayWhere, openSettingsAt, onDone };
};

afterEach(() => {
  mockCast = noCast;
  jest.restoreAllMocks();
  act(() => { usePlayerStore.setState({ sessionFollow: null, remoteControlOutputId: null } as never); });
});

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

test('has no output row on a phone, even where the browser claims it can route (Android Chrome)', () => {
  const ua = jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
  try {
    setup({ audioOutputSupported: true });
    expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull();
  } finally {
    ua.mockRestore();
  }
});

test('has no output row where Settings cannot name speakers (no microphone)', () => {
  setup({ audioOutputSupported: true, audioOutputPermission: 'unavailable' });
  expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull();
});

test('keeps the output row when access is denied: Settings can ask again', () => {
  setup({ audioOutputSupported: true, audioOutputPermission: 'denied' });
  expect(screen.getByRole('button', { name: /^Output/ })).toBeTruthy();
});

test('while casting, says where, and leaves the output to the Cast device', () => {
  setup({ castConnected: true });
  expect(screen.getByText(/^Casting to /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull();
});

describe('Cast, in the card (step 2: no Cast button of its own)', () => {
  const castReady = (status: Partial<CastStatus> = {}) => { mockCast = { ...noCast, available: true, ...status }; };

  test('opens Chrome\'s device picker in the tap, counts it as "play here", and closes the card', () => {
    castReady();
    const open = jest.spyOn(castManager, 'openCastPicker').mockReturnValue('opened');
    const playIntent = jest.spyOn(sessionMirror, 'notePlayIntent').mockImplementation(() => undefined);
    const { onDone } = setup({});
    act(() => { screen.getByRole('button', { name: /Cast to a device/ }).click(); });
    expect(open).toHaveBeenCalledWith('connect-menu');
    expect(playIntent).toHaveBeenCalledTimes(1);
    // The picker is the confirmation: no second of lit choice first.
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('a tap while the picker is still open does nothing more (#40)', () => {
    castReady();
    jest.spyOn(castManager, 'openCastPicker').mockReturnValue('pending');
    const playIntent = jest.spyOn(sessionMirror, 'notePlayIntent').mockImplementation(() => undefined);
    const { onDone } = setup({});
    act(() => { screen.getByRole('button', { name: /Cast to a device/ }).click(); });
    expect(playIntent).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  test('cannot be tapped while Cast connects, and shows a spinner instead of text', () => {
    castReady({ busy: true });
    setup({});
    const row = screen.getByRole('button', { name: /Cast to a device/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.querySelector('.connect-spinner')).not.toBeNull();
  });

  test('is not offered without the Cast SDK or a device to cast to', () => {
    setup({});
    expect(screen.queryByRole('button', { name: /Cast to a device/ })).toBeNull();
  });

  test('is offered while another device plays too', () => {
    castReady();
    setup({ sessionFollow: follow() });
    expect(screen.getByRole('button', { name: /Cast to a device/ })).toBeTruthy();
  });

  test('while casting: "This device" stops casting, lit a second like any choice', () => {
    jest.useFakeTimers();
    try {
      castReady({ connected: true, deviceName: 'NAD Forstærker' });
      const stop = jest.spyOn(castManager, 'disconnect').mockResolvedValue(undefined);
      const { onDone } = setup({ castConnected: true });
      expect(screen.queryByRole('button', { name: /Cast to a device/ })).toBeNull();
      act(() => { screen.getByRole('button', { name: /This device Stop casting/ }).click(); });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: /This device Stop casting/ }).className).toContain('is-chosen');
      act(() => { jest.advanceTimersByTime(CHOICE_CONFIRM_MS); });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the Connect button shows casting and connecting where the Cast button was', () => {
    castReady({ busy: true });
    const busy = render(<ConnectButton />);
    const button = busy.getByRole('button', { name: 'Connect to a device' });
    expect(button.className).toContain('is-elsewhere');
    expect(button.querySelector('.connect-spinner')).not.toBeNull();
    busy.unmount();

    castReady({ connected: true });
    const casting = render(<ConnectButton />);
    expect(casting.getByRole('button', { name: 'Connect to a device' }).className).toContain('is-elsewhere');
  });
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

describe("taps inside the open card never reach what the button sits in (the mini player's tap-to-expand)", () => {
  const openInside = () => {
    setup({ sessionFollow: follow() }); // store state for the card; this render is not used
    const expand = jest.fn();
    const view = render(<div onClick={expand} onKeyDown={expand}><ConnectButton /></div>);
    act(() => { view.getAllByRole('button', { name: 'Connect to a device' }).at(-1)!.click(); });
    expect(expand).not.toHaveBeenCalled();
    return expand;
  };

  test('choosing in the card (desktop popover)', () => {
    const expand = openInside();
    act(() => { screen.getAllByRole('button', { name: /This device Play here instead/ }).at(-1)!.click(); });
    expect(expand).not.toHaveBeenCalled();
  });

  test("closing the phone's bottom sheet by tapping outside it", () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      const expand = openInside();
      const backdrop = document.body.querySelector('.fixed.inset-0') as HTMLElement;
      expect(backdrop).toBeTruthy();
      act(() => { backdrop.click(); });
      expect(expand).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});
