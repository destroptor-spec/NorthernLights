import { isChristmasSeason, christmasExclusionSql, isChristmasRow } from './seasonalFilter';

describe('seasonalFilter', () => {
  describe('isChristmasSeason (Dec 1 – Jan 5)', () => {
    it.each([
      ['Dec 1', new Date(2026, 11, 1), true],
      ['Dec 15', new Date(2026, 11, 15), true],
      ['Dec 31', new Date(2026, 11, 31), true],
      ['Jan 1', new Date(2026, 0, 1), true],
      ['Jan 5 (Epiphany eve)', new Date(2026, 0, 5), true],
      ['Jan 6 (out)', new Date(2026, 0, 6), false],
      ['Nov 30 (out)', new Date(2026, 10, 30), false],
      ['mid-July (out)', new Date(2026, 6, 15), false],
    ])('%s → %s', (_label, date, expected) => {
      expect(isChristmasSeason(date as Date)).toBe(expected);
    });
  });

  describe('christmasExclusionSql (gated on the current date)', () => {
    afterEach(() => jest.useRealTimers());

    it('emits genre + album exclusions off-season', () => {
      jest.useFakeTimers().setSystemTime(new Date(2026, 6, 15)); // July
      const sql = christmasExclusionSql('t');
      expect(sql).toContain("t.genre, '') !~* '(christmas|xmas|holiday|noel)'");
      expect(sql).toContain("t.album, '') !~* '(christmas|xmas|noel)'");
    });

    it('emits nothing during the season', () => {
      jest.useFakeTimers().setSystemTime(new Date(2026, 11, 25)); // Dec 25
      expect(christmasExclusionSql('t')).toBe('');
    });

    it('respects the given alias', () => {
      jest.useFakeTimers().setSystemTime(new Date(2026, 6, 15));
      expect(christmasExclusionSql('sm')).toContain("sm.genre");
    });
  });

  describe('isChristmasRow', () => {
    it('flags Christmas genre/album (case-insensitive)', () => {
      expect(isChristmasRow({ genre: 'Christmas' })).toBe(true);
      expect(isChristmasRow({ genre: 'Holiday' })).toBe(true); // genre pattern includes holiday
      expect(isChristmasRow({ album: 'A Very Xmas Album' })).toBe(true);
      expect(isChristmasRow({ album_title: 'Noël'.replace('ë', 'e') })).toBe(true); // 'Noel'
    });

    it('does not flag non-Christmas content', () => {
      expect(isChristmasRow({ genre: 'Rock', album: 'Greatest Hits' })).toBe(false);
      // "Holiday" by Madonna: the album pattern deliberately omits "holiday".
      expect(isChristmasRow({ genre: 'Pop', album: 'Holiday' })).toBe(false);
      expect(isChristmasRow({})).toBe(false);
    });
  });
});
