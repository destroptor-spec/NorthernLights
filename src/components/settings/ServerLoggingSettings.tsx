import { useState } from 'react';
import type { ServerLoggingSetting } from '../../../shared/logging';
import { usePlayerStore } from '../../store';
import { useToast } from '../../hooks/useToast';

const options: Array<{ key: ServerLoggingSetting; title: string; description: string }> = [
  { key: 'scannerLoggingEnabled', title: 'Library scanner', description: 'Folder walks, metadata processing, file changes, and scan progress.' },
  { key: 'analyzerLoggingEnabled', title: 'Audio analyzer', description: 'Track analysis timings, worker activity, and raw Python and TensorFlow diagnostics.' },
  { key: 'loudnessLoggingEnabled', title: 'Loudness computation', description: 'Measurement timings, loudness levels, and true peaks for scans and playback.' },
  { key: 'hlsLoggingEnabled', title: 'HLS pipeline logs', description: 'Segment requests, session readiness, and cleanup events.' },
  { key: 'ffmpegLoggingEnabled', title: 'FFmpeg output', description: 'Raw FFmpeg output from streaming and transcoding sessions.' },
];

function LoggingSwitch({ option, busy, saving, onToggle }: {
  option: typeof options[number]; busy: boolean; saving: boolean;
  onToggle: (key: ServerLoggingSetting, enabled: boolean) => void;
}) {
  const enabled = usePlayerStore(state => state[option.key]);
  return (
    <div className="library-toggle-row">
      <div>
        <h5 id={`${option.key}-label`}>{option.title}</h5>
        <p id={`${option.key}-description`}>{option.description}</p>
        {saving && <span role="status" className="text-xs text-[var(--color-text-muted)]">Saving…</span>}
      </div>
      <button
        type="button" role="switch" aria-checked={enabled}
        aria-labelledby={`${option.key}-label`} aria-describedby={`${option.key}-description`}
        aria-busy={saving} disabled={busy}
        className="account-switch after:absolute after:-inset-2 disabled:cursor-wait disabled:opacity-50"
        data-state={enabled ? 'on' : 'off'}
        onClick={() => onToggle(option.key, !enabled)}
      >
        <span aria-hidden="true" className="account-switch__thumb" />
      </button>
    </div>
  );
}

export function ServerLoggingSettings() {
  const setServerLogging = usePlayerStore(state => state.setServerLogging);
  const { addToast } = useToast();
  const [saving, setSaving] = useState<ServerLoggingSetting | null>(null);
  const toggle = async (key: ServerLoggingSetting, enabled: boolean) => {
    setSaving(key);
    try {
      await setServerLogging(key, enabled);
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not save logging setting', 'error');
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Server Console Logging</h4>
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
          Changes save immediately and apply to running jobs. Errors and actionable warnings remain visible when diagnostic logging is off.
        </p>
      </div>
      <div className="space-y-3">
        {options.map(option => <LoggingSwitch key={option.key} option={option} busy={saving !== null} saving={saving === option.key} onToggle={toggle} />)}
      </div>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        HLS session logs in <code>logs/hls-sessions/</code> are unaffected by these console settings.
      </p>
    </div>
  );
}
