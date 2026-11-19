import { normalizeArtistIdentityKey } from './artistIdentity';
import { normalizeArtistIdentityKey as clientKey } from '../src/utils/artistUtils';

it('folds spellings of one artist to one key', () => {
  expect(normalizeArtistIdentityKey("N'to")).toBe('nto');
  expect(normalizeArtistIdentityKey('NTO')).toBe('nto');
  expect(normalizeArtistIdentityKey('N’to')).toBe('nto');
  expect(normalizeArtistIdentityKey('Simon & Garfunkel')).toBe(normalizeArtistIdentityKey('Simon and Garfunkel'));
  expect(normalizeArtistIdentityKey('Björk')).toBe('bjork');
  expect(normalizeArtistIdentityKey('AC/DC')).toBe('acdc');
});

it('has no key for a name without Latin letters or digits', () => {
  expect(normalizeArtistIdentityKey('坂本龍一')).toBe('');
  expect(normalizeArtistIdentityKey(null)).toBe('');
});

it('is the one the client uses', () => {
  expect(clientKey).toBe(normalizeArtistIdentityKey);
});
