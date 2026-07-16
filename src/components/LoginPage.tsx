import React, { useEffect, useRef, useState } from 'react';
import { Music2, Eye, EyeOff, Loader2, LogIn, ArrowRight, ChevronLeft, User } from 'lucide-react';
import SoftAurora from './SoftAurora';
import { useAuthConfig } from '../hooks/useAuthConfig';
import { useTurnstile } from '../hooks/useTurnstile';
import type { AuthAttemptResult } from '../store/index';

interface LoginPageProps {
  onLogin: (username: string, password: string, rememberDevice: boolean, turnstileToken?: string) => Promise<AuthAttemptResult>;
  initialUsername?: string;
  initialRememberDevice?: boolean;
  sessionMessage?: string | null;
  submitLabel?: string;
}

// Two-step sign-in: username first, then password (Google-style). Step 1 is
// purely client-side — no request leaves the page when advancing, so the flow
// can never reveal whether a username exists. Both inputs stay mounted (the
// inactive one is visually hidden, not unmounted) so password managers keep
// autofilling the username/password pair.
export const LoginPage: React.FC<LoginPageProps> = ({
  onLogin,
  initialUsername = '',
  initialRememberDevice = true,
  sessionMessage = null,
  submitLabel = 'Sign in',
}) => {
  const [step, setStep] = useState<'username' | 'password'>(initialUsername ? 'password' : 'username');
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(initialRememberDevice);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);

  const { turnstileEnabled, turnstileSiteKey } = useAuthConfig();
  const turnstile = useTurnstile(turnstileEnabled, turnstileSiteKey, turnstileRef, step === 'password');

  useEffect(() => {
    if (step === 'password') {
      passwordRef.current?.focus();
    } else {
      usernameRef.current?.focus();
    }
  }, [step]);

  const goBackToUsername = () => {
    setStep('username');
    setPassword('');
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 'username') {
      if (!username.trim()) return;
      setError('');
      setStep('password');
      return;
    }

    if (!username.trim() || !password) return;
    setIsLoading(true);
    setError('');
    const result = await onLogin(username.trim(), password, rememberDevice, turnstile.token ?? undefined);
    if (!result.success) {
      // Turnstile tokens are single-use — a fresh challenge is needed for the retry.
      turnstile.reset();
      setError(result.code ? result.error : 'Incorrect credentials. Ask your admin to reset your password.');
    }
    setIsLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4 overflow-y-auto">
      {/* Aurora atmosphere — matches app-backdrop */}
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

      <div className="auth-card-enter relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl my-auto">
        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-primary/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4">
            <Music2 className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-display)' }}>
            Aurora
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {step === 'username' ? 'Rediscover your music' : 'Welcome back'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Identity chip — step 2 only; returns to the username step */}
          {step === 'password' && (
            <button
              type="button"
              onClick={goBackToUsername}
              aria-label="Change account"
              className="flex items-center gap-2 mx-auto max-w-full pl-2 pr-3 py-1.5 rounded-full border border-[var(--glass-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-secondary)] hover:border-primary/50 transition-ui"
            >
              <ChevronLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="w-5 h-5 rounded-full bg-primary/20 text-[var(--color-primary)] flex items-center justify-center shrink-0">
                <User className="w-3 h-3" aria-hidden="true" />
              </span>
              <span className="truncate font-medium text-[var(--color-text-primary)]">{username.trim()}</span>
            </button>
          )}

          {/* Username — hidden but mounted on step 2 so password managers pair it */}
          <div className={step === 'username' ? undefined : 'sr-only'} aria-hidden={step !== 'username'}>
            <label htmlFor="login-username" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Username
            </label>
            <input
              id="login-username"
              ref={usernameRef}
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="username"
              autoComplete="username"
              tabIndex={step === 'username' ? 0 : -1}
              className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
            />
          </div>

          {/* Password — hidden but mounted on step 1 */}
          <div className={step === 'password' ? undefined : 'sr-only'} aria-hidden={step !== 'password'}>
            <label htmlFor="login-password" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Password
            </label>
            <div className="relative">
              <input
                id="login-password"
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                tabIndex={step === 'password' ? 0 : -1}
                className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 pr-11 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={step === 'password' ? 0 : -1}
                className="btn-icon absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8"
              >
                {showPassword
                  ? <EyeOff className="w-4 h-4" />
                  : <Eye className="w-4 h-4" />
                }
              </button>
            </div>
          </div>

          {/* Remember me — only meaningful once credentials are being submitted */}
          {step === 'password' && (
            <label htmlFor="login-remember" className="flex items-center gap-2.5 cursor-pointer select-none w-fit">
              <input
                id="login-remember"
                type="checkbox"
                checked={rememberDevice}
                onChange={e => setRememberDevice(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-primary)] cursor-pointer"
              />
              <span className="text-sm text-[var(--color-text-secondary)]">
                Remember me on this device
              </span>
            </label>
          )}

          {/* Turnstile challenge */}
          {step === 'password' && turnstileEnabled && (
            <div>
              <div ref={turnstileRef} className="flex justify-center min-h-[65px]" />
              {turnstile.status === 'loading' && (
                <p className="text-xs text-[var(--color-text-muted)] text-center mt-1">
                  Loading verification…
                </p>
              )}
              {turnstile.status === 'error' && (
                <p className="text-xs text-[var(--color-text-muted)] text-center mt-1">
                  Verification couldn't load — sign-in may fail.
                </p>
              )}
            </div>
          )}

          {sessionMessage && !error && (
            <div role="status" className="text-[var(--color-text-primary)] text-sm bg-primary/10 border border-primary/20 rounded-xl px-4 py-2">
              {sessionMessage}
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
            disabled={step === 'username' ? !username.trim() : (!password || isLoading)}
            className="btn btn-primary btn-lg w-full mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {step === 'username' ? (
              <>
                Continue
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </>
            ) : isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                signing in…
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" aria-hidden="true" />
                {submitLabel}
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
