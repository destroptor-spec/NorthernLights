import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Radio } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';

export const ScrobblingTab: React.FC = () => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const lastFmApiKey = usePlayerStore(state => state.lastFmApiKey);
    const lastFmSharedSecret = usePlayerStore(state => state.lastFmSharedSecret);
    const lastFmConnected = usePlayerStore(state => state.lastFmConnected);
    const lastFmUsername = usePlayerStore(state => state.lastFmUsername);
    const lastFmScrobbleEnabled = usePlayerStore(state => state.lastFmScrobbleEnabled);
    const setLastFmConnected = usePlayerStore(state => state.setLastFmConnected);
    const setLastFmUsername = usePlayerStore(state => state.setLastFmUsername);
    const setLastFmScrobbleEnabled = usePlayerStore(state => state.setLastFmScrobbleEnabled);
    const listenBrainzConnected = usePlayerStore(state => state.listenBrainzConnected);
    const listenBrainzUsername = usePlayerStore(state => state.listenBrainzUsername);
    const listenBrainzScrobbleEnabled = usePlayerStore(state => state.listenBrainzScrobbleEnabled);
    const setListenBrainzConnected = usePlayerStore(state => state.setListenBrainzConnected);
    const setListenBrainzUsername = usePlayerStore(state => state.setListenBrainzUsername);
    const setListenBrainzScrobbleEnabled = usePlayerStore(state => state.setListenBrainzScrobbleEnabled);
    const subsonicProviderScrobbleEnabled = usePlayerStore(state => state.subsonicProviderScrobbleEnabled);
    const subsonicProviderLoveSyncEnabled = usePlayerStore(state => state.subsonicProviderLoveSyncEnabled);
    const setSubsonicProviderLoveSyncEnabled = usePlayerStore(state => state.setSubsonicProviderLoveSyncEnabled);
    const setSubsonicProviderScrobbleEnabled = usePlayerStore(state => state.setSubsonicProviderScrobbleEnabled);

    const { addToast } = useToast();

    const [lbTokenInput, setLbTokenInput] = useState('');
    const [lbConnecting, setLbConnecting] = useState(false);
    const [lastFmConnecting, setLastFmConnecting] = useState(false);
    const isMountedRef = useRef(true);
    const lastFmPollRunRef = useRef(0);

    const showToast = (msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type);

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            lastFmPollRunRef.current += 1;
        };
    }, []);

    const pollLastFmCompletion = async () => {
        const runId = lastFmPollRunRef.current + 1;
        lastFmPollRunRef.current = runId;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            await new Promise(resolve => window.setTimeout(resolve, 2_000));
            if (!isMountedRef.current || lastFmPollRunRef.current !== runId) return;
            try {
                const res = await fetch('/api/providers/lastfm/complete', {
                    method: 'POST',
                    headers: getAuthHeader(),
                });
                const data = await res.json().catch(() => ({}));
                if (!isMountedRef.current || lastFmPollRunRef.current !== runId) return;
                if (res.ok && data.status === 'ok') {
                    setLastFmConnected(true);
                    setLastFmUsername(data.username || '');
                    showToast('Last.fm connected successfully', 'success');
                    return;
                }
                if (res.status !== 202) {
                    showToast(data.error || 'Failed to complete Last.fm authorization', 'error');
                    return;
                }
            } catch (e: any) {
                if (!isMountedRef.current || lastFmPollRunRef.current !== runId) return;
                showToast(e?.message || 'Network error', 'error');
                return;
            }
        }
        if (!isMountedRef.current || lastFmPollRunRef.current !== runId) return;
        showToast('Last.fm authorization timed out', 'error');
    };

    const handleLastFmConnect = async () => {
        if (!lastFmApiKey.trim() || !lastFmSharedSecret.trim()) {
            showToast('Configure the Last.fm API Key and Shared Secret first', 'error');
            return;
        }

        const authWindow = window.open('about:blank', 'lastfm-auth', 'popup=yes,width=760,height=820');
        setLastFmConnecting(true);
        try {
            const saveRes = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({
                    lastFmApiKey: lastFmApiKey.trim(),
                    lastFmSharedSecret: lastFmSharedSecret.trim(),
                }),
            });
            if (!saveRes.ok) {
                const saveErr = await saveRes.json().catch(() => ({}));
                authWindow?.close();
                showToast(saveErr.error || 'Failed to save Last.fm credentials', 'error');
                return;
            }

            const res = await fetch(`/api/providers/lastfm/authorize?origin=${encodeURIComponent(window.location.origin)}`, { headers: getAuthHeader() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.url) {
                authWindow?.close();
                showToast(data.error || 'Failed to start authorization', 'error');
                return;
            }
            if (authWindow && !authWindow.closed) {
                authWindow.location.href = data.url;
            } else {
                window.open(data.url, '_blank', 'noopener,noreferrer');
            }
            showToast('Approve Aurora in the Last.fm window to finish connecting', 'info');
            await pollLastFmCompletion();
        } catch (e: any) {
            authWindow?.close();
            if (!isMountedRef.current) return;
            showToast(e?.message || 'Network error', 'error');
        } finally {
            if (isMountedRef.current) {
                setLastFmConnecting(false);
            }
        }
    };

    const handleLastFmDisconnect = async () => {
        try {
            const res = await fetch('/api/providers/lastfm/disconnect', { method: 'POST', headers: getAuthHeader() });
            const data = await res.json();
            if (!res.ok || data.error) {
                showToast(data.error || 'Failed to disconnect', 'error');
            } else {
                setLastFmConnected(false);
                setLastFmUsername('');
                showToast('Last.fm account disconnected', 'success');
            }
        } catch (e: any) {
            showToast(e?.message || 'Network error', 'error');
        }
    };

    const handleListenBrainzConnect = async () => {
        setLbConnecting(true);
        try {
            const res = await fetch('/api/providers/listenbrainz/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ token: lbTokenInput.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                showToast(data.error || 'Failed to connect', 'error');
            } else {
                setListenBrainzConnected(true);
                setListenBrainzUsername(data.username || '');
                setListenBrainzScrobbleEnabled(true);
                setLbTokenInput('');
                showToast('ListenBrainz connected successfully', 'success');
            }
        } catch (e: any) {
            showToast(e?.message || 'Network error', 'error');
        } finally {
            setLbConnecting(false);
        }
    };

    const handleListenBrainzDisconnect = async () => {
        try {
            const res = await fetch('/api/providers/listenbrainz/disconnect', { method: 'POST', headers: getAuthHeader() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                showToast(data.error || 'Failed to disconnect', 'error');
            } else {
                setListenBrainzConnected(false);
                setListenBrainzUsername('');
                showToast('ListenBrainz account disconnected', 'success');
            }
        } catch (e: any) {
            showToast(e?.message || 'Network error', 'error');
        }
    };

    return (
        <div className="settings-section account-settings">
            <header className="account-settings__header">
                <div>
                    <p className="account-settings__eyebrow">Scrobbling</p>
                    <h3>Listening Services</h3>
                </div>
            </header>

            <section className="account-panel account-panel--connections">
                <div className="account-panel__header">
                    <div className="account-panel__title">
                        <Radio size={17} aria-hidden="true" />
                        <h4>Scrobble Accounts</h4>
                    </div>
                    <p>Connect scrobbling accounts to submit the tracks you play from Aurora.</p>
                </div>

                <div className="account-provider-list">
                    <div className="account-provider">
                        <div className="account-provider__main">
                            <div className="account-provider__copy">
                                <div className="account-provider__title-row">
                                    <h5>OpenSubsonic Clients</h5>
                                    <span className="account-status">{subsonicProviderScrobbleEnabled ? 'Bridge on' : 'Bridge off'}</span>
                                </div>
                                <p>Forward Subsonic playback reports to connected services only when the client does not scrobble on its own.</p>
                            </div>
                        </div>

                        <div className="account-provider__setting">
                            <span>Bridge Subsonic scrobbles</span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={subsonicProviderScrobbleEnabled}
                                aria-label="Bridge Subsonic scrobbles"
                                onClick={() => setSubsonicProviderScrobbleEnabled(!subsonicProviderScrobbleEnabled)}
                                className="account-switch"
                                data-state={subsonicProviderScrobbleEnabled ? 'on' : 'off'}
                            >
                                <span className="account-switch__thumb" />
                            </button>
                        </div>

                        <div className="account-provider__setting">
                            <span>Sync loved/liked songs across all platforms</span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={subsonicProviderLoveSyncEnabled}
                                aria-label="Sync loved/liked songs across all platforms"
                                onClick={() => setSubsonicProviderLoveSyncEnabled(!subsonicProviderLoveSyncEnabled)}
                                className="account-switch"
                                data-state={subsonicProviderLoveSyncEnabled ? 'on' : 'off'}
                            >
                                <span className="account-switch__thumb" />
                            </button>
                        </div>
                    </div>

                    <div className="account-provider">
                        <div className="account-provider__main">
                            <div className="account-provider__copy">
                                <div className="account-provider__title-row">
                                    <h5>Last.fm</h5>
                                    {lastFmConnected ? (
                                        <span className="account-status account-status--connected">
                                            <CheckCircle2 size={14} aria-hidden="true" />
                                            {lastFmUsername || 'Connected'}
                                        </span>
                                    ) : (
                                        <span className="account-status">Not connected</span>
                                    )}
                                </div>
                                <p>Scrobble played tracks from Aurora to your personal Last.fm account.</p>
                            </div>

                            {lastFmConnected ? (
                                <button type="button" onClick={handleLastFmDisconnect} className="btn btn-ghost btn-sm">Disconnect</button>
                            ) : (
                                <button
                                    type="button"
                                    disabled={lastFmConnecting}
                                    onClick={handleLastFmConnect}
                                    className="btn btn-primary btn-sm"
                                >
                                    {lastFmConnecting ? 'Connecting...' : 'Connect'}
                                </button>
                            )}
                        </div>

                        {lastFmConnected && (
                            <div className="account-provider__setting">
                                <span>Auto-scrobble played tracks</span>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={lastFmScrobbleEnabled}
                                    onClick={() => setLastFmScrobbleEnabled(!lastFmScrobbleEnabled)}
                                    className="account-switch"
                                    data-state={lastFmScrobbleEnabled ? 'on' : 'off'}
                                >
                                    <span className="account-switch__thumb" />
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="account-provider">
                        <div className="account-provider__main">
                            <div className="account-provider__copy">
                                <div className="account-provider__title-row">
                                    <h5>ListenBrainz</h5>
                                    {listenBrainzConnected ? (
                                        <span className="account-status account-status--connected">
                                            <CheckCircle2 size={14} aria-hidden="true" />
                                            {listenBrainzUsername || 'Connected'}
                                        </span>
                                    ) : (
                                        <span className="account-status">Not connected</span>
                                    )}
                                </div>
                                <p>
                                    Submit listens as you play. User tokens live at{' '}
                                    <a href="https://listenbrainz.org/profile/" target="_blank" rel="noreferrer">listenbrainz.org/profile</a>.
                                </p>
                            </div>

                            {listenBrainzConnected && (
                                <button type="button" onClick={handleListenBrainzDisconnect} className="btn btn-ghost btn-sm">Disconnect</button>
                            )}
                        </div>

                        {listenBrainzConnected ? (
                            <div className="account-provider__setting">
                                <span>Auto-submit played tracks</span>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={listenBrainzScrobbleEnabled}
                                    onClick={() => setListenBrainzScrobbleEnabled(!listenBrainzScrobbleEnabled)}
                                    className="account-switch"
                                    data-state={listenBrainzScrobbleEnabled ? 'on' : 'off'}
                                >
                                    <span className="account-switch__thumb" />
                                </button>
                            </div>
                        ) : (
                            <div className="account-token-row">
                                <label className="account-field account-field--token" htmlFor="listenbrainz-token">
                                    <span>User token</span>
                                    <input
                                        id="listenbrainz-token"
                                        type="password"
                                        value={lbTokenInput}
                                        onChange={e => setLbTokenInput(e.target.value)}
                                        placeholder="Paste token"
                                        autoComplete="off"
                                    />
                                </label>
                                <button
                                    type="button"
                                    disabled={!lbTokenInput.trim() || lbConnecting}
                                    onClick={handleListenBrainzConnect}
                                    className="btn btn-primary btn-sm account-token-row__action disabled:opacity-50"
                                >
                                    {lbConnecting ? 'Connecting...' : 'Connect'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
};
