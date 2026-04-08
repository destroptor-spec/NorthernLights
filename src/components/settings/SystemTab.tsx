import React, { useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { ConfirmModal } from '../ConfirmModal';

export const SystemTab: React.FC = () => {
    const audioAnalysisCpu = usePlayerStore(state => state.audioAnalysisCpu);
    const scannerConcurrency = usePlayerStore(state => state.scannerConcurrency);
    const hubGenerationSchedule = usePlayerStore(state => state.hubGenerationSchedule);
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    
    const { addToast } = useToast();
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);

    const handleManualHubRegen = async () => {
        setConfirmDialog({
            title: 'Reset Hub',
            message: 'This will delete ALL existing LLM-generated playlists and regenerate fresh ones. User-created playlists will not be affected.',
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

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">System & Processing</h3>
            </div>
            <div className="mb-6">
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

            <div className="mb-6">
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

            <div className="mb-6">
                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Hub Generation Schedule</label>
                <select 
                    value={hubGenerationSchedule} 
                    onChange={e => setSettings({ hubGenerationSchedule: e.target.value })}
                    className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                >
                    <option value="Manual Only">Manual Only</option>
                    <option value="Daily">Daily</option>
                    <option value="Weekly">Weekly</option>
                </select>
                <div className="mt-4">
                    <p className="text-xs text-[var(--color-text-muted)] mb-2 max-w-sm leading-relaxed">
                        Manually trigger the AI to generate fresh playlists based on the time of day and your listening history. 
                        <span className="text-[var(--color-error)] block mt-1 font-medium">Warning: Resetting will delete all current LLM-generated playlists from your hub.</span>
                    </p>
                    <button 
                        onClick={handleManualHubRegen}
                        className="btn btn-danger"
                    >
                        <span className="text-lg leading-none">↺</span> Reset Hub
                    </button>
                </div>
            </div>

            {/* Aurora App Auto-Start Configuration */}
            <div className="mt-8 pt-6 border-t border-[var(--glass-border)]">
                <div className="flex items-center gap-2 mb-3">
                    <h4 className="text-lg font-semibold text-[var(--color-text-primary)]">Aurora Auto-Start</h4>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">systemd</span>
                </div>
                <p className="text-sm text-[var(--color-text-muted)] mb-4 leading-relaxed">
                    Configure Aurora to automatically start when your computer starts. This requires a user-level systemd service.
                </p>
                
                <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-sm font-medium text-[var(--color-text-primary)]">Service Status:</span>
                        <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">Not Configured</span>
                    </div>
                        <p className="mb-4 text-amber-200/80 italic">
                            Note: You must run <b>npm run build</b> once before starting the service.
                        </p>
                        <div className="bg-black/40 rounded-lg p-3 font-mono text-xs text-green-400 overflow-x-auto">
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
            </div>

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
