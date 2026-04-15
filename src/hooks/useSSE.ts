import { useEffect, useRef } from 'react';

interface UseSSEOptions {
  onMessage: (data: unknown) => void;
  onError?: (err: Event) => void;
  throttleMs?: number;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const JITTER_FACTOR = 0.3;
const FLAP_THRESHOLD_MS = 3000;

function applyJitter(delay: number): number {
  const jitter = delay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(BASE_DELAY, delay + jitter);
}

export function useSSE(url: string | null, { onMessage, onError, throttleMs = 0 }: UseSSEOptions) {
  const esRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(BASE_DELAY);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const isOnlineRef = useRef(navigator.onLine);
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  const lastCallRef = useRef(0);

  onMessageRef.current = onMessage;
  onErrorRef.current = onError;

  const connect = () => {
    if (!url) return;

    const es = new EventSource(url);
    esRef.current = es;
    connectedAtRef.current = Date.now();

    es.onmessage = (e) => {
      retryDelayRef.current = BASE_DELAY;
      const now = Date.now();
      if (throttleMs > 0 && now - lastCallRef.current < throttleMs) return;
      lastCallRef.current = now;

      try {
        onMessageRef.current(JSON.parse(e.data));
      } catch {
        onMessageRef.current(e.data);
      }
    };

    es.onerror = (err) => {
      onErrorRef.current?.(err);
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
  };

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
  }, [url]);
}
