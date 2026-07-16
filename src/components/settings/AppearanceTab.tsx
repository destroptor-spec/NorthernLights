import React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { usePlayerStore } from '../../store/index';

export const AppearanceTab: React.FC = () => {
    const theme = usePlayerStore(state => state.theme);
    const setTheme = usePlayerStore(state => state.setTheme);
    const reducedMotion = usePlayerStore(state => state.reducedMotion);
    const setReducedMotion = usePlayerStore(state => state.setReducedMotion);
    const mobileVideoBackgrounds = usePlayerStore(state => state.mobileVideoBackgrounds);
    const setMobileVideoBackgrounds = usePlayerStore(state => state.setMobileVideoBackgrounds);

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Appearance</h3>
            </div>

            <h5 className="appearance-group-title">Theme</h5>
            <div className="flex gap-4 mb-4">
                <button
                    type="button"
                    aria-pressed={theme === 'light'}
                    className={`btn flex-1 py-4 inline-flex items-center justify-center gap-2 tracking-wide duration-300 ${theme === 'light' ? 'btn-primary !shadow-lg !scale-100' : 'btn-ghost'}`}
                    onClick={() => setTheme('light')}
                >
                    <Sun size={18} aria-hidden="true" />
                    Light
                </button>
                <button
                    type="button"
                    aria-pressed={theme === 'dark'}
                    className={`btn flex-1 py-4 inline-flex items-center justify-center gap-2 tracking-wide duration-300 ${theme === 'dark' ? 'btn-primary !shadow-lg !scale-100 dark:bg-[var(--color-primary)] dark:border-[var(--color-primary)]' : 'btn-ghost'}`}
                    onClick={() => setTheme('dark')}
                >
                    <Moon size={18} aria-hidden="true" />
                    Dark
                </button>
                <button
                    type="button"
                    aria-pressed={theme === 'system'}
                    className={`btn flex-1 py-4 inline-flex items-center justify-center gap-2 tracking-wide duration-300 ${theme === 'system' ? 'btn-primary !shadow-lg !scale-100 dark:bg-[var(--color-primary)] dark:border-[var(--color-primary)]' : 'btn-ghost'}`}
                    onClick={() => setTheme('system')}
                >
                    <Monitor size={18} aria-hidden="true" />
                    System
                </button>
            </div>

            <div className="appearance-toggle-row">
                <div>
                    <h5>Reduced motion</h5>
                    <p>Minimize animations and transitions.</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={reducedMotion}
                    aria-label="Reduced motion"
                    onClick={() => setReducedMotion(!reducedMotion)}
                    className="account-switch"
                    data-state={reducedMotion ? 'on' : 'off'}
                >
                    <span className="account-switch__thumb" />
                </button>
            </div>

            <div className="appearance-toggle-row">
                <div>
                    <h5>Music video backgrounds</h5>
                    <p>On mobile, play a track's matched music video (muted) behind the now-playing screen.</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={mobileVideoBackgrounds}
                    aria-label="Music video backgrounds"
                    onClick={() => setMobileVideoBackgrounds(!mobileVideoBackgrounds)}
                    className="account-switch"
                    data-state={mobileVideoBackgrounds ? 'on' : 'off'}
                >
                    <span className="account-switch__thumb" />
                </button>
            </div>
        </div>
    );
};
