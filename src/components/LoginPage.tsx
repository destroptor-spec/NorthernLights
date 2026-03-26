import React, { useState } from 'react';
import { Lock, LogIn } from 'lucide-react';

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<boolean>;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setIsLoading(true);
    setError('');
    const success = await onLogin(username.trim(), password);
    if (!success) {
      setError('Invalid username or password.');
    }
    setIsLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--color-bg)] flex items-center justify-center p-4">
      <div className="absolute inset-0 z-0 opacity-30 bg-gradient-to-br from-[var(--color-primary-dark)] via-[var(--color-bg)] to-purple-900 pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-[var(--color-primary)]/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4">
            <Lock className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]">
            NorthernLights
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Sign in to access your library
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="admin"
              autoFocus
              className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
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
            {isLoading ? 'Signing in...' : (
              <>
                <LogIn className="w-4 h-4" /> Sign In
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
