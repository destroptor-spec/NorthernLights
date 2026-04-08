import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store/index';
import { UserPlus, CheckCircle2, XCircle } from 'lucide-react';

export const InviteRegister: React.FC = () => {
  // Extract token from URL path manually — this component can render outside <Routes>
  // Handle potential trailing slashes and ensure token is trimmed
  const token = window.location.pathname.split('/invite/')[1]?.split('/')[0]?.trim() || null;
  const navigate = useNavigate();
  const register = usePlayerStore(state => state.register);

  const [isValid, setIsValid] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    console.log('[InviteRegister] token:', token);
    console.log('[InviteRegister] pathname:', window.location.pathname);
    if (!token) { 
      console.log('[InviteRegister] No token, setting isValid=false');
      setIsValid(false); 
      return; 
    }
    console.log('[InviteRegister] Fetching validation for token:', token);
    fetch(`/api/invites/${token}/validate`)
      .then(r => {
        console.log('[InviteRegister] Response status:', r.status);
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        return r.json();
      })
      .then(data => {
        console.log('[InviteRegister] Response data:', data);
        setIsValid(data.valid);
      })
      .catch(e => {
        console.error('[InviteRegister] Fetch error:', e);
        setError(`Failed to validate invite: ${e.message}`);
        setIsValid(false);
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !username.trim() || !password) return;
    setIsLoading(true);
    setError('');

    const success = await register(token, username.trim(), password);
    if (success) {
      usePlayerStore.getState().loadSettings();
      usePlayerStore.getState().fetchLibraryFromServer();
      usePlayerStore.getState().fetchPlaylistsFromServer();
      navigate('/library');
    } else {
      setError('Registration failed. The invite may have expired or the username is taken.');
    }
    setIsLoading(false);
  };

  if (isValid === null) {
    return (
      <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center">
        <div className="text-[var(--color-text-secondary)]">Validating invite...</div>
      </div>
    );
  }

  if (!isValid) {
    return (
      <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <XCircle className="w-16 h-16 text-red-400 mx-auto" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Invalid Invite</h1>
          <p className="text-[var(--color-text-secondary)]">{error || "This invite link is invalid, expired, or has been used up."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4">
      <div className="absolute inset-0 z-0 opacity-30 bg-aurora-deep pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-[var(--color-primary)]/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4">
            <UserPlus className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]">
            Join Aurora
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Create your account to get started
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Choose a username"
              autoFocus
              className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Choose a password"
              className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!username.trim() || !password || isLoading}
            className="w-full mt-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold py-3.5 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Creating Account...' : (
              <>
                <CheckCircle2 className="w-4 h-4" /> Create Account
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
