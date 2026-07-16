// Minimal Cloudflare Turnstile wrapper — script loader + explicit widget
// management, no npm dependency. The script is only injected when the captcha
// is actually enabled (see useTurnstile), so self-hosted installs without it
// never contact Cloudflare.

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  theme?: 'auto' | 'light' | 'dark';
}

interface TurnstileApi {
  render: (el: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise: Promise<void> | null = null;

export function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      // Clear the memo so a later attempt (e.g. connectivity restored) retries.
      scriptPromise = null;
      reject(new Error('Failed to load Turnstile'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function renderTurnstileWidget(
  el: HTMLElement,
  siteKey: string,
  handlers: { onToken: (token: string) => void; onExpired: () => void; onError: () => void },
): string | null {
  if (!window.turnstile) return null;
  try {
    return window.turnstile.render(el, {
      sitekey: siteKey,
      theme: 'auto',
      callback: handlers.onToken,
      'expired-callback': handlers.onExpired,
      'error-callback': handlers.onError,
    });
  } catch {
    return null;
  }
}

export function resetTurnstileWidget(widgetId: string): void {
  try {
    window.turnstile?.reset(widgetId);
  } catch {
    // Widget already gone — nothing to reset.
  }
}

export function removeTurnstileWidget(widgetId: string): void {
  try {
    window.turnstile?.remove(widgetId);
  } catch {
    // Widget already gone — nothing to remove.
  }
}
