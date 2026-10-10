import { usePlayerStore } from '../../store';

const options = [
  { key: 'playbackDebugLogging', title: 'Browser playback diagnostics', description: 'Show local playback and prewarm details in this browser’s console and the telemetry readout below.' },
  { key: 'castDebugLogging', title: 'Cast diagnostics', description: 'Include detailed receiver events in the server Cast log. Updates supported active receivers immediately; older receivers apply it on the next media load.' },
] as const;

export function PlaybackLoggingSettings() {
  const playbackDebugLogging = usePlayerStore(state => state.playbackDebugLogging);
  const castDebugLogging = usePlayerStore(state => state.castDebugLogging);
  const setSettings = usePlayerStore(state => state.setSettings);
  const values = { playbackDebugLogging, castDebugLogging };
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
    </div>
  );
}
