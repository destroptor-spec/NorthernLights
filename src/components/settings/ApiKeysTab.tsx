import React, { useEffect, useRef, useState } from 'react';
import { Ban, Copy, KeyRound, Laptop, Plus, RotateCw, Trash2 } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { auroraApiRequest, type AuroraClient } from '../../api/auroraApi';
import { ConfirmModal } from '../ConfirmModal';
import { PromptModal } from '../PromptModal';

interface ApiKeyRecord {
    id: string;
    name: string;
    prefix: string;
    platform?: string | null;
    createdAt: string | number | null;
    lastUsedAt: string | number | null;
    revokedAt: string | number | null;
}

type AccessKind = 'aurora' | 'subsonic';

const asAppKey = (client: AuroraClient): ApiKeyRecord => ({
    id: client.id,
    name: client.name,
    prefix: client.prefix,
    platform: client.platform,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
});

export const ApiKeysTab: React.FC = () => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const openSubsonicEnabled = usePlayerStore(state => state.openSubsonicEnabled);
    const { addToast } = useToast();

    const [accessKind, setAccessKind] = useState<AccessKind>('aurora');
    const [auroraKeys, setAuroraKeys] = useState<ApiKeyRecord[]>([]);
    const [subsonicKeys, setSubsonicKeys] = useState<ApiKeyRecord[]>([]);
    const [isLoadingKeys, setIsLoadingKeys] = useState(true);
    const [isCreatingKey, setIsCreatingKey] = useState(false);
    const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
    const [revealedKey, setRevealedKey] = useState<{ label: string; value: string } | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; confirmLabel?: string; onSubmit: (value: string) => void } | null>(null);
    const isMountedRef = useRef(true);

    const showToast = (msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type);
    const keys = accessKind === 'aurora' ? auroraKeys : subsonicKeys;
    const isAccessEnabled = accessKind === 'aurora' || openSubsonicEnabled;

    useEffect(() => () => { isMountedRef.current = false; }, []);

    const fetchKeys = async () => {
        try {
            const authHeaders = getAuthHeader();
            const [apps, subsonicResponse] = await Promise.all([
                auroraApiRequest<AuroraClient[]>('/app-keys', authHeaders),
                fetch('/api/auth/subsonic-api-keys', { headers: authHeaders }),
            ]);
            const subsonicData = await subsonicResponse.json().catch(() => ({}));
            if (!subsonicResponse.ok) throw new Error(subsonicData.error || 'Failed to load OpenSubsonic keys');
            if (isMountedRef.current) {
                setAuroraKeys(apps.map(asAppKey));
                setSubsonicKeys(Array.isArray(subsonicData.keys) ? subsonicData.keys : []);
            }
        } catch (error) {
            showToast(error instanceof Error ? error.message : 'Failed to load app access', 'error');
        } finally {
            if (isMountedRef.current) setIsLoadingKeys(false);
        }
    };

    useEffect(() => { void fetchKeys(); }, []);

    const createKey = () => {
        if (!isAccessEnabled) return;
        const isAurora = accessKind === 'aurora';
        setPromptDialog({
            title: isAurora ? 'Connect an Aurora App' : 'Create OpenSubsonic Key',
            label: isAurora ? 'Name the desktop app or device.' : 'Name this Subsonic client key.',
            placeholder: isAurora ? 'Aurora Desktop on Framework' : 'Symfonium on Pixel',
            confirmLabel: 'Create Key',
            onSubmit: async (name) => {
                setPromptDialog(null);
                setIsCreatingKey(true);
                try {
                    let key: string;
                    if (isAurora) {
                        const created = await auroraApiRequest<{ key: string }>('/app-keys', getAuthHeader(), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, platform: 'desktop' }),
                        });
                        key = created.key;
                    } else {
                        const response = await fetch('/api/auth/subsonic-api-keys', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeader() }, body: JSON.stringify({ name }),
                        });
                        const created = await response.json().catch(() => ({}));
                        if (!response.ok || !created.key) throw new Error(created.error || 'Failed to create API key');
                        key = created.key;
                    }
                    setRevealedKey({ label: isAurora ? 'Aurora app key — shown once' : 'OpenSubsonic key — shown once', value: key });
                    await fetchKeys();
                    showToast('API key created', 'success');
                } catch (error) {
                    showToast(error instanceof Error ? error.message : 'Network error', 'error');
                } finally {
                    setIsCreatingKey(false);
                }
            },
        });
    };

    const rotateKey = (key: ApiKeyRecord) => {
        if (!isAccessEnabled || key.revokedAt) return;
        const isAurora = accessKind === 'aurora';
        setConfirmDialog({
            title: 'Rotate API Key',
            message: `Rotate "${key.name}"? The current secret stops working immediately and the replacement is shown once.`,
            confirmLabel: 'Rotate Key',
            onConfirm: async () => {
                setConfirmDialog(null);
                setPendingKeyId(key.id);
                try {
                    let rotated: { key: string };
                    if (isAurora) {
                        rotated = await auroraApiRequest<{ key: string }>(`/app-keys/${encodeURIComponent(key.id)}/rotate`, getAuthHeader(), { method: 'POST' });
                    } else {
                        const response = await fetch(`/api/auth/subsonic-api-keys/${encodeURIComponent(key.id)}/rotate`, { method: 'POST', headers: getAuthHeader() });
                        const payload = await response.json().catch(() => ({}));
                        if (!response.ok || !payload.key) throw new Error(payload.error || 'Failed to rotate API key');
                        rotated = payload;
                    }
                    setRevealedKey({ label: 'Rotated key — shown once', value: rotated.key });
                    await fetchKeys();
                    showToast('API key rotated', 'success');
                } catch (error) {
                    showToast(error instanceof Error ? error.message : 'Network error', 'error');
                } finally {
                    setPendingKeyId(null);
                }
            },
        });
    };

    const removeKey = (key: ApiKeyRecord) => {
        const isRevoked = Boolean(key.revokedAt);
        const isAurora = accessKind === 'aurora';
        setConfirmDialog({
            title: isRevoked ? 'Delete API Key' : 'Revoke API Key',
            message: isRevoked ? `Delete the revoked record "${key.name}"?` : `Revoke "${key.name}"? That client will lose access immediately.`,
            confirmLabel: isRevoked ? 'Delete Key' : 'Revoke Key',
            onConfirm: async () => {
                setConfirmDialog(null);
                setPendingKeyId(key.id);
                try {
                    if (isAurora) {
                        await auroraApiRequest(`/app-keys/${encodeURIComponent(key.id)}`, getAuthHeader(), { method: 'DELETE' });
                    } else {
                        const response = await fetch(`/api/auth/subsonic-api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE', headers: getAuthHeader() });
                        const payload = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(payload.error || 'Failed to update API key');
                    }
                    await fetchKeys();
                    showToast(isRevoked ? 'API key deleted' : 'API key revoked', 'success');
                } catch (error) {
                    showToast(error instanceof Error ? error.message : 'Network error', 'error');
                } finally {
                    setPendingKeyId(null);
                }
            },
        });
    };

    const copyRevealedKey = async () => {
        if (!revealedKey) return;
        try {
            await navigator.clipboard.writeText(revealedKey.value);
            showToast('API key copied', 'success');
        } catch {
            showToast('Could not copy API key', 'error');
        }
    };

    return (
        <div className="settings-section account-settings">
            <header className="account-settings__header">
                <div><p className="account-settings__eyebrow">Connected apps</p><h3>App Access</h3></div>
                <span className="account-settings__role">listener only</span>
            </header>

            <div className="account-api-key-tabs" role="tablist" aria-label="API type">
                <button type="button" role="tab" aria-selected={accessKind === 'aurora'} className={`btn btn-tab ${accessKind === 'aurora' ? 'active' : ''}`} onClick={() => { setAccessKind('aurora'); setRevealedKey(null); }}>
                    Aurora Apps
                </button>
                <button type="button" role="tab" aria-selected={accessKind === 'subsonic'} className={`btn btn-tab ${accessKind === 'subsonic' ? 'active' : ''}`} onClick={() => { setAccessKind('subsonic'); setRevealedKey(null); }}>
                    OpenSubsonic
                </button>
            </div>

            <section className="account-panel account-panel--subsonic">
                <div className="account-panel__header">
                    <div className="account-panel__title">{accessKind === 'aurora' ? <Laptop size={17} aria-hidden="true" /> : <KeyRound size={17} aria-hidden="true" />}<h4>{accessKind === 'aurora' ? 'Aurora Listener Apps' : 'OpenSubsonic Clients'}</h4></div>
                    <p>{accessKind === 'aurora'
                        ? 'Connect a dedicated Aurora desktop app with a manual key, or approve the short code it displays. Access is limited to listening, playlists, preferences, and playback sessions.'
                        : openSubsonicEnabled ? 'Create one key per Subsonic client. Aurora app keys do not work at /rest.' : 'OpenSubsonic is disabled by an admin. Existing keys remain stored.'}</p>
                </div>

                {!isAccessEnabled && <div className="account-api-key-disabled" role="status"><Ban size={16} aria-hidden="true" /><span>OpenSubsonic requests are unavailable until an admin enables them.</span></div>}

                {revealedKey && <div className="account-api-key-reveal"><div><span>{revealedKey.label}</span><code>{revealedKey.value}</code></div><button type="button" onClick={copyRevealedKey} className="btn btn-ghost btn-sm"><Copy size={15} aria-hidden="true" />Copy</button></div>}

                <div className="account-provider-list">
                    {isLoadingKeys ? <div className="account-provider account-provider--empty"><div className="account-provider__copy"><h5>Loading keys</h5><p>Checking client access for this account.</p></div></div>
                        : keys.length === 0 ? <div className="account-provider account-provider--empty"><div className="account-provider__copy"><h5>No connected clients</h5><p>{accessKind === 'aurora' ? 'Create a manual key, or approve a pairing code from the desktop app.' : 'Create a key and paste it into your Subsonic client.'}</p></div></div>
                        : keys.map(key => {
                            const isRevoked = Boolean(key.revokedAt);
                            const isPending = pendingKeyId === key.id;
                            return <div key={key.id} className={`account-provider ${isRevoked ? 'account-provider--revoked' : ''}`}><div className="account-provider__main"><div className="account-provider__copy"><div className="account-provider__title-row"><h5>{key.name}</h5><span className={isRevoked ? 'account-status' : 'account-status account-status--connected'}>{isRevoked ? 'Revoked' : key.prefix}</span></div><p>Created {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : 'recently'}{key.platform ? ` · ${key.platform}` : ''}{key.lastUsedAt ? ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ' · Never used'}</p></div><div className="account-api-key-actions">{!isRevoked && <button type="button" onClick={() => rotateKey(key)} disabled={!isAccessEnabled || isPending} className="btn btn-ghost btn-sm disabled:opacity-50"><RotateCw size={15} aria-hidden="true" />{isPending ? 'Rotating...' : 'Rotate'}</button>}<button type="button" onClick={() => removeKey(key)} disabled={isPending} className={`btn ${isRevoked ? 'btn-danger-fill' : 'btn-danger'} btn-sm disabled:opacity-50`}><Trash2 size={15} aria-hidden="true" />{isPending ? 'Updating...' : isRevoked ? 'Delete' : 'Revoke'}</button></div></div></div>;
                        })}
                </div>

                <button type="button" onClick={createKey} disabled={!isAccessEnabled || isCreatingKey} className="btn btn-primary btn-sm account-api-key-create disabled:opacity-50"><Plus size={15} aria-hidden="true" />{isCreatingKey ? 'Creating...' : accessKind === 'aurora' ? 'Create Manual Key' : 'Create API Key'}</button>
            </section>

            {confirmDialog && <ConfirmModal title={confirmDialog.title} message={confirmDialog.message} confirmLabel={confirmDialog.confirmLabel} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
            {promptDialog && <PromptModal title={promptDialog.title} label={promptDialog.label} placeholder={promptDialog.placeholder} confirmLabel={promptDialog.confirmLabel} onSubmit={promptDialog.onSubmit} onCancel={() => setPromptDialog(null)} />}
        </div>
    );
};
