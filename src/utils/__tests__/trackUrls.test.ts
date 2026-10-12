import { buildTrackUrls, withMediaToken } from '../trackUrls';

const origin = window.location.origin;

describe('buildTrackUrls', () => {
  it('keeps an API v1 track\'s artwork URL on rebuild, with the fresh token', () => {
    // As toLegacyTrack builds it: the API's artwork URL plus the old media token.
    const current = `${origin}/api/v1/artwork/art-1?size=300&token=old-token`;
    const rebuilt = buildTrackUrls('t1', 'api-v1:t1', 'new token', 'auto', undefined, current);
    const art = new URL(rebuilt.artUrl!);
    expect(art.pathname).toBe('/api/v1/artwork/art-1');
    expect(art.searchParams.get('size')).toBe('300');
    expect(art.searchParams.get('token')).toBe('new token');
  });

  it('prefers the content hash, and has no cover only when there never was one', () => {
    expect(buildTrackUrls('t1', 'api-v1:t1', 'tok', 'auto', 'abc', `${origin}/api/v1/artwork/x`).artUrl)
      .toBe(`${origin}/api/art?hash=abc&token=tok`);
    expect(buildTrackUrls('t1', 'api-v1:t1', 'tok', 'auto').artUrl).toBeUndefined();
  });

  it('leaves library-path tracks on the path-addressed cover as before', () => {
    expect(buildTrackUrls('t2', 'L2Evbi5mbGFj', 'tok', 'auto', undefined, 'ignored').artUrl)
      .toBe(`${origin}/api/art?pathB64=L2Evbi5mbGFj&token=tok`);
  });
});

test('withMediaToken replaces or removes only the token', () => {
  expect(withMediaToken('/api/v1/artwork/a?token=x&size=1', 'y')).toBe(`${origin}/api/v1/artwork/a?token=y&size=1`);
  expect(withMediaToken('/api/v1/artwork/a?token=x', '')).toBe(`${origin}/api/v1/artwork/a`);
});
