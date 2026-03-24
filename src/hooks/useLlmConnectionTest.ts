import { useState } from 'react';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

interface UseLlmConnectionTestOptions {
  getAuthHeader: () => Record<string, string>;
  onModelsReceived?: (models: string[]) => void;
}

export const useLlmConnectionTest = ({ getAuthHeader, onModelsReceived }: UseLlmConnectionTestOptions) => {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  const testLlmConnection = async (llmBaseUrl: string, llmApiKey: string) => {
    setConnectionStatus('testing');
    setConnectionMessage('');
    setAvailableModels([]);
    try {
      const authHeaders = getAuthHeader();
      const res = await fetch('/api/health/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ llmBaseUrl, llmApiKey })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        setConnectionStatus('success');
        setConnectionMessage('Connection OK');
        if (data.models && data.models.length > 0) {
          setAvailableModels(data.models);
          onModelsReceived?.(data.models);
        }
      } else {
        setConnectionStatus('error');
        setConnectionMessage(data.error || 'Connection failed');
      }
    } catch (err: any) {
      setConnectionStatus('error');
      setConnectionMessage(err.message || 'Network error');
    }
  };

  return {
    connectionStatus,
    connectionMessage,
    availableModels,
    showModelDropdown,
    setShowModelDropdown,
    testLlmConnection,
  };
};
