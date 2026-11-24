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
  const [theAudioDbStatus, setTheAudioDbStatus] = useState<ConnectionStatus>('idle');
  const [theAudioDbMessage, setTheAudioDbMessage] = useState('');
  const [fanartTvStatus, setFanartTvStatus] = useState<ConnectionStatus>('idle');
  const [fanartTvMessage, setFanartTvMessage] = useState('');

  /** POSTs the typed keys to the provider's test route; ok answers name the artist looked up. */
  const testKeys = useCallback(async (
    path: string,
    body: Record<string, string>,
    setStatus: (status: ConnectionStatus) => void,
    setMessage: (message: string) => void,
  ) => {
    setStatus('testing');
    setMessage('');
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...usePlayerStore.getState().getAuthHeader() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.status === 'ok') {
        setStatus('success');
        setMessage(data.artist ? `Connection OK (found ${data.artist})` : 'Connection OK');
      } else {
        setStatus('error');
        setMessage(data.error || `Connection failed (HTTP ${res.status})`);
      }
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message || 'Network error');
    }
  }, []);

  const testTheAudioDb = useCallback((apiKey: string) =>
    testKeys('/api/providers/theaudiodb/test', { apiKey }, setTheAudioDbStatus, setTheAudioDbMessage), [testKeys]);
  const testFanartTv = useCallback((apiKey: string) =>
    testKeys('/api/providers/fanarttv/test', { apiKey }, setFanartTvStatus, setFanartTvMessage), [testKeys]);

  const testLastFm = useCallback(async (apiKey?: string) => {
    setLastFmStatus('testing');
    setLastFmMessage('');
    try {
      const state = usePlayerStore.getState();
      const authHeaders = state.getAuthHeader();
      const sharedSecret = state.lastFmSharedSecret;
      const res = await fetch('/api/providers/lastfm/test', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ apiKey, sharedSecret })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setLastFmStatus('success');
        setLastFmMessage('Connection OK');
      } else {
        setLastFmStatus('error');
        setLastFmMessage(data.error || 'Connection failed');
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
      const authHeaders = state.getAuthHeader();
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
      const authHeaders = state.getAuthHeader();
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
    theAudioDbStatus,
    theAudioDbMessage,
    fanartTvStatus,
    fanartTvMessage,
    testTheAudioDb,
    testFanartTv,
  };
};
