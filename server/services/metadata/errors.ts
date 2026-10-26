export class RateLimitError extends Error {
  constructor(public provider: 'lastfm' | 'genius' | 'musicbrainz', retryAfter?: number) {
    super(`${provider} rate limited${retryAfter ? `, retry after ${retryAfter}s` : ''}`);
    this.name = 'RateLimitError';
  }
}

export class ProviderError extends Error {
  constructor(public provider: string, message: string, public statusCode?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/**
 * A caught error's message plus its underlying cause. Node's fetch reports
 * every network failure as "fetch failed" and keeps the reason (ETIMEDOUT,
 * ECONNRESET, ...) in `cause`, which the logs used to drop.
 */
export function messageWithCause(error: any): string {
  const message = String(error?.message || error || 'unknown error');
  const cause = error?.cause?.code || error?.cause?.message;
  return cause ? `${message} (cause: ${cause})` : message;
}
