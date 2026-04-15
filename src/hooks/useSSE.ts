import { useEffect, useRef, useCallback } from 'react';

interface UseSSEOptions {
  onMessage: (data: unknown) => void;
  onError?: (err: Event) => void;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const JITTER_FACTOR = 0.3;
const FLAP_THRESHOLD_MS = 3000;

function applyJitter(delay: number): number {
  const jitter = delay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(BASE_DELAY, delay + jitter);
}

export function useSSE(url: string | null, { onMessage, onError }: UseSSEOptions) {
  const esRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(BASE_DELAY);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const isOnlineRef = useRef(navigator.onLine);

  const connect = useCallback(() => {
    if (!url) return;

    const es = new EventSource(url);
    esRef.current = es;
    connectedAtRef.current = Date.now();

    es.onmessage = (e) => {
      retryDelayRef.current = BASE_DELAY;
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        onMessage(e.data);
      }
    };

    es.onerror = (err) => {
      onError?.(err);
      const duration = connectedAtRef.current ? Date.now() - connectedAtRef.current : FLAP_THRESHOLD_MS;
      if (duration < FLAP_THRESHOLD_MS) {
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, MAX_DELAY);
      }
      es.close();
      esRef.current = null;
      if (isOnlineRef.current) {
        const delay = applyJitter(retryDelayRef.current);
        retryTimerRef.current = setTimeout(connect, delay);
      }
    };
  }, [url, onMessage, onError]);

  useEffect(() => {
    if (!url) return;

    const goOnline = () => {
      isOnlineRef.current = true;
      if (!esRef.current && !retryTimerRef.current) {
        retryDelayRef.current = BASE_DELAY;
        connect();
      }
    };
    const goOffline = () => {
      isOnlineRef.current = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    connect();

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [url, connect]);
}
