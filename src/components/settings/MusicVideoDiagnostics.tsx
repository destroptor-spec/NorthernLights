import { useState } from 'react';
import { musicVideoDiagnosticReport, useMusicVideoDiagnostics } from '../../store/musicVideoDiagnostics';

const errorDescription = (code: number | undefined) => {
  if (code === 153) return 'YouTube could not identify the app embedding this video.';
  if (code === 101 || code === 150) return 'The video owner does not allow embedded playback.';
  if (code === 100) return 'The video is unavailable or private.';
  if (code === 5) return 'YouTube could not play the video in this browser.';
  return 'YouTube reported a playback error.';
};

export function MusicVideoDiagnostics() {
  const events = useMusicVideoDiagnostics(state => state.events);
  const [report, setReport] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const last = events.at(-1);
  const failure = [...events].reverse().find(entry => entry.event === 'embed-error');

  const copyReport = async () => {
    const text = musicVideoDiagnosticReport();
    setReport(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('Copied.');
    } catch {
      setCopyStatus('Select and copy the report below.');
    }
  };

  return (
    <div className="space-y-2 text-xs text-[var(--color-text-primary)]">
      <h5 className="text-sm font-medium">Music video diagnostics</h5>
      <p>Last attempt: <span className="font-mono">{last?.event ?? 'not requested'}{last?.code !== undefined ? ` (${last.code})` : ''}</span></p>
      {failure && <p>{errorDescription(failure.code)} Code: {failure.code}.</p>}
      <p className="text-[var(--color-text-muted)]">Open mobile Now Playing for the affected song, then return here. The report stays on this device unless you share it.</p>
      <button type="button" className="btn btn-ghost min-h-11" onClick={() => void copyReport()}>Copy video report</button>
      <p role="status">{copyStatus}</p>
      {report && <textarea aria-label="Music video diagnostic report" readOnly value={report} rows={8} className="w-full p-2 font-mono text-xs bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-lg" />}
    </div>
  );
}
