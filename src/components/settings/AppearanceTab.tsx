import React from 'react';
import { usePlayerStore } from '../../store/index';

export const AppearanceTab: React.FC = () => {
    const theme = usePlayerStore(state => state.theme);
    const setTheme = usePlayerStore(state => state.setTheme);

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Appearance</h3>
            </div>
            <div className="flex gap-4 mb-4">
                <button 
                    className={`btn flex-1 py-4 tracking-wide duration-300 ${theme === 'light' ? 'btn-primary !shadow-lg !scale-100' : 'btn-ghost'}`}
                    onClick={() => setTheme('light')}
                >
                    ☀️ Light
                </button>
                <button 
                    className={`btn flex-1 py-4 tracking-wide duration-300 ${theme === 'dark' ? 'btn-primary !shadow-lg !scale-100 dark:bg-[var(--color-primary)] dark:border-[var(--color-primary)]' : 'btn-ghost'}`}
                    onClick={() => setTheme('dark')}
                >
                    🌙 Dark
                </button>
            </div>
        </div>
    );
};
