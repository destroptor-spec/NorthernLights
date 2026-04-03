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
