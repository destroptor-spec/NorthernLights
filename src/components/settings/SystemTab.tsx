import React, { useEffect, useState, useCallback } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { ConfirmModal } from '../ConfirmModal';

type SystemSubTab = 'processing' | 'hub' | 'service' | 'logging' | 'security';

const systemPlaylistOptions = [
    {
        key: 'upNext',
        title: 'Up Next',
        description: 'Near-neighbor playlist based on recent listening.',
    },
    {
        key: 'vault',
        title: 'The Vault',
        description: 'Unplayed tracks that match the user taste profile.',
    },
    {
        key: 'jumpBackIn',
        title: 'Jump Back In Mix',
        description: 'Discover-rail mix of older favourites that have been waiting.',
    },
    {
        key: 'genreHeavyRotation',
        title: 'Genre Heavy Rotation',
        description: 'Most-played mixes for strong library genres.',
    },
    {
        key: 'genreRediscovery',
        title: 'Genre Rediscovery',
        description: 'Forgotten genre tracks worth replaying.',
    },
    {
        key: 'decadeMixes',
        title: 'Decade Mixes',
        description: "Broad decade playlists like 90's Mix.",
    },
    {
        key: 'decadeGenreMixes',
        title: 'Decade Genre Mixes',
        description: "Focused mixes like 90's Pop when the library supports it.",
    },
] as const;

// Personalized history-driven rails (smart hub bundle), shown to the user as
// "Jump back in" and "Uniquely yours". Gated server-side in smartHub.service.
const smartSectionOptions = [
    {
        key: 'smartJumpBackIn',
        title: 'Jump Back In',
        description: 'The "jump back in" rail of recently played albums, artists, and playlists.',
    },
    {
        key: 'uniquelyYours',
        title: 'Uniquely Yours',
        description: 'The "uniquely yours" rail: On Repeat, Repeat Rewind, Daylist, and Artist Radio.',
    },
    {
        key: 'wrapped',
        title: 'Wrapped',
        description: 'Frozen year and season recaps of your top tracks, surfaced on the Hub and archived in the Playlists "Wrapped" rail.',
    },
] as const;

const defaultSystemPlaylistConfig = Object.fromEntries(
    [...systemPlaylistOptions, ...smartSectionOptions].map(option => [option.key, true])
) as Record<typeof systemPlaylistOptions[number]['key'] | typeof smartSectionOptions[number]['key'], boolean>;

export const SystemTab: React.FC = () => {
    const audioAnalysisCpu = usePlayerStore(state => state.audioAnalysisCpu);
    const scannerConcurrency = usePlayerStore(state => state.scannerConcurrency);
    const loudnessComputeMode = usePlayerStore(state => state.loudnessComputeMode);
    const hubGenerationSchedule = usePlayerStore(state => state.hubGenerationSchedule);
    const systemPlaylistConfig = usePlayerStore(state => state.systemPlaylistConfig);
    const hlsLoggingEnabled = usePlayerStore(state => state.hlsLoggingEnabled);
    const ffmpegLoggingEnabled = usePlayerStore(state => state.ffmpegLoggingEnabled);
    const openSubsonicEnabled = usePlayerStore(state => state.openSubsonicEnabled);
    const turnstileEnabled = usePlayerStore(state => state.turnstileEnabled);
    const turnstileSiteKey = usePlayerStore(state => state.turnstileSiteKey);
    const turnstileSecretKey = usePlayerStore(state => state.turnstileSecretKey);
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);

    const { addToast } = useToast();
    const [activeSubTab, setActiveSubTab] = useState<SystemSubTab>('processing');
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [subsonicToggleSaving, setSubsonicToggleSaving] = useState(false);
    const [turnstileToggleSaving, setTurnstileToggleSaving] = useState(false);

    type ServiceStatus = {
        runtime: 'pm2' | 'systemd' | 'manual';
        pid: number;
        uptimeSeconds: number;
        pm2: { active: boolean; configured: boolean; processName: string | null; pmId: string | null; instance: string | null };
        systemd: { active: boolean; configured: boolean; unitPath: string | null; invocationId: string | null };
    };
    const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
    const [serviceStatusLoading, setServiceStatusLoading] = useState(false);

    const fetchServiceStatus = useCallback(async () => {
        setServiceStatusLoading(true);
        try {
            const res = await fetch('/api/admin/service/status', { headers: getAuthHeader() });
            if (res.ok) setServiceStatus(await res.json());
            else setServiceStatus(null);
        } catch {
            setServiceStatus(null);
        } finally {
            setServiceStatusLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        if (activeSubTab === 'service') fetchServiceStatus();
    }, [activeSubTab, fetchServiceStatus]);

    const effectiveSystemPlaylistConfig = {
        ...defaultSystemPlaylistConfig,
        ...systemPlaylistConfig,
    };

    const setSystemPlaylistEnabled = (key: keyof typeof defaultSystemPlaylistConfig, enabled: boolean) => {
        setSettings({
            systemPlaylistConfig: {
                ...effectiveSystemPlaylistConfig,
                [key]: enabled,
            },
        });
    };

    const handleManualHubRegen = async () => {
        setConfirmDialog({
            title: 'Reset Hub',
            message: 'This will delete transient Hub-generated playlists and refresh the Hub mix set. User-created playlists will not be affected.',
            confirmLabel: 'Reset Hub',
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    const authHeaders = getAuthHeader();
                    await fetch('/api/hub/regenerate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({ force: true })
                    });
                    addToast('Hub reset triggered. Playlists are being regenerated in the background.', 'success');
                } catch(e) {
                    console.error(e);
                    addToast('Failed to request reset', 'error');
                }
            },
        });
    };

    const updateOpenSubsonicEnabled = async (enabled: boolean) => {
        const previous = openSubsonicEnabled;
        setSettings({ openSubsonicEnabled: enabled });
        setSubsonicToggleSaving(true);
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ openSubsonicEnabled: enabled }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || 'Failed to update OpenSubsonic setting');
            }
            addToast(enabled ? 'OpenSubsonic enabled' : 'OpenSubsonic disabled', 'success');
        } catch (e: any) {
            setSettings({ openSubsonicEnabled: previous });
            addToast(e?.message || 'Failed to update OpenSubsonic setting', 'error');
        } finally {
            setSubsonicToggleSaving(false);
        }
    };

    const updateTurnstileEnabled = async (enabled: boolean) => {
        const previous = turnstileEnabled;
        setSettings({ turnstileEnabled: enabled });
        setTurnstileToggleSaving(true);
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                // Keys ride along so enabling works even before the modal-close
                // save has persisted freshly typed values.
                body: JSON.stringify({
                    turnstileEnabled: enabled,
                    turnstileSiteKey: turnstileSiteKey.trim(),
                    turnstileSecretKey: turnstileSecretKey.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || 'Failed to update captcha setting');
            }
            addToast(enabled ? 'Sign-in captcha enabled' : 'Sign-in captcha disabled', 'success');
        } catch (e: any) {
            setSettings({ turnstileEnabled: previous });
            addToast(e?.message || 'Failed to update captcha setting', 'error');
        } finally {
            setTurnstileToggleSaving(false);
        }
    };

    const turnstileKeysPresent = turnstileSiteKey.trim().length > 0 && turnstileSecretKey.trim().length > 0;

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">System & Processing</h3>
            </div>

            <div className="mb-6 flex flex-wrap gap-2">
                <button
                    type="button"
                    className={`btn-tab ${activeSubTab === 'processing' ? 'active' : ''}`}
                    onClick={() => setActiveSubTab('processing')}
                >
                    Processing
                </button>
                <button
                    type="button"
                    className={`btn-tab ${activeSubTab === 'hub' ? 'active' : ''}`}
                    onClick={() => setActiveSubTab('hub')}
                >
                    Hub Playlists
                </button>
                <button
                    type="button"
                    className={`btn-tab ${activeSubTab === 'service' ? 'active' : ''}`}
                    onClick={() => setActiveSubTab('service')}
                >
                    Service
                </button>
                <button
                    type="button"
                    className={`btn-tab ${activeSubTab === 'logging' ? 'active' : ''}`}
                    onClick={() => setActiveSubTab('logging')}
                >
                    Logging
                </button>
                <button
                    type="button"
                    className={`btn-tab ${activeSubTab === 'security' ? 'active' : ''}`}
                    onClick={() => setActiveSubTab('security')}
                >
                    Security
                </button>
            </div>

            {activeSubTab === 'processing' && (
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Audio Analysis CPU Usage</label>
                        <select
                            value={audioAnalysisCpu}
                            onChange={e => setSettings({ audioAnalysisCpu: e.target.value })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="Background">Background (1 process)</option>
                            <option value="Balanced">Balanced (4 processes)</option>
                            <option value="Performance">Performance (8 processes)</option>
                            <option value="Intensive">Intensive (16 processes)</option>
                            <option value="Maximum">Maximum (all CPU cores)</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Scanner Concurrency</label>
                        <select
                            value={scannerConcurrency}
                            onChange={e => setSettings({ scannerConcurrency: e.target.value })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="HDD">HDD (4 processes)</option>
                            <option value="SSD">Standard SSD (16 processes)</option>
                            <option value="NVMe">Premium NVMe (32 processes)</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Controls how many files are scanned simultaneously for metadata. Higher values require faster disk I/O.</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Loudness Computation</label>
                        <select
                            value={loudnessComputeMode}
                            onChange={e => setSettings({ loudnessComputeMode: e.target.value as 'lazy' | 'full' | 'both' })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="lazy">Lazy — measure tracks only as they're played</option>
                            <option value="full">Full — backfill the whole library after each scan</option>
                            <option value="both">Both — backfill after scans and measure on play</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">When and how EBU R128 loudness is computed for volume normalization. After the initial run, "Full" only measures newly added tracks. The "Measure Loudness" button in Library settings always runs regardless of this setting.</p>
                    </div>
                </div>
            )}

            {activeSubTab === 'hub' && (
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Hub Generation Schedule</label>
                        <select
                            value={hubGenerationSchedule}
                            onChange={e => setSettings({ hubGenerationSchedule: e.target.value })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="Manual Only">Manual Only</option>
                            <option value="Hourly">Hourly</option>
                            <option value="Every 2 Hours">Every 2 hours</option>
                            <option value="Every 4 Hours">Every 4 hours</option>
                            <option value="Daily">Daily</option>
                        </select>
                        <div className="mt-4">
                            <p className="text-xs text-[var(--color-text-muted)] mb-2 max-w-sm leading-relaxed">
                                Refreshes are checked when a user logs in or opens the Hub. System playlist toggles apply on the next Hub load after settings are saved.
                                <span className="text-[var(--color-error)] block mt-1 font-medium">Resetting deletes transient Hub-generated playlists and regenerates fresh ones. Prompt-generated playlists are kept.</span>
                            </p>
                            <button
                                onClick={handleManualHubRegen}
                                className="btn btn-danger"
                            >
                                <span className="text-lg leading-none">↺</span> Reset Hub
                            </button>
                        </div>
                    </div>

                    <div className="pt-5 border-t border-[var(--glass-border)]">
                        <div className="mb-3">
                            <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">System Playlists</h4>
                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Choose which engine-backed playlist families can appear on the Hub Discover rail.</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {systemPlaylistOptions.map(option => {
                                const enabled = effectiveSystemPlaylistConfig[option.key];
                                return (
                                    <div
                                        key={option.key}
                                        className="flex items-start justify-between gap-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-[var(--color-text-primary)]">{option.title}</p>
                                            <p className="mt-1 text-xs leading-snug text-[var(--color-text-muted)]">{option.description}</p>
                                        </div>
                                        <button
                                            type="button"
                                            aria-pressed={enabled}
                                            onClick={() => setSystemPlaylistEnabled(option.key, !enabled)}
                                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="pt-5 border-t border-[var(--glass-border)]">
                        <div className="mb-3">
                            <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Personalized Rails</h4>
                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Toggle the history-driven rails at the top of the Hub. These build from each user's own listening, so they stay empty until a user has played enough.</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {smartSectionOptions.map(option => {
                                const enabled = effectiveSystemPlaylistConfig[option.key];
                                return (
                                    <div
                                        key={option.key}
                                        className="flex items-start justify-between gap-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-[var(--color-text-primary)]">{option.title}</p>
                                            <p className="mt-1 text-xs leading-snug text-[var(--color-text-muted)]">{option.description}</p>
                                        </div>
                                        <button
                                            type="button"
                                            aria-pressed={enabled}
                                            onClick={() => setSystemPlaylistEnabled(option.key, !enabled)}
                                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {activeSubTab === 'service' && (
                <div>
                    <div className="mb-6 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">OpenSubsonic API</h4>
                                <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                                    Allow third-party Subsonic clients to use Aurora API keys against the /rest endpoint. Disabling this blocks existing keys without deleting them.
                                </p>
                            </div>
                            <button
                                type="button"
                                aria-pressed={openSubsonicEnabled}
                                aria-label="Toggle OpenSubsonic API"
                                disabled={subsonicToggleSaving}
                                onClick={() => updateOpenSubsonicEnabled(!openSubsonicEnabled)}
                                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${openSubsonicEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${openSubsonicEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>
                        <p className="mt-3 text-xs font-medium text-[var(--color-text-secondary)]">
                            Status: {subsonicToggleSaving ? 'Updating OpenSubsonic access' : openSubsonicEnabled ? 'OpenSubsonic client access enabled' : 'OpenSubsonic client access disabled'}
                        </p>
                    </div>

                    <div className="flex items-center justify-between gap-3 mb-3">
                        <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Aurora Auto-Start</h4>
                        <button
                            type="button"
                            onClick={fetchServiceStatus}
                            disabled={serviceStatusLoading}
                            className="text-xs px-3 py-1.5 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                        >
                            {serviceStatusLoading ? 'Checking…' : '↻ Refresh'}
                        </button>
                    </div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-4 leading-relaxed">
                        Configure Aurora to automatically start when your computer starts. Aurora detects whichever process supervisor is managing the running server.
                    </p>

                    {(() => {
                        const pm2Active = serviceStatus?.pm2.active ?? false;
                        const pm2Configured = serviceStatus?.pm2.configured ?? false;
                        const systemdActive = serviceStatus?.systemd.active ?? false;
                        const systemdConfigured = serviceStatus?.systemd.configured ?? false;
                        const runtime = serviceStatus?.runtime ?? 'manual';

                        const runtimeBadge = runtime === 'pm2'
                            ? { label: 'Running under PM2', cls: 'bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-500/30' }
                            : runtime === 'systemd'
                                ? { label: 'Running under systemd', cls: 'bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-500/30' }
                                : { label: 'Running manually', cls: 'bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/20 dark:border-amber-500/30' };

                        const statusPill = (active: boolean, configured: boolean) => {
                            if (active) return { label: 'Active', cls: 'bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-500/30' };
                            if (configured) return { label: 'Configured', cls: 'bg-sky-500/10 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 border-sky-500/20 dark:border-sky-500/30' };
                            return { label: 'Not Configured', cls: 'bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/20 dark:border-amber-500/30' };
                        };
                        const pm2Pill = statusPill(pm2Active, pm2Configured);
                        const systemdPill = statusPill(systemdActive, systemdConfigured);

                        return (
                            <>
                                <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4 mb-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-medium text-[var(--color-text-primary)]">Current Runtime:</span>
                                        <span className={`text-xs px-2 py-1 rounded border ${runtimeBadge.cls}`}>{runtimeBadge.label}</span>
                                        {serviceStatus && (
                                            <span className="text-xs text-[var(--color-text-muted)]">
                                                pid {serviceStatus.pid} · up {Math.floor(serviceStatus.uptimeSeconds / 60)}m
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className={`bg-[var(--color-surface)] rounded-xl border p-4 mb-4 ${runtime === 'pm2' ? 'border-emerald-500/40' : 'border-[var(--glass-border)]'}`}>
                                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                                        <span className="text-sm font-medium text-[var(--color-text-primary)]">PM2:</span>
                                        <span className={`text-xs px-2 py-1 rounded border ${pm2Pill.cls}`}>{pm2Pill.label}</span>
                                        {pm2Active && serviceStatus?.pm2.processName && (
                                            <span className="text-xs text-[var(--color-text-muted)]">name: {serviceStatus.pm2.processName}{serviceStatus.pm2.pmId !== null ? ` · pm_id ${serviceStatus.pm2.pmId}` : ''}</span>
                                        )}
                                    </div>
                                    <p className="text-xs text-[var(--color-text-muted)] mb-3 leading-relaxed">
                                        Cross-platform Node.js process manager. Works on macOS, Linux, and Windows.
                                    </p>
                                    <div className="bg-gray-950 dark:bg-black/40 rounded-lg p-3 font-mono text-xs text-green-400 overflow-x-auto border border-black/20 dark:border-white/5 shadow-inner">
                                        <p className="mb-1">npm install -g pm2</p>
                                        <p className="mb-1">npm run build</p>
                                        <p className="mb-1">pm2 start "npx tsx server/index.ts" --name aurora</p>
                                        <p className="mb-1">pm2 save</p>
                                        <p className="mb-1">pm2 startup   <span className="text-gray-500"># follow the printed command to enable on boot</span></p>
                                    </div>
                                </div>

                                <div className={`bg-[var(--color-surface)] rounded-xl border p-4 ${runtime === 'systemd' ? 'border-emerald-500/40' : 'border-[var(--glass-border)]'}`}>
                                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                                        <span className="text-sm font-medium text-[var(--color-text-primary)]">systemd (user unit):</span>
                                        <span className={`text-xs px-2 py-1 rounded border ${systemdPill.cls}`}>{systemdPill.label}</span>
                                        {systemdConfigured && serviceStatus?.systemd.unitPath && (
                                            <span className="text-xs text-[var(--color-text-muted)] break-all">{serviceStatus.systemd.unitPath}</span>
                                        )}
                                    </div>
                                    <p className="mb-3 text-xs text-amber-700 dark:text-amber-200/80 italic">
                                        Note: You must run <b>npm run build</b> once before starting the service.
                                    </p>
                                    <div className="bg-gray-950 dark:bg-black/40 rounded-lg p-3 font-mono text-xs text-green-400 overflow-x-auto border border-black/20 dark:border-white/5 shadow-inner">
                                        <p className="mb-1">mkdir -p ~/.config/systemd/user</p>
                                        <p className="mb-1">cat &gt; ~/.config/systemd/user/aurora.service &lt;&lt; 'EOF'</p>
                                        <p className="mb-1">[Unit]</p>
                                        <p className="mb-1">Description=Aurora Music Player</p>
                                        <p className="mb-1">After=default.target</p>
                                        <p className="mb-1"></p>
                                        <p className="mb-1">[Service]</p>
                                        <p className="mb-1">Type=simple</p>
                                        <p className="mb-1">ExecStart=/bin/bash -c 'cd "/var/home/andreas/VS Code/Music App" && npx tsx server/index.ts'</p>
                                        <p className="mb-1">Restart=on-failure</p>
                                        <p className="mb-1">RestartSec=10</p>
                                        <p className="mb-1"></p>
                                        <p className="mb-1">[Install]</p>
                                        <p className="mb-1">WantedBy=default.target</p>
                                        <p className="mb-1">EOF</p>
                                        <p className="mb-1"></p>
                                        <p className="mb-1">systemctl --user daemon-reload</p>
                                        <p className="mb-1">systemctl --user enable aurora.service</p>
                                        <p className="mb-1">systemctl --user start aurora.service</p>
                                    </div>
                                </div>
                            </>
                        );
                    })()}
                </div>
            )}

            {activeSubTab === 'logging' && (
                <div className="space-y-6">
                    <div>
                        <h4 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Server Console Logging</h4>
                        <p className="text-xs text-[var(--color-text-muted)] mb-4 leading-relaxed">
                            Toggle the noisy streaming pipeline logs that appear on the server console. Errors are always logged regardless of these settings. Defaults can also be set via <code className="text-[var(--color-text-primary)]">LOG_HLS</code> and <code className="text-[var(--color-text-primary)]">LOG_FFMPEG</code> in <code className="text-[var(--color-text-primary)]">.env</code>; changes here override the env defaults at runtime.
                        </p>

                        <div className="space-y-3">
                            <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-[var(--color-text-primary)]">HLS pipeline logs</p>
                                    <p className="mt-1 text-xs leading-snug text-[var(--color-text-muted)]">
                                        Verbose <code>[HLS DEBUG]</code> traces — segment requests, session readiness polls, and reaper events.
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    aria-pressed={hlsLoggingEnabled}
                                    aria-label="Toggle HLS pipeline logs"
                                    onClick={() => setSettings({ hlsLoggingEnabled: !hlsLoggingEnabled })}
                                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${hlsLoggingEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${hlsLoggingEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                            </div>

                            <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-[var(--color-text-primary)]">FFmpeg output</p>
                                    <p className="mt-1 text-xs leading-snug text-[var(--color-text-muted)]">
                                        FFmpeg <code>stderr</code> passthrough (the chatty banner/progress output streamed during transcoding and HLS sessions).
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    aria-pressed={ffmpegLoggingEnabled}
                                    aria-label="Toggle FFmpeg output logs"
                                    onClick={() => setSettings({ ffmpegLoggingEnabled: !ffmpegLoggingEnabled })}
                                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${ffmpegLoggingEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${ffmpegLoggingEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                            </div>
                        </div>

                        <p className="text-xs text-[var(--color-text-muted)] mt-4 leading-relaxed">
                            Per-track HLS session logs are still written to <code>logs/hls-sessions/</code> on disk regardless of these toggles.
                        </p>
                    </div>
                </div>
            )}

            {activeSubTab === 'security' && (
                <div className="space-y-6">
                    <div>
                        <h4 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Sign-in Captcha (Cloudflare Turnstile)</h4>
                        <p className="text-xs text-[var(--color-text-muted)] mb-4 leading-relaxed">
                            Adds a Cloudflare Turnstile challenge to the sign-in and invite registration forms, blocking automated
                            credential guessing. Create a Turnstile widget in the Cloudflare dashboard (Turnstile → Add site) with
                            this server's hostname, then paste the key pair below.
                        </p>

                        <div className="space-y-4">
                            <div>
                                <label htmlFor="turnstile-site-key" className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Site Key</label>
                                <input
                                    id="turnstile-site-key"
                                    type="text"
                                    value={turnstileSiteKey}
                                    onChange={e => setSettings({ turnstileSiteKey: e.target.value })}
                                    placeholder="0x4AAAAAAA..."
                                    autoComplete="off"
                                    className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none font-mono text-sm"
                                />
                                <p className="text-xs text-[var(--color-text-muted)] mt-1">Public — rendered into the sign-in page.</p>
                            </div>

                            <div>
                                <label htmlFor="turnstile-secret-key" className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Secret Key</label>
                                <input
                                    id="turnstile-secret-key"
                                    type="password"
                                    value={turnstileSecretKey}
                                    onChange={e => setSettings({ turnstileSecretKey: e.target.value })}
                                    placeholder="0x4AAAAAAA..."
                                    autoComplete="off"
                                    className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none font-mono text-sm"
                                />
                                <p className="text-xs text-[var(--color-text-muted)] mt-1">Server-side only — never sent to visitors.</p>
                            </div>

                            <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-[var(--color-text-primary)]">Require captcha on sign-in</p>
                                    <p className="mt-1 text-xs leading-snug text-[var(--color-text-muted)]">
                                        {turnstileKeysPresent
                                            ? 'Applies to sign-in and invite registration. Existing sessions are unaffected.'
                                            : 'Enter both keys above to enable.'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    aria-pressed={turnstileEnabled}
                                    aria-label="Toggle sign-in captcha"
                                    disabled={turnstileToggleSaving || (!turnstileEnabled && !turnstileKeysPresent)}
                                    onClick={() => updateTurnstileEnabled(!turnstileEnabled)}
                                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${turnstileEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${turnstileEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                            </div>
                        </div>

                        <p className="text-xs text-[var(--color-text-muted)] mt-4 leading-relaxed">
                            If Cloudflare ever becomes unreachable from this server, sign-in fails closed with a clear message.
                            Escape hatch: run <code className="text-[var(--color-text-primary)]">UPDATE system_settings SET value='false' WHERE key='turnstileEnabled';</code> against
                            the database to turn the captcha off.
                        </p>
                    </div>
                </div>
            )}

            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmLabel={confirmDialog.confirmLabel}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}
        </div>
    );
};
