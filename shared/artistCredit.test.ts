import {
  cleanCreditPart,
  explodeListCredit,
  uniqueArtistNames,
  splitArtistNames,
} from './artistCredit';

describe('shared/artistCredit', () => {
  describe('splitArtistNames', () => {
    it('returns [] for empty/nullish input', () => {
      expect(splitArtistNames(undefined)).toEqual([]);
      expect(splitArtistNames(null)).toEqual([]);
      expect(splitArtistNames('')).toEqual([]);
    });

    it('keeps a single artist whole', () => {
      expect(splitArtistNames('Fatboy Slim')).toEqual(['Fatboy Slim']);
    });

    it('splits feat./ft./featuring markers', () => {
      expect(splitArtistNames('Calvin Harris feat. Rihanna')).toEqual(['Calvin Harris', 'Rihanna']);
      expect(splitArtistNames('Eminem ft. Dido')).toEqual(['Eminem', 'Dido']);
      expect(splitArtistNames('Robin Schulz featuring Jasmine Thompson')).toEqual([
        'Robin Schulz',
        'Jasmine Thompson',
      ]);
    });

    it('splits comma lists including the final Oxford "&"', () => {
      expect(splitArtistNames('Alok, Martin Jensen & Jason Derulo')).toEqual([
        'Alok',
        'Martin Jensen',
        'Jason Derulo',
      ]);
    });

    it('preserves genuine group names with bare "&" / "and" (no comma)', () => {
      expect(splitArtistNames('Nick & Jay')).toEqual(['Nick & Jay']);
      expect(splitArtistNames('Hall & Oates')).toEqual(['Hall & Oates']);
      expect(splitArtistNames('Florence and the Machine')).toEqual(['Florence and the Machine']);
    });

    it('dedupes case-insensitively, first-seen order wins', () => {
      expect(splitArtistNames('Drake feat. Drake')).toEqual(['Drake']);
    });
  });

  describe('cleanCreditPart', () => {
    it('trims and strips wrapping brackets/parens', () => {
      expect(cleanCreditPart('  (Rihanna)  ')).toBe('Rihanna');
      expect(cleanCreditPart('[The Weeknd]')).toBe('The Weeknd');
    });
  });

  describe('explodeListCredit', () => {
    it('keeps a comma-free part intact', () => {
      expect(explodeListCredit('Nick & Jay')).toEqual(['Nick & Jay']);
    });
    it('splits a comma list with a final ampersand', () => {
      expect(explodeListCredit('A, B & C')).toEqual(['A', 'B', 'C']);
    });
  });

  describe('uniqueArtistNames', () => {
    it('re-cleans and dedupes', () => {
      expect(uniqueArtistNames(['(Drake)', 'Drake', 'drake', ''])).toEqual(['Drake']);
    });
  });
});
