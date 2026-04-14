import React, { useEffect, useCallback, useRef } from 'react';
import { usePlayerStore } from '../../store/index';
import { useLlmConnectionTest } from '../../hooks/useLlmConnectionTest';
import { DependencyBadge, DependencyGroup, DependencyInfoBox } from '../DependencyBadge';
import { Sparkles, Palette, Brain, ListMusic, Info } from 'lucide-react';

// Simple debounce helper
function debounce<T extends (...args: any[]) => any>(fn: T, delay: number) {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: Parameters<T>) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

export const GenAiTab: React.FC = () => {
    const llmBaseUrl = usePlayerStore(state => state.llmBaseUrl);
    const llmApiKey = usePlayerStore(state => state.llmApiKey);
    const llmModelName = usePlayerStore(state => state.llmModelName);
    const llmConnected = usePlayerStore(state => state.llmConnected);
    const setSettings = usePlayerStore(state => state.setSettings);
    const saveSettings = usePlayerStore(state => state.saveSettings);
    const setLlmConnected = usePlayerStore(state => state.setLlmConnected);
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
                saveSettings();
            }
        },
    });

    // Auto-save when inputs change (debounced) and re-test connection
    const debouncedSaveAndTest = useRef(debounce(async () => {
        await saveSettings();
        const state = usePlayerStore.getState();
        if (state.llmBaseUrl && state.llmModelName) {
            runConnectionTest(state.llmBaseUrl, state.llmApiKey || '');
        }
    }, 800)).current;

    const handleInputChange = (updates: Partial<{ llmBaseUrl: string; llmApiKey: string; llmModelName: string }>) => {
        setSettings(updates);
        setLlmConnected(false);
        debouncedSaveAndTest();
    };

    // Sync connection status to global store
    useEffect(() => {
        if (connectionStatus === 'success') {
            setLlmConnected(true);
        } else if (connectionStatus === 'error') {
            setLlmConnected(false);
        }
    }, [connectionStatus, setLlmConnected]);

    // Only show as connected if: store says connected AND we have valid credentials
    const hasValidUrl = llmBaseUrl && llmBaseUrl.trim() !== '';
    const hasValidModel = llmModelName && llmModelName.trim() !== '' && llmModelName !== 'gpt-4';
    const hasCredentials = hasValidUrl || hasValidModel;
    const isConnected = connectionStatus === 'success' || (llmConnected && hasCredentials);

    // Connection message based on actual state
    const getConnectionMessage = () => {
        if (connectionStatus === 'testing') return 'Testing connection...';
        if (isConnected) return `${llmModelName || 'Model'} connected and ready`;
        if (!hasCredentials) return 'Configure LLM credentials below';
        return 'Not connected - click Test Connection';
    };

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3>LLM / Engine Configurations</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">
                Bring your own LLM to generate Hub playlists securely on your own hardware.
            </p>

            {/* LLM Status */}
            <div className="mb-6">
                <DependencyGroup title="Connection Status">
                    <DependencyBadge
                        label="LLM Provider"
                        status={isConnected ? 'available' : connectionStatus === 'testing' ? 'partial' : 'unavailable'}
                        message={getConnectionMessage()}
                    />
                </DependencyGroup>
            </div>

            {/* Features that depend on LLM */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">Features requiring LLM</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DependencyInfoBox
                        title="Hub Playlist Generation"
                        description="AI-generated contextual playlists based on time of day and listening history"
                        icon={<Palette size={16} />}
                    />
                    <DependencyInfoBox
                        title="Custom Playlists"
                        description="Create playlists from natural language prompts like 'moody acoustic songs for studying'"
                        icon={<ListMusic size={16} />}
                    />
                    <DependencyInfoBox
                        title="Genre Matrix Categorization"
                        description="AI mapping of unknown local genres to MusicBrainz taxonomy"
                        icon={<Brain size={16} />}
                    />
                </div>
            </div>

            {/* Configuration Form */}
            <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-8">
                <div className="flex flex-col gap-4">
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Base URL</label>
                        <input 
                            type="text" 
                            value={llmBaseUrl} 
                            onChange={(e) => handleInputChange({ llmBaseUrl: e.target.value })}
                            placeholder="https://api.openai.com/v1"
                            className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">API Key</label>
                        <input 
                            type="password" 
                            value={llmApiKey} 
                            onChange={(e) => handleInputChange({ llmApiKey: e.target.value })}
                            placeholder="Leave blank if using local unrestricted provider"
                            className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                        />
                    </div>
                    <div className="relative">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Model Name</label>
                        <input 
                            type="text" 
                            value={llmModelName} 
                            onChange={(e) => handleInputChange({ llmModelName: e.target.value })}
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
                                            handleInputChange({ llmModelName: m });
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

            {/* Provider Recommendations */}
            <div className="p-4 rounded-xl bg-[var(--color-surface)]/50 border border-[var(--glass-border)]">
                <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-[var(--color-text-muted)] flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-[var(--color-text-muted)] space-y-2">
                        <p className="font-medium text-[var(--color-text-secondary)]">Recommended Providers</p>
                        <ul className="space-y-1">
                            <li>• <strong>Local (Private):</strong> LM Studio, Ollama, local LLM server</li>
                            <li>• <strong>Cloud:</strong> OpenAI, Anthropic, Google AI</li>
                            <li>• For LM Studio: use <code className="bg-black/10 dark:bg-white/10 px-1 rounded">http://localhost:1234/v1</code></li>
                            <li>• For Ollama: use <code className="bg-black/10 dark:bg-white/10 px-1 rounded">http://localhost:11434/v1</code></li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
};