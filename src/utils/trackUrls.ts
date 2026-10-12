/** Point an existing media URL at a fresh token, keeping everything else. */
export function withMediaToken(url: string, token: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (token) parsed.searchParams.set('token', token);
    else parsed.searchParams.delete('token');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Stream, raw and cover URLs for a queue track, rebuilt with the current token
 * and quality. `currentArtUrl` is the track's existing cover URL: an API v1
 * track without a content hash only has the artwork URL it was given by the
 * API, so that URL is kept (re-tokened) rather than dropped.
 */
export function buildTrackUrls(
  trackId: string, path: string, token: string, quality: string = '128k', artHash?: string, currentArtUrl?: string,
): { url: string; rawUrl: string; artUrl: string | undefined } {
  const base = `${window.location.protocol}//${window.location.host}`;
  const tokenParam = token ? `&token=${token}` : '';
  if (path.startsWith('api-v1:')) {
    const encodedToken = encodeURIComponent(token);
    return {
      url: `${base}/api/stream/${encodeURIComponent(trackId)}/playlist.m3u8?quality=${quality}${tokenParam}`,
      rawUrl: `${base}/api/v1/media/tracks/${encodeURIComponent(trackId)}${encodedToken ? `?token=${encodedToken}` : ''}`,
      artUrl: artHash ? `${base}/api/art?hash=${encodeURIComponent(artHash)}${tokenParam}`
        : currentArtUrl ? withMediaToken(currentArtUrl, token) : undefined,
    };
  }
  // path is already base64 from the DB — just URL-encode for safe transport
  const pathB64 = encodeURIComponent(path);
  // Prefer a content-hash art URL when the cover has been pre-encoded: it's
  // identical across every track of an album, so the service worker caches and
  // the browser decodes it ONCE per album instead of once per track. Tracks not
  // yet processed (no artHash) fall back to the path-addressed URL, which the
  // server resolves and serves (or live-extracts) transparently.
  const artUrl = artHash
    ? `${base}/api/art?hash=${artHash}${tokenParam}`
    : `${base}/api/art?pathB64=${pathB64}${tokenParam}`;
  return {
    url: `${base}/api/stream/${encodeURIComponent(trackId)}/playlist.m3u8?quality=${quality}${tokenParam}`,
    rawUrl: `${base}/api/stream?pathB64=${pathB64}${tokenParam}`,
    artUrl,
  };
}
