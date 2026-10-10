import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybackLoggingSettings } from './PlaybackLoggingSettings';
import { usePlayerStore } from '../../store';
import { castManager } from '../../utils/CastManager';
import { resolveLoggingPreferences } from '../../utils/loggingPreferences';

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
