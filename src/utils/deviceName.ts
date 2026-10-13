// A short, human name for this browser ("Chrome on Android"), used where
// another of the user's devices shows which device is playing.
export function describeThisDevice(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
      : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Chrome\//.test(userAgent) ? 'Chrome'
          : /Safari\//.test(userAgent) ? 'Safari'
            : 'Browser';
  const platform = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
      : /Android/.test(userAgent) ? 'Android'
        : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac'
          : /Windows/.test(userAgent) ? 'Windows'
            : /CrOS/.test(userAgent) ? 'ChromeOS'
              : /Linux/.test(userAgent) ? 'Linux'
                : null;
  return platform ? `${browser} on ${platform}` : browser;
}
