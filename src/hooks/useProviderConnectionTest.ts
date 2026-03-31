import { useState, useCallback } from 'react';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

export const useProviderConnectionTest = () => {
  const [lastFmStatus, setLastFmStatus] = useState<ConnectionStatus>('idle');
  const [lastFmMessage, setLastFmMessage] = useState('');
  const [geniusStatus, setGeniusStatus] = useState<ConnectionStatus>('idle');
  const [geniusMessage, setGeniusMessage] = useState('');

  const testLastFm = useCallback(async (apiKey: string) => {
    if (!apiKey) {
      setLastFmStatus('idle');
      setLastFmMessage('');
      return;
    }
    setLastFmStatus('testing');
    setLastFmMessage('');
    try {
      const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=Radiohead&api_key=${apiKey}&format=json`);
      const json = await res.json();
      if (json.error) {
        setLastFmStatus('error');
        setLastFmMessage(json.message || `API error ${json.error}`);
      } else if (json.artist) {
        setLastFmStatus('success');
        setLastFmMessage('Connection OK');
      } else {
        setLastFmStatus('error');
        setLastFmMessage('Unexpected response');
      }
    } catch (err: any) {
      setLastFmStatus('error');
      setLastFmMessage(err.message || 'Network error');
    }
  }, []);

  const testGenius = useCallback(async (apiKey: string) => {
    if (!apiKey) {
      setGeniusStatus('idle');
      setGeniusMessage('');
      return;
    }
    setGeniusStatus('testing');
    setGeniusMessage('');
    try {
      const res = await fetch(`https://api.genius.com/search?q=test`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (res.ok) {
        setGeniusStatus('success');
        setGeniusMessage('Connection OK');
      } else if (res.status === 401) {
        setGeniusStatus('error');
        setGeniusMessage('Invalid token');
      } else {
        setGeniusStatus('error');
        setGeniusMessage(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      setGeniusStatus('error');
      setGeniusMessage(err.message || 'Network error');
    }
  }, []);

  return {
    lastFmStatus,
    lastFmMessage,
    geniusStatus,
    geniusMessage,
    testLastFm,
    testGenius,
  };
};
