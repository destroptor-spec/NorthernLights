/** Apply before writing diagnostics, including playlist URLs and FFmpeg output. */
export function redactLogSecrets(value: string): string {
  return value
    .replace(/([?&]token=)[^&\s"'<>\\]+/gi, '$1[redacted]')
    .replace(/Bearer\s+(?!\[redacted\])[^\s"'<>\\]+/gi, 'Bearer [redacted]')
    .replace(/("(?:token|access_token|refresh_token)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt-redacted]');
}
