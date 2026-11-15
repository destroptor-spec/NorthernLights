import { useState } from 'react';
import type { LogLevel, ServerLoggingSetting } from '../../../shared/logging';
import { usePlayerStore } from '../../store';
import { useToast } from '../../hooks/useToast';

const options: Array<{ key: ServerLoggingSetting; title: string; description: string }> = [
  { key: 'scannerLoggingEnabled', title: 'Library scanner', description: 'Folder walks, metadata processing, file changes, and scan progress.' },
  { key: 'analyzerLoggingEnabled', title: 'Audio analyzer', description: 'Track analysis timings, worker activity, and raw Python and TensorFlow diagnostics.' },
  { key: 'loudnessLoggingEnabled', title: 'Loudness computation', description: 'Measurement timings, loudness levels, and true peaks for scans and playback.' },
  { key: 'ffmpegLoggingEnabled', title: 'FFmpeg output', description: 'Detailed transcoder output in the server console and HLS files. Errors remain recorded when off.' },
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

const LEVELS: Array<{ value: LogLevel; label: string }> = [
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
];

export function ServerLoggingSettings() {
  const setServerLogging = usePlayerStore(state => state.setServerLogging);
  const setServerLogLevel = usePlayerStore(state => state.setServerLogLevel);
  const hlsDetailed = usePlayerStore(state => state.hlsLoggingEnabled);
  const logLevel = usePlayerStore(state => state.logLevel);
  const { addToast } = useToast();
  const [saving, setSaving] = useState<ServerLoggingSetting | 'logLevel' | null>(null);
  const saveLevel = async (level: LogLevel) => {
    setSaving('logLevel');
    try {
      await setServerLogLevel(level);
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not save the log level', 'error');
    } finally {
      setSaving(null);
    }
  };
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
        <h4 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Server logging</h4>
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
          Server-wide settings save immediately and apply to running jobs. Errors and actionable warnings remain recorded at every level.
        </p>
      </div>
      <div className="library-toggle-row">
        <div>
          <h5 id="log-level-label">Log level</h5>
          <p id="log-level-description">What the server prints and records in <code>logs/production.log</code>. Errors and warnings are recorded at every level, each also in its area's file.</p>
          {saving === 'logLevel' && <span role="status" className="text-xs text-[var(--color-text-muted)]">Saving…</span>}
        </div>
        <select
          aria-labelledby="log-level-label" aria-describedby="log-level-description"
          aria-busy={saving === 'logLevel'} disabled={saving !== null}
          className="shrink-0 min-h-11 p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] disabled:opacity-50"
          value={logLevel}
          onChange={event => void saveLevel(event.target.value as LogLevel)}
        >
          {LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
        </select>
      </div>
      <div className="library-toggle-row">
        <div>
          <h5 id="hls-logging-label">HLS diagnostics</h5>
          <p id="hls-logging-description">Normal keeps failures and session summaries. Detailed adds segment requests and playlist snapshots to HLS files and extra console output.</p>
          {saving === 'hlsLoggingEnabled' && <span role="status" className="text-xs text-[var(--color-text-muted)]">Saving…</span>}
        </div>
        <select
          aria-labelledby="hls-logging-label" aria-describedby="hls-logging-description"
          aria-busy={saving === 'hlsLoggingEnabled'} disabled={saving !== null}
          className="shrink-0 min-h-11 p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] disabled:opacity-50"
          value={hlsDetailed ? 'detailed' : 'normal'}
          onChange={event => void toggle('hlsLoggingEnabled', event.target.value === 'detailed')}
        >
          <option value="normal">Normal</option>
          <option value="detailed">Detailed</option>
        </select>
      </div>
      <div className="space-y-3">
        {options.map(option => <LoggingSwitch key={option.key} option={option} busy={saving !== null} saving={saving === option.key} onToggle={toggle} />)}
      </div>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        Each library switch adds that area's detail to the console, <code>logs/production.log</code> and its own file (<code>scanner.log</code>, <code>analyzer.log</code>, <code>loudness.log</code>); the area's errors are recorded there with the switch off too. HLS diagnostics control <code>logs/hls-server.log</code> and <code>logs/hls-sessions/</code>. Browser and Cast diagnostics are under Playback.
      </p>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        Aurora rotates its own logs, however the server runs: each file rotates at 50 MB, keeps 5 files, and is deleted after 30 days without writes. <code>LOG_MAX_FILE_MB</code>, <code>LOG_KEEP_FILES</code>, <code>LOG_RETENTION_DAYS</code> and <code>LOG_DIR</code> in <code>.env</code> change that.
      </p>
    </div>
  );
}
