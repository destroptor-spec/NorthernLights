import React from 'react';
import { act, render } from '@testing-library/react';

type StateListener = (state: string) => void;

var mockCastState: string;
var mockStateListeners: Set<StateListener>;

jest.mock('../../utils/CastManager', () => ({
  castManager: {
    getCastState: () => mockCastState,
    getHealthStatus: () => ({ phase: 'idle', message: '', updatedAt: 0 }),
    getCastDeviceName: () => '',
    addStateChangeListener: (listener: StateListener) => {
      mockStateListeners.add(listener);
      return () => mockStateListeners.delete(listener);
    },
    addHealthChangeListener: () => () => {},
    logCastButtonState: jest.fn(),
    noteUserCastLaunchIntent: jest.fn(),
    noteUserCastDialogOpened: jest.fn(),
    disconnect: jest.fn(),
  },
}));

jest.mock('../../utils/SessionMirror', () => ({ sessionMirror: { notePlayIntent: jest.fn() } }));

import { fireEvent } from '@testing-library/react';
import { castManager } from '../../utils/CastManager';
import { sessionMirror } from '../../utils/SessionMirror';
import { CastButton } from './CastButton';

const emitCastState = (state: string) => {
  mockCastState = state;
  act(() => {
    mockStateListeners.forEach((listener) => listener(state));
  });
};

/**
 * Issue #40. On Android, "press Cast, nothing happens; restart the app and it
 * works". The SDK briefly reports NO_DEVICES_AVAILABLE while the picker opens.
 * CastButton used to return null for that state, unmounting the launcher
 * mid-request; the request never resolved and every later tap failed with
 * invalid_parameter until a reload.
 */
describe('CastButton', () => {
  beforeEach(() => {
    mockCastState = 'NOT_CONNECTED';
    mockStateListeners = new Set();
    (window as any).cast = { framework: {} };
  });

  afterEach(() => {
    delete (window as any).cast;
  });

  it('keeps the same launcher element through a no-devices flicker', () => {
    const { container } = render(<CastButton size="sm" />);
    const launcher = container.querySelector('google-cast-launcher');
    const control = container.querySelector('.aurora-cast-control') as HTMLElement;
    expect(launcher).not.toBeNull();
    expect(control.style.display).toBe('');

    emitCastState('NO_DEVICES_AVAILABLE');
    expect(launcher!.isConnected).toBe(true);
    expect(container.querySelector('google-cast-launcher')).toBe(launcher);
    expect(control.style.display).toBe('none');
    expect(control.getAttribute('aria-hidden')).toBe('true');

    emitCastState('NOT_CONNECTED');
    expect(container.querySelector('google-cast-launcher')).toBe(launcher);
    expect(control.style.display).toBe('');
    expect(control.hasAttribute('aria-hidden')).toBe(false);
  });

  it('starts hidden but mounted when no devices are known yet', () => {
    mockCastState = 'NO_DEVICES_AVAILABLE';
    const { container } = render(<CastButton size="sm" />);
    const control = container.querySelector('.aurora-cast-control') as HTMLElement;
    expect(container.querySelector('google-cast-launcher')).not.toBeNull();
    expect(control.style.display).toBe('none');
  });

  it('still renders nothing before the Cast SDK has loaded', () => {
    delete (window as any).cast;
    const { container } = render(<CastButton size="sm" />);
    expect(container.querySelector('google-cast-launcher')).toBeNull();
  });

  it('tells a tap that opens the Cast dialog while casting from one that starts a session', () => {
    const { container } = render(<CastButton size="sm" />);
    const shell = container.querySelector('.aurora-cast-button-shell')!;
    fireEvent.pointerDown(shell);
    expect(castManager.noteUserCastLaunchIntent).toHaveBeenCalledWith('launcher-sm');
    expect(castManager.noteUserCastDialogOpened).not.toHaveBeenCalled();

    emitCastState('CONNECTED');
    fireEvent.pointerDown(shell);
    expect(castManager.noteUserCastDialogOpened).toHaveBeenCalledWith('launcher-sm');
    expect(castManager.noteUserCastLaunchIntent).toHaveBeenCalledTimes(1);
  });

  // Prod 2026-10-13: the phone played locally, the desktop started casting,
  // and the phone kept playing because the desktop never claimed the output.
  it('counts starting a cast as "play here", but not opening the dialog while casting', () => {
    (sessionMirror.notePlayIntent as jest.Mock).mockClear();
    const { container } = render(<CastButton size="sm" />);
    const shell = container.querySelector('.aurora-cast-button-shell')!;
    fireEvent.pointerDown(shell);
    expect(sessionMirror.notePlayIntent).toHaveBeenCalledTimes(1);

    emitCastState('CONNECTED');
    fireEvent.pointerDown(shell);
    expect(sessionMirror.notePlayIntent).toHaveBeenCalledTimes(1);
  });
});
