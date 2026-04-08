import React from 'react';
import { usePlayerStore } from '../../store/index';
import { useLlmConnectionTest } from '../../hooks/useLlmConnectionTest';

export const GenAiTab: React.FC = () => {
    const llmBaseUrl = usePlayerStore(state => state.llmBaseUrl);
    const llmApiKey = usePlayerStore(state => state.llmApiKey);
    const llmModelName = usePlayerStore(state => state.llmModelName);
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);

    const {
        connectionStatus,
        connectionMessage,
        availableModels,
        showModelDropdown,
        setShowModelDropdown,
        testLlmConnection: runConnectionTest,
    } = useLlmConnectionTest({
        getAuthHeader,
        onModelsReceived: (models) => {
            if (!llmModelName && models.length > 0) {
                setSettings({ llmModelName: models[0] });
            }
        },
    });

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3>LLM / Engine Configurations</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">
                Bring your own LLM to generate Hub playlists securely on your own hardware.
            </p>
            <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-8">
                <div className="flex flex-col gap-4">
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Base URL</label>
                        <input 
                            type="text" 
                            value={llmBaseUrl} 
                            onChange={(e) => setSettings({ llmBaseUrl: e.target.value })}
                            placeholder="https://api.openai.com/v1"
                            className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Key</label>
                        <input 
                            type="password" 
                            value={llmApiKey} 
                            onChange={(e) => setSettings({ llmApiKey: e.target.value })}
                            placeholder="Leave blank if using local unrestricted provider"
                            className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                        />
                    </div>
                    <div className="relative">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Model Name</label>
                        <input 
                            type="text" 
                            value={llmModelName} 
                            onChange={(e) => setSettings({ llmModelName: e.target.value })}
                            onFocus={() => setShowModelDropdown(true)}
                            onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                            placeholder="gpt-4o / llama-3"
                            className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                        />
                        {availableModels.length > 0 && showModelDropdown && (
                            <ul className="absolute left-0 right-0 z-50 w-full mt-2 max-h-48 overflow-y-auto bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl shadow-xl py-1">
                                {availableModels.map(m => (
                                    <li 
                                        key={m} 
                                        className="px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] cursor-pointer transition-colors"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            setSettings({ llmModelName: m });
                                            setShowModelDropdown(false);
                                        }}
                                    >
                                        {m}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="flex items-center gap-4 mt-2">
                        <button 
                            onClick={() => runConnectionTest(llmBaseUrl, llmApiKey)}
                            disabled={connectionStatus === 'testing'}
                            className="btn btn-ghost disabled:opacity-50"
                        >
                            {connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                        </button>
                        {connectionStatus === 'success' && (
                            <span className="text-green-500 font-semibold text-sm">✓ {connectionMessage}</span>
                        )}
                        {connectionStatus === 'error' && (
                            <span className="text-red-500 font-semibold text-sm truncate max-w-xs">✗ {connectionMessage}</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
