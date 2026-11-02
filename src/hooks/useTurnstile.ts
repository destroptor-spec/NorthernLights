import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadTurnstileScript,
  renderTurnstileWidget,
  resetTurnstileWidget,
  removeTurnstileWidget,
} from '../utils/turnstile';

export type TurnstileStatus = 'idle' | 'loading' | 'ready' | 'error';

// Manages one Turnstile widget inside `containerRef` while `active` is true.
// Tokens are single-use: call reset() after every failed submit. `pending` is
// true while the captcha is on and no token has arrived yet: callers keep
// submit disabled then, because the server refuses a request without one. A
// submit made before the challenge finished used to fail, reset the widget and
// start the wait over; on a phone that kept a user out for good (prod
// 2026-10-29, 12 `captcha_missing` in a row). A script or widget failure
// yields status 'error'; reset() tries again.
export function useTurnstile(
  enabled: boolean,
  siteKey: string,
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): { token: string | null; status: TurnstileStatus; pending: boolean; reset: () => void } {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>('idle');
  // Bumped to load the script again after it failed to load.
  const [attempt, setAttempt] = useState(0);
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
  }, [enabled, siteKey, active, containerRef, attempt]);

  const reset = useCallback(() => {
    setToken(null);
    if (widgetIdRef.current) {
      resetTurnstileWidget(widgetIdRef.current);
      setStatus(current => (current === 'error' ? 'ready' : current));
    } else {
      setAttempt(n => n + 1);
    }
  }, []);

  const pending = enabled && !!siteKey && active && !token;
  return { token, status, pending, reset };
}
