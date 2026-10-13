import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, HardDriveDownload, Loader2, Trash2 } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { ConfirmModal } from '../ConfirmModal';

interface ExportManifest {
  name: string;
  label: string | null;
  createdAt: string;
  app: { version: string; commit: string };
  schemaFingerprint: string;
  rowCounts: Record<string, number>;
  dump: { bytes: number };
}

interface ExportsResponse {
  available: { ok: true; method: 'container' | 'host' } | { ok: false; reason: string };
  job: { state: 'running' | 'done' | 'failed'; name?: string; error?: string } | null;
  exports: ExportManifest[];
  keep: number;
}

const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const RESTORE_GUIDE_URL = 'https://github.com/destroptor-spec/NorthernLights/blob/main/docs/production_guide.md#moving-to-a-new-server';

/** How an export comes back: on the server, from the shell, with Aurora stopped. */
const RestoreHelp: React.FC<{ latest: string | null }> = ({ latest }) => {
  const command = `npm run db:import -- backups/${latest ?? '<export>.dump'} --keep-secrets`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context); the command stays selectable.
    }
  };
  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
      <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Restoring an export</h4>
      <p className="text-sm text-[var(--color-text-muted)] mt-1">
        Restore on the server, from the Aurora folder. To move to a new server, copy the export's <code>.dump</code> and{' '}
        <code>.json</code> into its <code>backups/</code> folder first. Stop Aurora, then run:
      </p>
      <div className="flex items-center gap-2 mt-3">
        <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap font-mono text-xs bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] select-all">
          {command}
        </code>
        <button onClick={() => void copy()} className="btn btn-ghost btn-sm flex-shrink-0" aria-label="Copy the restore command">
          {copied ? <Check size={14} /> : <Copy size={14} />} Copy
        </button>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mt-3">
        The import checks the file, restores into a new database and verifies it, then asks before switching; the
        current database is kept. The music must be at the same paths as on the original server. Use{' '}
        <code>--rotate-secrets</code> instead for a test copy.{' '}
        <a href={RESTORE_GUIDE_URL} target="_blank" rel="noreferrer" className="text-[var(--color-primary)] underline inline-flex items-center gap-1">
          Full steps <ExternalLink size={12} />
        </a>
      </p>
    </div>
  );
};

/**
 * Database exports (docs/database_export_import.md): export now, then download
 * or delete. A running export shows only the button's spinner; text appears
 * only when something failed.
 */
export const DatabaseBackups: React.FC<{ pollIntervalMs?: number }> = ({ pollIntervalMs = 2000 }) => {
  const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
  const { addToast } = useToast();
  const [data, setData] = useState<ExportsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/db/exports', { headers: getAuthHeader() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server error: ${res.status}`);
      setData(body);
      setLoadError(null);
      return body as ExportsResponse;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load exports');
      return null;
    }
  }, [getAuthHeader]);

  useEffect(() => { void load(); }, [load]);

  const running = data?.job?.state === 'running';

  // Poll only while an export runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void load(); }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [running, load, pollIntervalMs]);

  // Report a failure once, when the job we saw running settles as failed,
  // whichever load noticed it.
  const previousJobState = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state = data?.job?.state;
    if (previousJobState.current === 'running' && state === 'failed') addToast(`Export failed: ${data?.job?.error}`, 'error');
    previousJobState.current = state;
  }, [data, addToast]);

  const startExport = async () => {
    const res = await fetch('/api/admin/db/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addToast(body.error || 'Failed to start the export', 'error');
      return;
    }
    await load();
  };

  const download = async (name: string) => {
    const res = await fetch(`/api/admin/db/exports/${encodeURIComponent(name)}/download-ticket`, {
      method: 'POST',
      headers: getAuthHeader(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.url !== 'string') {
      addToast(body.error || 'Failed to start the download', 'error');
      return;
    }
    // A native download streams the file instead of buffering it in memory.
    const link = document.createElement('a');
    link.href = body.url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const remove = async (name: string) => {
    setPendingDelete(null);
    const res = await fetch(`/api/admin/db/exports/${encodeURIComponent(name)}`, { method: 'DELETE', headers: getAuthHeader() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addToast(body.error || 'Failed to delete the export', 'error');
    }
    await load();
  };

  const unavailable = data && !data.available.ok ? data.available.reason : null;

  return (
    <div className="space-y-4">
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
        <div className="flex justify-between items-start gap-4 mb-4">
          <div>
            <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Database exports</h4>
            <p className="text-sm text-[var(--color-text-muted)]">
              A complete copy of the database for backups and moving to a new server.
              Stored on the server; the newest {data?.keep ?? 10} are kept.
            </p>
          </div>
          <button
            onClick={() => void startExport()}
            disabled={running || !!unavailable || !data}
            className="btn btn-primary btn-sm flex-shrink-0"
            aria-label="Export database now"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <HardDriveDownload size={16} />} Export now
          </button>
        </div>

        {unavailable && <p className="text-sm text-[var(--color-error)] mb-3">{unavailable}</p>}
        {loadError && <p className="text-sm text-[var(--color-error)] mb-3">{loadError}</p>}

        {data && data.exports.length === 0 && !running && (
          <p className="text-sm text-[var(--color-text-muted)]">No exports yet.</p>
        )}

        {data && data.exports.length > 0 && (
          <ul className="divide-y divide-[var(--glass-border)]">
            {data.exports.map((manifest) => (
              <li key={manifest.name} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-[var(--color-text-primary)] truncate">
                    {new Date(manifest.createdAt).toLocaleString()}
                    {manifest.label && <span className="text-[var(--color-text-muted)]"> · {manifest.label}</span>}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] truncate">
                    {formatSize(manifest.dump.bytes)} · {(manifest.rowCounts.tracks ?? 0).toLocaleString()} tracks
                    {' · '}v{manifest.app.version} ({manifest.app.commit}) · schema {manifest.schemaFingerprint.slice(0, 8)}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => void download(manifest.name)} className="btn btn-ghost btn-sm" aria-label={`Download export from ${new Date(manifest.createdAt).toLocaleString()}`}>
                    <Download size={14} /> Download
                  </button>
                  <button
                    onClick={() => setPendingDelete(manifest.name)}
                    disabled={running}
                    className="btn btn-icon btn-danger"
                    aria-label={`Delete export from ${new Date(manifest.createdAt).toLocaleString()}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <RestoreHelp latest={data?.exports[0]?.name ?? null} />

      {pendingDelete && (
        <ConfirmModal
          title="Delete export"
          message="This permanently deletes the export file from the server."
          confirmLabel="Delete"
          confirmTone="danger"
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
};
