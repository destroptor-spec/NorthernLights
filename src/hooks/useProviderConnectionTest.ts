import { useState, useCallback } from 'react';
import { usePlayerStore } from '../store';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

export const useProviderConnectionTest = () => {
  const [lastFmStatus, setLastFmStatus] = useState<ConnectionStatus>('idle');
  const [lastFmMessage, setLastFmMessage] = useState('');
  const [geniusStatus, setGeniusStatus] = useState<ConnectionStatus>('idle');
  const [geniusMessage, setGeniusMessage] = useState('');
  const [musicBrainzStatus, setMusicBrainzStatus] = useState<ConnectionStatus>('idle');
  const [musicBrainzMessage, setMusicBrainzMessage] = useState('');

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
      const state = usePlayerStore.getState();
      const authHeaders = (state as any).getAuthHeader?.() || {};
      const res = await fetch('/api/providers/genius/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ apiKey })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setGeniusStatus('success');
        setGeniusMessage('Connection OK');
      } else {
        setGeniusStatus('error');
        setGeniusMessage(data.error || 'Connection failed');
      }
    } catch (err: any) {
      setGeniusStatus('error');
      setGeniusMessage(err.message || 'Network error');
    }
  }, []);

  const testMusicBrainz = useCallback(async () => {
    setMusicBrainzStatus('testing');
    setMusicBrainzMessage('');
    try {
      const state = usePlayerStore.getState();
      const authHeaders = (state as any).getAuthHeader?.() || {};
      const res = await fetch('/api/providers/musicbrainz/test', { headers: authHeaders });
      const data = await res.json();
      if (data.status === 'ok') {
        setMusicBrainzStatus('success');
        if (data.mode === 'authenticated') {
          setMusicBrainzMessage(`Connected as ${data.username || 'MusicBrainz user'}`);
        } else {
          setMusicBrainzMessage('Connected (anonymous)');
        }
      } else {
        setMusicBrainzStatus('error');
        setMusicBrainzMessage(data.error || 'Connection failed');
      }
    } catch (err: any) {
      setMusicBrainzStatus('error');
      setMusicBrainzMessage(err.message || 'Network error');
    }
  }, []);

  return {
    lastFmStatus,
    lastFmMessage,
    geniusStatus,
    geniusMessage,
    musicBrainzStatus,
    musicBrainzMessage,
    testLastFm,
    testGenius,
    testMusicBrainz,
  };
};
