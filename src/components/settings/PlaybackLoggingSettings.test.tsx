import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlaybackLoggingSettings } from './PlaybackLoggingSettings';
import { usePlayerStore } from '../../store';
import { castManager } from '../../utils/CastManager';
import { resolveLoggingPreferences } from '../../utils/loggingPreferences';
import * as auroraApi from '../../api/auroraApi';

afterEach(() => jest.restoreAllMocks());

test('browser and Cast switches change independently and persist independently', () => {
  usePlayerStore.setState({ playbackDebugLogging: false, castDebugLogging: false });
  const cast = jest.spyOn(castManager, 'setDiagnosticsVerbose').mockImplementation(() => {});
  render(<PlaybackLoggingSettings />);
  fireEvent.click(screen.getByRole('switch', { name: 'Browser playback diagnostics' }));
  expect(cast).not.toHaveBeenCalled();
  expect(usePlayerStore.getState()).toMatchObject({ playbackDebugLogging: true, castDebugLogging: false });
  fireEvent.click(screen.getByRole('switch', { name: 'Cast diagnostics' }));
  expect(cast).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('switch', { name: 'Browser playback diagnostics' }));
  expect(usePlayerStore.getState()).toMatchObject({ playbackDebugLogging: false, castDebugLogging: true });
  const saved = usePlayerStore.persist.getOptions().partialize!(usePlayerStore.getState());
  expect(saved).toMatchObject({ playbackDebugLogging: false, castDebugLogging: true });
});

test('rehydration migrates the old combined setting without overwriting an explicit Cast choice', () => {
  const merge = usePlayerStore.persist.getOptions().merge!;
  expect(merge({ playbackDebugLogging: true }, usePlayerStore.getState())).toMatchObject({ playbackDebugLogging: true, castDebugLogging: true });
  expect(merge({ playbackDebugLogging: true, castDebugLogging: false }, usePlayerStore.getState())).toMatchObject({ playbackDebugLogging: true, castDebugLogging: false });
  expect(resolveLoggingPreferences({})).toEqual({ playbackDebugLogging: false, castDebugLogging: false });
});

test('offers the receiver probe only while casting with Cast diagnostics on, and says only when it fails', async () => {
  usePlayerStore.setState({ castDebugLogging: false, castConnected: true });
  jest.spyOn(castManager, 'setDiagnosticsVerbose').mockImplementation(() => {});
  const { rerender } = render(<PlaybackLoggingSettings />);
  expect(screen.queryByRole('button', { name: 'Run probe' })).toBeNull();

  usePlayerStore.setState({ castDebugLogging: true, castConnected: false });
  rerender(<PlaybackLoggingSettings />);
  expect(screen.queryByRole('button', { name: 'Run probe' })).toBeNull();

  const addToast = jest.fn();
  usePlayerStore.setState({ castConnected: true, addToast });
  rerender(<PlaybackLoggingSettings />);
  const mint = jest.spyOn(auroraApi, 'mintScopedToken').mockResolvedValue({ token: 'sse-15m', expiresAt: '' });
  const probe = jest.spyOn(castManager, 'runReceiverProbe').mockResolvedValue('started');
  fireEvent.click(screen.getByRole('button', { name: 'Run probe' }));
  await waitFor(() => expect(probe).toHaveBeenCalledWith('sse-15m'));
  expect(mint).toHaveBeenCalledWith(expect.anything(), 'sse', '15m');
  expect(addToast).not.toHaveBeenCalled();

  // The real Cast manager reports itself disconnected in the meantime.
  act(() => usePlayerStore.setState({ castConnected: true }));
  probe.mockResolvedValue('unanswered');
  fireEvent.click(await screen.findByRole('button', { name: 'Run probe' }));
  await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining("didn't start the probe"), 'error'));
});
