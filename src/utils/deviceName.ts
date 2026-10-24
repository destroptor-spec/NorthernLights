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

/**
 * A phone or tablet: the operating system routes its audio (speaker,
 * headphones, Bluetooth), so a web page has no output to choose there even
 * where the browser has setSinkId. iPadOS asks for desktop pages and reports
 * itself as a Mac with a touch screen.
 */
export function isPhoneOrTablet(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0,
): boolean {
  if (/Android|iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}
