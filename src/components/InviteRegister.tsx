import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store/index';
import { UserPlus, CheckCircle2, XCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import SoftAurora from './SoftAurora';
import { useAuthConfig } from '../hooks/useAuthConfig';
import { useTurnstile } from '../hooks/useTurnstile';

const AuthBackdrop: React.FC = () => (
  <div className="absolute inset-0 pointer-events-none">
    <div className="app-backdrop" />
    <div className="absolute inset-0">
      <SoftAurora
        speed={0.2}
        scale={1.4}
        brightness={1.8}
        color1="#10B981"
        color2="#22C983"
        noiseFrequency={2}
        noiseAmplitude={7}
        bandHeight={1}
        bandSpread={0.4}
        octaveDecay={0.2}
        layerOffset={0.65}
        colorSpeed={1}
        enableMouseInteraction={false}
        mouseInfluence={0.1}
      />
    </div>
  </div>
);

interface InviteData {
  valid: boolean;
  reason?: 'not_found' | 'expired' | 'used_up' | 'error';
  inviterUsername?: string | null;
  expiresAt?: number | null;
  usesLeft?: number;
}

function getPasswordStrength(pw: string): 'weak' | 'fair' | 'strong' | null {
  if (!pw) return null;
  const hasUpper = /[A-Z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const hasSpecial = /[^A-Za-z0-9]/.test(pw);
  const long = pw.length >= 12;
  const score = [pw.length >= 8, hasUpper, hasNumber, hasSpecial, long].filter(Boolean).length;
  if (score <= 2) return 'weak';
  if (score <= 3) return 'fair';
  return 'strong';
}

const STRENGTH_LABEL: Record<string, string> = {
  weak: 'Weak',
  fair: 'Fair',
  strong: 'Strong',
};

export const InviteRegister: React.FC = () => {
  const token = window.location.pathname.split('/invite/')[1]?.split('/')[0]?.trim() || null;
  const navigate = useNavigate();
  const register = usePlayerStore(state => state.register);

  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);

  const strength = getPasswordStrength(password);
  const passwordsMatch = password === confirmPassword;

  const { turnstileEnabled, turnstileSiteKey } = useAuthConfig();
  const turnstile = useTurnstile(
    turnstileEnabled,
    turnstileSiteKey,
    turnstileRef,
    inviteData?.valid === true && !success,
  );

  useEffect(() => {
    if (!token) {
      setInviteData({ valid: false, reason: 'not_found' });
      return;
    }
    fetch(`/api/invites/${token}/validate`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: InviteData) => setInviteData(data))
      .catch(() => setInviteData({ valid: false, reason: 'error' }));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !username.trim() || !password || !passwordsMatch) return;
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setIsLoading(true);
    setError('');

    const result = await register(token, username.trim(), password, turnstile.token ?? undefined);
    if (result.success) {
      setSuccess(true);
      // Brief success moment before navigating
      setTimeout(() => {
        usePlayerStore.getState().loadSettings();
        usePlayerStore.getState().fetchLibraryFromServer();
        usePlayerStore.getState().fetchPlaylistsFromServer();
        navigate('/library');
      }, 750);
    } else {
      // Turnstile tokens are single-use — a fresh challenge is needed for the retry.
      turnstile.reset();
      setError(result.error);
    }
    setIsLoading(false);
  };

  // ── Loading state ───────────────────────────────────────────────
  if (inviteData === null) {
    return (
      <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4">
        <AuthBackdrop />
        <div className="auth-card-enter relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl flex flex-col items-center gap-4">
          <div className="w-14 h-14 bg-primary/20 text-[var(--color-primary)] rounded-full flex items-center justify-center">
            <Loader2 className="w-7 h-7 animate-spin" />
          </div>
          <p className="text-sm text-[var(--color-text-secondary)]">validating invite…</p>
        </div>
      </div>
    );
  }

  // ── Invalid / expired / used state ─────────────────────────────
  if (!inviteData.valid) {
    const messages: Record<string, string> = {
      expired: 'This invite link has expired.',
      used_up: 'This invite link has already been used.',
      not_found: 'This invite link is invalid or doesn\'t exist.',
      error: 'Unable to validate this invite. Try again shortly.',
    };
    const msg = messages[inviteData.reason ?? 'not_found'] ?? messages.not_found;

    return (
      <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4">
        <AuthBackdrop />
        <div className="auth-card-enter relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl flex flex-col items-center gap-4 text-center">
          <XCircle className="w-12 h-12 text-[var(--color-error)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-display)' }}>
            Invite invalid
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">{msg}</p>
          <button
            onClick={() => navigate('/')}
            className="btn btn-ghost btn-sm mt-2"
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    );
  }

  // ── Success flash ───────────────────────────────────────────────
  if (success) {
    return (
      <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4">
        <AuthBackdrop />
        <div className="auth-card-enter relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl flex flex-col items-center gap-4 text-center">
          <CheckCircle2 className="w-12 h-12 text-[var(--color-primary)]" />
          <p className="text-lg font-semibold text-[var(--color-text-primary)]"
             style={{ fontFamily: 'var(--font-display)' }}>
            Welcome.
          </p>
        </div>
      </div>
    );
  }

  // ── Registration form ───────────────────────────────────────────
  const { inviterUsername } = inviteData;

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4 overflow-y-auto">
      <AuthBackdrop />

      <div className="auth-card-enter relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl my-auto">
        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-primary/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4">
            <UserPlus className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-display)' }}>
            You've been invited.
          </h1>
          {inviterUsername ? (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">
              Invited by <span className="text-[var(--color-text-primary)] font-medium">{inviterUsername}</span> — choose a username to join.
            </p>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              Choose a username to join Aurora.
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Username */}
          <div>
            <label htmlFor="reg-username" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Username
            </label>
            <input
              id="reg-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Choose a username"
              autoFocus
              autoComplete="username"
              className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="reg-password" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Password
            </label>
            <div className="relative">
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Choose a password"
                autoComplete="new-password"
                className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 pr-11 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="btn-icon absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {/* Strength bar */}
            {strength && (
              <div>
                <div className="password-strength-bar" aria-hidden="true">
                  <div className="password-strength-bar__fill" data-strength={strength} />
                </div>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {STRENGTH_LABEL[strength]}
                </p>
              </div>
            )}
          </div>

          {/* Confirm password */}
          <div>
            <label htmlFor="reg-confirm" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Confirm password
            </label>
            <div className="relative">
              <input
                id="reg-confirm"
                type={showConfirm ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Repeat your password"
                autoComplete="new-password"
                className={`w-full bg-[var(--color-surface)] border rounded-xl px-4 py-3 pr-11 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] ${
                  confirmPassword && !passwordsMatch
                    ? 'border-error/50'
                    : 'border-[var(--glass-border)]'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowConfirm(v => !v)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
                className="btn-icon absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8"
              >
                {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {confirmPassword && !passwordsMatch && (
              <p className="text-xs text-[var(--color-error)] mt-1">Passwords don't match.</p>
            )}
          </div>

          {/* Turnstile challenge */}
          {turnstileEnabled && (
            <div>
              <div ref={turnstileRef} className="flex justify-center min-h-[65px]" />
              {turnstile.status === 'loading' && (
                <p className="text-xs text-[var(--color-text-muted)] text-center mt-1">
                  Loading verification…
                </p>
              )}
              {turnstile.status === 'error' && (
                <p className="text-xs text-[var(--color-text-muted)] text-center mt-1">
                  Verification couldn't load — registration may fail.
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div role="alert" className="text-[var(--color-error)] text-sm bg-error/10 border border-error/20 rounded-xl px-4 py-2">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!username.trim() || !password || !confirmPassword || !passwordsMatch || isLoading}
            className="btn btn-primary btn-lg w-full mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                creating account…
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                Create account
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
