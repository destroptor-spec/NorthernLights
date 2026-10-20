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
  const selectAudioOutput = jest.fn(async () => undefined);
  act(() => {
    usePlayerStore.setState({
      sessionFollow: null, remoteControlOutputId: null, castConnected: false,
      audioOutputSupported: false, audioOutputActive: false, audioOutputDeviceLabel: '', audioOutputSelecting: false,
      resolvePlayWhere, selectAudioOutput, ...state,
    } as never);
  });
  const onDone = jest.fn();
  render(<ConnectMenuContent onDone={onDone} />);
  return { resolvePlayWhere, selectAudioOutput, onDone };
};

afterEach(() => act(() => { usePlayerStore.setState({ sessionFollow: null, remoteControlOutputId: null } as never); }));

test('says the music plays here, with no choices to make', () => {
  setup({});
  expect(screen.getByText('Playing on this device')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Control/ })).toBeNull();
});

test('while another device plays: control it, or play here', () => {
  const { resolvePlayWhere, onDone } = setup({ sessionFollow: follow() });
  expect(screen.getByText('Playing on NAD Forstærker')).toBeTruthy();
  screen.getByRole('button', { name: 'Control NAD Forstærker' }).click();
  expect(resolvePlayWhere).toHaveBeenLastCalledWith('remote');
  screen.getByRole('button', { name: 'Play on this device' }).click();
  expect(resolvePlayWhere).toHaveBeenLastCalledWith('here');
  expect(onDone).toHaveBeenCalledTimes(2);
});

test('marks the device this one controls', () => {
  setup({ sessionFollow: follow(), remoteControlOutputId: 'receiver:nad' });
  expect(screen.getByRole('button', { name: /Control NAD Forstærker/ }).querySelector('[aria-label="chosen"]')).toBeTruthy();
});

test('a device that stopped answering can only be replaced by playing here', () => {
  setup({ sessionFollow: follow({ silent: true } as Partial<FollowedOutput>) });
  expect(screen.getByText("NAD Forstærker isn't responding")).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Control/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Play on this device' })).toBeTruthy();
});

test("chooses this device's audio output where the browser can, and not while casting", () => {
  const { selectAudioOutput } = setup({ audioOutputSupported: true, audioOutputActive: true, audioOutputDeviceLabel: 'Headphones' });
  screen.getByRole('button', { name: 'Output: Headphones' }).click();
  expect(selectAudioOutput).toHaveBeenCalled();
});

test('while casting, says where, and leaves the output to the Cast device', () => {
  setup({ castConnected: true, audioOutputSupported: true });
  expect(screen.getByText(/^Casting to /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /output/i })).toBeNull();
});
