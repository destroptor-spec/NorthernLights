import { useState, useEffect, useCallback, useRef } from 'react';
import { Database, Power, PowerOff, RotateCcw, Loader2, AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { usePlayerStore } from '../store';

interface DatabaseStatus {
  status: 'running' | 'stopped' | 'not_found' | 'error';
  name: string;
  image?: string;
  ports?: string;
  created?: string;
  error?: string;
  configuredData?: {
    image: string;
    dataDir: string;
    port: string;
    user: string;
    name: string;
  };
}

interface DatabaseStats {
  tables: number;
  indexes: number;
  tracks: number;
  artists: number;
  albums: number;
  genres: number;
  playlists: number;
  pool?: {
    total: number;
    idle: number;
    waiting: number;
  };
}

interface DatabaseControlProps {
  onReady?: () => void;
  inline?: boolean;
  variant?: 'full' | 'stats';
}

// Sub-component: Stat Card
const StatCard = ({ label, value, icon: Icon, colorClass = "text-[var(--color-primary)]" }: { label: string; value: number | string; icon: any; colorClass?: string }) => (
  <div className="bg-[var(--color-bg-tertiary)]/50 border border-[var(--color-border)] p-3 rounded-xl flex items-center gap-3">
    <div className={`p-2 rounded-lg bg-black/10 ${colorClass}`}>
      <Icon className="w-4 h-4" />
    </div>
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-bold">{label}</p>
      <p className="text-lg font-bold truncate leading-tight">{value}</p>
    </div>
  </div>
);

// Sub-component: Loading Overlay
const LoadingOverlay = ({ action }: { action: string | null }) => (
  <div className="flex flex-col items-center justify-center py-8 space-y-4 text-center">
    <Loader2 className="w-12 h-12 animate-spin text-[var(--color-primary)] opacity-80" />
    <p className="text-[var(--color-text-secondary)] font-medium animate-pulse">
      {action === 'starting' && 'Establishing Connection...'}
      {action === 'stopping' && 'Stopping engine...'}
      {action === 'creating' && 'Allocating resources...'}
      {action === 'recreating' && 'Fresh container deployment...'}
    </p>
  </div>
);

// Sub-component: Recreate Modal Content
const RecreateModalContent = ({
  confirmRecreate,
  onCancel,
  onContinue
}: {
  confirmRecreate: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) => (
  <div className="flex flex-col items-center justify-center py-6 space-y-4">
    <div className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500/20">
      <AlertTriangle className="w-8 h-8 text-red-400" />
    </div>
    <h3 className="text-lg font-semibold text-red-400">Recreate Database?</h3>
    <p className="text-sm text-[var(--color-text-secondary)] text-center max-w-xs">
      This will delete the container and create a new one. Your data will be preserved in the volume.
    </p>
    <div className="flex flex-col gap-3 items-center">
      {confirmRecreate && <p className="text-sm text-red-400 font-medium">Are you absolutely sure?</p>}
      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
        >
          Cancel
        </button>
        <button
          onClick={onContinue}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${confirmRecreate ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-red-500/30 text-red-400 hover:bg-red-500/40'
            }`}
        >
          {confirmRecreate ? 'Yes, Recreate' : 'Continue'}
        </button>
      </div>
    </div>
  </div>
);

export function DatabaseControl({ onReady, inline = false, variant = 'full' }: DatabaseControlProps) {
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(null);
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecreateModal, setShowRecreateModal] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);
  const onReadyCalled = useRef(false);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const { authToken } = usePlayerStore();

  const apiFetch = useCallback(async (endpoint: string, method = 'GET') => {
    const res = await fetch(endpoint, {
      method,
      headers: { Authorization: `Bearer ${authToken}` }
    });

    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      console.error(`[DatabaseControl] Failed to parse JSON from ${endpoint}:`, text);
      if (res.ok) return {}; // Unexpected non-JSON success
    }

    if (!res.ok) {
      throw new Error(data.message || data.error || `API error: ${res.status}`);
    }
    return data;
  }, [authToken]);

  const fetchDbStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/admin/db/status');
      setDbStatus(data);
      setError(null);
      
      if (data.status === 'running' && onReadyRef.current && !onReadyCalled.current) {
        onReadyCalled.current = true;
        onReadyRef.current();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch database status');
    }
  }, [apiFetch]);

  const fetchDbStats = useCallback(async () => {
    if (dbStatus?.status !== 'running') return;
    try {
      const data = await apiFetch('/api/admin/db/stats');
      setDbStats(data);
    } catch (err) {
      console.error('Failed to fetch DB stats', err);
    }
  }, [apiFetch, dbStatus?.status]);

  useEffect(() => {
    fetchDbStatus();
    // Background polling ogni 30 seconds
    const interval = setInterval(fetchDbStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchDbStatus]);

  useEffect(() => {
    if (variant === 'stats' && dbStatus?.status === 'running') {
      fetchDbStats();
      const interval = setInterval(fetchDbStats, 60000); // 1 min for stats
      return () => clearInterval(interval);
    }
  }, [variant, dbStatus?.status, fetchDbStats]);

  const handleAction = async (action: string, endpoint: string) => {
    setActionInProgress(action);
    setError(null);
    try {
      const data = await apiFetch(endpoint, 'POST');
      if (data.status === 'started' || data.status === 'created') {
        await fetchDbStatus();
        setShowRecreateModal(false);
        setConfirmRecreate(false);
      } else {
        setError(data.message || `Failed to ${action} database`);
      }
    } catch (err: any) {
      setError(err.message || `Failed to ${action} database`);
    } finally {
      setActionInProgress(null);
    }
  };

  const status = dbStatus?.status;

  const renderContent = () => {
    if (actionInProgress) return <LoadingOverlay action={actionInProgress} />;

    if (showRecreateModal) return (
      <RecreateModalContent
        confirmRecreate={confirmRecreate}
        onCancel={() => { setShowRecreateModal(false); setConfirmRecreate(false); }}
        onContinue={() => {
          if (!confirmRecreate) setConfirmRecreate(true);
          else handleAction('recreating', '/api/admin/db/recreate');
        }}
      />
    );

    return (
      <div className="space-y-6">
        {error && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/30">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 overflow-hidden">
              <p className="text-sm text-red-400 font-medium">Error</p>
              <p className="text-sm text-[var(--color-text-secondary)] break-words font-mono text-xs">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="ml-auto text-[var(--color-text-muted)] hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Status Display Area */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500 ${status === 'running' ? 'bg-green-500/20 shadow-[0_0_20px_rgba(34,197,94,0.15)]' :
              status === 'stopped' ? 'bg-amber-500/20' :
                'bg-red-500/20'
            }`}>
            {status === 'running' ? (
              <CheckCircle2 className="w-8 h-8 text-green-400 animate-in zoom-in duration-500" />
            ) : status === 'stopped' ? (
              <Power className="w-8 h-8 text-amber-400" />
            ) : (
              <Database className="w-8 h-8 text-red-400" />
            )}
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Database {status === 'running' ? 'Online' : status === 'stopped' ? 'Stopped' : status === 'error' ? 'Error' : 'Not Found'}</h2>
            {dbStatus?.error && status === 'error' && (
              <p className="text-sm text-red-400 mt-1 max-w-xs">{dbStatus.error}</p>
            )}
            {dbStatus?.configuredData && (
              <p className="text-sm text-[var(--color-text-muted)] mt-1 font-medium bg-black/10 px-3 py-0.5 rounded-full inline-block">
                {dbStatus.configuredData.name} • Port {dbStatus.configuredData.port}
              </p>
            )}
          </div>
        </div>

        {/* Stats Grid - New for 'stats' variant */}
        {variant === 'stats' && status === 'running' && dbStats && (
            <div className="space-y-3 mt-4">
                <div className="grid grid-cols-2 gap-3">
                    <StatCard label="Tables" value={dbStats.tables} icon={Database} />
                    <StatCard label="Indexes" value={dbStats.indexes} icon={RotateCcw} colorClass="text-[var(--color-primary)]" />
                </div>
                <div className="grid grid-cols-4 gap-2">
                    <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Tracks</p>
                        <p className="text-sm font-bold text-green-500">{dbStats.tracks}</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Artists</p>
                        <p className="text-sm font-bold text-blue-500">{dbStats.artists}</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Albums</p>
                        <p className="text-sm font-bold text-purple-500">{dbStats.albums}</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Genres</p>
                        <p className="text-sm font-bold text-amber-500">{dbStats.genres}</p>
                    </div>
                </div>
                {dbStats.pool && (
                    <div className="grid grid-cols-3 gap-2">
                        <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                            <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Pool Total</p>
                            <p className="text-sm font-bold text-[var(--color-primary)]">{dbStats.pool.total}</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                            <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Idle</p>
                            <p className="text-sm font-bold text-green-500">{dbStats.pool.idle}</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                            <p className="text-[9px] uppercase text-[var(--color-text-muted)]">Waiting</p>
                            <p className={`text-sm font-bold ${dbStats.pool.waiting > 0 ? 'text-red-500' : 'text-green-500'}`}>{dbStats.pool.waiting}</p>
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* Action Buttons - Hidden if variant === 'stats' */}
        {variant === 'full' && (
            <div className="flex flex-col gap-3">
            {(status === 'not_found' || status === 'error') && (
                <button
                onClick={() => handleAction('creating', '/api/admin/db/create')}
                className="w-full py-3 px-4 rounded-xl font-medium bg-green-600 hover:bg-green-700 text-white flex items-center justify-center gap-2 transition-colors shadow-lg shadow-green-900/20"
                >
                <Database className="w-5 h-5" />
                Create Database
                </button>
            )}

            {status === 'stopped' && (
                <button
                onClick={() => handleAction('starting', '/api/admin/db/start')}
                className="w-full py-3 px-4 rounded-xl font-medium bg-green-600 hover:bg-green-700 text-white flex items-center justify-center gap-2 transition-colors shadow-lg shadow-green-900/20"
                >
                <Power className="w-5 h-5" />
                Start Database
                </button>
            )}

            {status === 'running' && (
                <button
                onClick={() => handleAction('stopping', '/api/admin/db/stop')}
                className="w-full py-3 px-4 rounded-xl font-medium bg-amber-600 hover:bg-amber-700 text-white flex items-center justify-center gap-2 transition-colors"
                >
                <PowerOff className="w-5 h-5" />
                Stop Database
                </button>
            )}

            {(status === 'stopped' || status === 'running') && (
                <button
                onClick={() => setShowRecreateModal(true)}
                className="w-full py-3 px-4 rounded-xl font-medium bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] flex items-center justify-center gap-2 transition-colors border border-[var(--color-border)]"
                >
                <RotateCcw className="w-5 h-5" />
                Recreate Database
                </button>
            )}

            <button
                onClick={fetchDbStatus}
                className="w-full py-2 px-4 rounded-xl text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] flex items-center justify-center gap-2 transition-all hover:bg-[var(--color-bg-tertiary)]"
            >
                <RotateCcw className="w-4 h-4" />
                Refresh Status
            </button>
            </div>
        )}

        {/* Technical Details */}
        {dbStatus?.configuredData && (
          <div className="text-xs text-[var(--color-text-muted)] space-y-2 pt-4 border-t border-[var(--color-border)]">
            <div className="flex justify-between items-center px-1">
              <span>Image:</span>
              <code className="bg-[var(--color-bg-tertiary)] px-2 py-0.5 rounded text-[var(--color-text-secondary)] border border-white/5">{dbStatus.configuredData.image}</code>
            </div>
            <div className="flex justify-between items-center px-1">
              <span>Data Volume:</span>
              <code className="bg-[var(--color-bg-tertiary)] px-2 py-0.5 rounded text-[var(--color-text-secondary)] truncate max-w-[150px] border border-white/5" title={dbStatus.configuredData.dataDir}>
                {dbStatus.configuredData.dataDir}
              </code>
            </div>
            {dbStatus.created && (
              <div className="flex justify-between items-center px-1">
                <span>Created:</span>
                <span className="text-[var(--color-text-secondary)] font-medium">{new Date(dbStatus.created).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (inline) {
    return (
      <div className="bg-[var(--color-background)] rounded-2xl p-6 border border-[var(--glass-border)] shadow-xl relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-primary)]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
        <div className="relative z-10">
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-md px-4 animate-in fade-in duration-300">
      <div className="max-w-md w-full p-8 rounded-[2rem] border border-[var(--glass-border)] bg-[var(--color-bg-secondary)] shadow-2xl overflow-hidden relative group">
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-primary)]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center justify-center mb-6">
            <div className="p-4 rounded-2xl bg-[var(--color-primary)]/10 text-[var(--color-primary)] shadow-inner ring-1 ring-[var(--color-primary)]/20">
              <Database className="w-10 h-10" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center mb-1">Database Control</h1>
          <p className="text-sm text-[var(--color-text-secondary)] text-center mb-8">
            Manage your PostgreSQL container instance
          </p>
          {renderContent()}
        </div>
      </div>
    </div>
  );
}