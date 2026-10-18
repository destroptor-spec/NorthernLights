import { useState } from 'react';
import { usePlayerStore } from '../../store';
import { mintScopedToken } from '../../api/auroraApi';
import { castManager } from '../../utils/CastManager';
import { MusicVideoDiagnostics } from './MusicVideoDiagnostics';

const options = [
  { key: 'playbackDebugLogging', title: 'Browser playback diagnostics', description: 'Show local playback and prewarm details in this browser’s console and the telemetry readout below.' },
  { key: 'castDebugLogging', title: 'Cast diagnostics', description: 'Include detailed receiver events in the server Cast log. Updates supported active receivers immediately; older receivers apply it on the next media load.' },
] as const;

export function PlaybackLoggingSettings() {
  const playbackDebugLogging = usePlayerStore(state => state.playbackDebugLogging);
  const castDebugLogging = usePlayerStore(state => state.castDebugLogging);
  const setSettings = usePlayerStore(state => state.setSettings);
  const castConnected = usePlayerStore(state => state.castConnected);
  const values = { playbackDebugLogging, castDebugLogging };
  const [probing, setProbing] = useState(false);

  // Phase 5 probe: results go to the server Cast log as receiver-probe markers.
  const runProbe = async () => {
    const { getAuthHeader, addToast } = usePlayerStore.getState();
    setProbing(true);
    try {
      const { token } = await mintScopedToken(getAuthHeader(), 'sse', '15m');
      const result = await castManager.runReceiverProbe(token);
      if (result === 'busy') addToast('The receiver is still running the previous probe.', 'error');
      else if (result !== 'started') addToast("The receiver didn't start the probe. It may not have the probe yet.", 'error');
    } catch {
      addToast("Couldn't start the receiver probe.", 'error');
    } finally {
      setProbing(false);
    }
  };
  return (
    <div className="mb-6 space-y-3">
      <p className="text-xs text-[var(--color-text-muted)]">Diagnostics preferences are saved on this browser. Server logging is configured under System → Logging.</p>
      {options.map(option => (
        <div key={option.key} className="library-toggle-row">
          <div>
            <h5 id={`${option.key}-label`}>{option.title}</h5>
            <p id={`${option.key}-description`}>{option.description}</p>
          </div>
          <button
            type="button" role="switch" aria-checked={values[option.key]}
            aria-labelledby={`${option.key}-label`} aria-describedby={`${option.key}-description`}
            className="account-switch after:absolute after:-inset-2"
            data-state={values[option.key] ? 'on' : 'off'}
            onClick={() => setSettings({ [option.key]: !values[option.key] })}
          ><span aria-hidden="true" className="account-switch__thumb" /></button>
        </div>
      ))}
      {playbackDebugLogging && <MusicVideoDiagnostics />}
      {castDebugLogging && castConnected && (
        <div className="library-toggle-row">
          <div>
            <h5>Receiver probe</h5>
            <p>Tests whether the Cast device can follow a playback session on its own, and logs the results in the server Cast log. Playback is not interrupted.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={probing} onClick={() => void runProbe()}>Run probe</button>
        </div>
      )}
    </div>
  );
}
