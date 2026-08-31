import React from 'react';
import { ArrowLeft, Laptop, Link2, ShieldCheck } from 'lucide-react';
import { auroraApiRequest } from '../api/auroraApi';
import { usePlayerStore } from '../store';

interface PairingPreview {
  userCode: string;
  clientName: string;
  platform: string | null;
  status: string;
  expiresAt: string;
  expired: boolean;
}

export const PairingApproval: React.FC = () => {
  const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
  const rawCode = new URLSearchParams(window.location.search).get('code') || '';
  const code = rawCode.trim().toUpperCase();
  const [request, setRequest] = React.useState<PairingPreview | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'approving' | 'approved' | 'error'>('loading');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!code) {
      setError('No pairing code was provided. Enter the URL shown by the Aurora desktop app.');
      setState('error');
      return;
    }
    let active = true;
    void auroraApiRequest<PairingPreview>(`/pairing/requests/${encodeURIComponent(code)}`, getAuthHeader())
      .then(preview => {
        if (!active) return;
        setRequest(preview);
        if (preview.expired || preview.status !== 'pending') {
          setError(preview.expired ? 'This pairing code has expired.' : 'This pairing code is no longer waiting for approval.');
          setState('error');
        } else {
          setState('ready');
        }
      })
      .catch(reason => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'The pairing request could not be loaded.');
        setState('error');
      });
    return () => { active = false; };
  }, [code, getAuthHeader]);

  const approve = async () => {
    setState('approving');
    try {
      await auroraApiRequest(`/pairing/requests/${encodeURIComponent(code)}/approve`, getAuthHeader(), { method: 'POST' });
      setState('approved');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The pairing request could not be approved.');
      setState('error');
    }
  };

  return (
    <main className="pairing-page">
      <div className="pairing-page__glow" aria-hidden="true" />
      <section className="pairing-card" aria-labelledby="pairing-title">
        <div className="pairing-card__mark" aria-hidden="true">
          {state === 'approved' ? <ShieldCheck size={27} /> : <Link2 size={27} />}
        </div>
        <p className="pairing-card__eyebrow">Aurora secure pairing</p>
        <h1 id="pairing-title">{state === 'approved' ? 'Desktop connected' : 'Connect this app?'}</h1>

        {state === 'loading' && <p className="pairing-card__lead" role="status">Checking the pairing code…</p>}

        {(state === 'ready' || state === 'approving') && request && (
          <>
            <p className="pairing-card__lead">Only approve a request you started in the desktop app.</p>
            <div className="pairing-device">
              <Laptop size={22} aria-hidden="true" />
              <div><strong>{request.clientName}</strong><span>{request.platform || 'Aurora desktop app'}</span></div>
              <code>{request.userCode}</code>
            </div>
            <div className="pairing-permissions">
              <span>Listener access includes</span>
              <p>Library browsing, streaming, playlists, preferences, and playback-session handoff.</p>
              <p>It cannot manage users, scan folders, change server settings, or access file paths.</p>
            </div>
            <div className="pairing-card__actions">
              <button type="button" className="btn btn-ghost" onClick={() => window.location.assign('/library')} disabled={state === 'approving'}>Not now</button>
              <button type="button" className="btn btn-primary" onClick={() => void approve()} disabled={state === 'approving'}>{state === 'approving' ? 'Connecting…' : 'Connect App'}</button>
            </div>
          </>
        )}

        {state === 'approved' && (
          <>
            <p className="pairing-card__lead" role="status">The desktop app can finish signing in. The new secret is delivered directly to that app and is never displayed here.</p>
            <button type="button" className="btn btn-primary" onClick={() => window.location.assign('/library')}>Return to Aurora</button>
          </>
        )}

        {state === 'error' && (
          <>
            <p className="pairing-card__lead pairing-card__lead--error" role="alert">{error}</p>
            <button type="button" className="btn btn-ghost" onClick={() => window.location.assign('/library')}><ArrowLeft size={16} aria-hidden="true" />Back to Aurora</button>
          </>
        )}
      </section>
    </main>
  );
};
