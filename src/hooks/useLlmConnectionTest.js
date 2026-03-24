import { useState } from 'react';
export const useLlmConnectionTest = ({ getAuthHeader, onModelsReceived }) => {
    const [connectionStatus, setConnectionStatus] = useState('idle');
    const [connectionMessage, setConnectionMessage] = useState('');
    const [availableModels, setAvailableModels] = useState([]);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const testLlmConnection = async (llmBaseUrl, llmApiKey) => {
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
            }
            else {
                setConnectionStatus('error');
                setConnectionMessage(data.error || 'Connection failed');
            }
        }
        catch (err) {
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
