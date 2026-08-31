jest.mock('sharp', () => jest.fn());
jest.mock('../database', () => ({ initDB: jest.fn() }));

import path from 'path';
import { artCachePath, ART_CACHE_DIR, DEFAULT_ART_SIZE, isValidArtSize } from './artCache';

/**
 * Both HTTP surfaces that reach artCachePath validate the id against an
 * anchored /^[0-9a-f]{1,64}$/ allowlist, so traversal is already unreachable.
 * These tests pin the containment guarantee at the filesystem call itself, so a
 * later change to the id scheme cannot quietly turn a cache lookup into an
 * arbitrary read.
 */
describe('artCachePath containment', () => {
  const inside = (file: string) => file === ART_CACHE_DIR || file.startsWith(ART_CACHE_DIR + path.sep);

  it('resolves a valid hash inside the cache directory', () => {
    const file = artCachePath('a'.repeat(64), DEFAULT_ART_SIZE);
    expect(inside(file)).toBe(true);
    expect(path.isAbsolute(file)).toBe(true);
    expect(file.endsWith(`_${DEFAULT_ART_SIZE}.avif`)).toBe(true);
  });

  it('shards by the first two characters', () => {
    const file = artCachePath('abcdef', DEFAULT_ART_SIZE);
    expect(path.dirname(file)).toBe(path.join(ART_CACHE_DIR, 'ab'));
  });

  // These cannot reach the helper through either route today. They are the
  // shapes that would arrive if the id allowlist were ever relaxed.
  it.each([
    ['parent traversal', '../../../etc/passwd'],
    ['dot segments', '..'],
    ['trailing separator traversal', '../'],
    ['embedded traversal', 'ab/../../../etc/passwd'],
  ])('refuses an id that would escape the cache directory: %s', (_label, hash) => {
    expect(() => artCachePath(hash, DEFAULT_ART_SIZE)).toThrow(/escapes the cache directory/);
  });

  // path.join treats a leading separator as an ordinary one — unlike
  // path.resolve, where an absolute-looking segment would discard everything
  // before it and escape. These ids are nonsense but land harmlessly inside the
  // cache, so containment allows them rather than throwing.
  it.each([
    ['absolute-looking id', '/etc/passwd'],
    ['nested separator', 'ab/cd'],
  ])('permits a contained id even when it is nonsense: %s', (_label, hash) => {
    const file = artCachePath(hash, DEFAULT_ART_SIZE);
    expect(inside(file)).toBe(true);
  });

  it('never returns a path outside the cache directory, whatever it is given', () => {
    const payloads = [
      '../../../etc/passwd', '..', '../', 'ab/../../../etc/passwd', '/etc/passwd',
      'ab/cd', 'ab', 'a'.repeat(64), 'ABCDEF', 'ab.cd', 'ab-cd',
    ];
    for (const hash of payloads) {
      let file: string | null = null;
      try {
        file = artCachePath(hash, DEFAULT_ART_SIZE);
      } catch {
        continue; // refused outright, which is the desired outcome
      }
      expect(inside(file)).toBe(true);
    }
  });

  it('only accepts known artwork sizes, so the size cannot inject either', () => {
    expect(isValidArtSize(DEFAULT_ART_SIZE)).toBe(true);
    for (const bad of ['256', -1, 1e9, '../..', NaN, Infinity]) {
      expect(isValidArtSize(bad as never)).toBe(false);
    }
  });
});
