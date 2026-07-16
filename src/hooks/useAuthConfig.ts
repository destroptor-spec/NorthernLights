import { useEffect, useState } from 'react';

// Pre-auth screen configuration from GET /api/public/auth-config. Cached at
// module level so the login and invite screens share one fetch per page load.
// On any failure the captcha is reported disabled — display is fail-open, the
// server stays authoritative.

export interface AuthConfig {
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
}

const DISABLED: AuthConfig = { turnstileEnabled: false, turnstileSiteKey: '' };

let configPromise: Promise<AuthConfig> | null = null;

function fetchAuthConfig(): Promise<AuthConfig> {
  configPromise ??= fetch('/api/public/auth-config')
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      const enabled = data?.turnstile?.enabled === true;
      const siteKey = typeof data?.turnstile?.siteKey === 'string' ? data.turnstile.siteKey : '';
      return enabled && siteKey ? { turnstileEnabled: true, turnstileSiteKey: siteKey } : DISABLED;
    })
    .catch(() => {
      // Allow a retry on the next mount (e.g. transient network blip).
      configPromise = null;
      return DISABLED;
    });
  return configPromise;
}

export function useAuthConfig(): AuthConfig & { loading: boolean } {
  const [config, setConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig().then(result => {
      if (!cancelled) setConfig(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { loading: config === null, ...(config ?? DISABLED) };
}
