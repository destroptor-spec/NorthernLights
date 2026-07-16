import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadTurnstileScript,
  renderTurnstileWidget,
  resetTurnstileWidget,
  removeTurnstileWidget,
} from '../utils/turnstile';

export type TurnstileStatus = 'idle' | 'loading' | 'ready' | 'error';

// Manages one Turnstile widget inside `containerRef` while `active` is true.
// Tokens are single-use: call reset() after every failed submit. A script or
// widget failure yields status 'error' — callers should warn but keep submit
// enabled (the server enforces the captcha either way).
export function useTurnstile(
  enabled: boolean,
  siteKey: string,
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): { token: string | null; status: TurnstileStatus; reset: () => void } {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>('idle');
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !siteKey || !active) {
      if (widgetIdRef.current) {
        removeTurnstileWidget(widgetIdRef.current);
        widgetIdRef.current = null;
      }
      setToken(null);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('loading');

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const widgetId = renderTurnstileWidget(containerRef.current, siteKey, {
          onToken: t => {
            if (cancelled) return;
            setToken(t);
            setStatus('ready');
          },
          onExpired: () => {
            if (cancelled) return;
            setToken(null);
            if (widgetIdRef.current) resetTurnstileWidget(widgetIdRef.current);
          },
          onError: () => {
            if (cancelled) return;
            setToken(null);
            setStatus('error');
          },
        });
        if (widgetId) {
          widgetIdRef.current = widgetId;
          setStatus('ready');
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current) {
        removeTurnstileWidget(widgetIdRef.current);
        widgetIdRef.current = null;
      }
      setToken(null);
    };
  }, [enabled, siteKey, active, containerRef]);

  const reset = useCallback(() => {
    setToken(null);
    if (widgetIdRef.current) resetTurnstileWidget(widgetIdRef.current);
  }, []);

  return { token, status, reset };
}
