import {
  cleanCreditPart,
  explodeListCredit,
  uniqueArtistNames,
  splitArtistNames,
  joinedCreditSplits,
  splitJoinedCredit,
  splitPeopleCredit,
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

    it('splits feat./ft. written without a space after the dot', () => {
      expect(splitArtistNames('Brooke Candy feat.Sia')).toEqual(['Brooke Candy', 'Sia']);
      expect(splitArtistNames('Eminem ft.Dido')).toEqual(['Eminem', 'Dido']);
      expect(splitArtistNames('Calvin Harris (feat.Rihanna)')).toEqual(['Calvin Harris', 'Rihanna']);
    });

    it('keeps names that merely contain feat/ft whole', () => {
      expect(splitArtistNames('Daft Punk')).toEqual(['Daft Punk']);
      expect(splitArtistNames('Feather Mae')).toEqual(['Feather Mae']);
      expect(splitArtistNames('Soft.Cell')).toEqual(['Soft.Cell']);
      expect(splitArtistNames('Defeat.Me')).toEqual(['Defeat.Me']);
      expect(splitArtistNames('Lady Feat.')).toEqual(['Lady Feat.']);
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

  describe('joinedCreditSplits / splitJoinedCredit', () => {
    const known = (...names: string[]) => (name: string) => names.map(n => n.toLowerCase()).includes(name.toLowerCase());

    it('lists the splits of a joined credit, most split first', () => {
      expect(joinedCreditSplits('Justin Timberlake & Timbaland')).toEqual([['Justin Timberlake', 'Timbaland']]);
      expect(joinedCreditSplits('Above & Beyond and Spencer Brown')).toEqual([
        ['Above', 'Beyond', 'Spencer Brown'],
        ['Above & Beyond', 'Spencer Brown'],
        ['Above', 'Beyond and Spencer Brown'],
      ]);
      expect(joinedCreditSplits('Timbaland')).toEqual([]);
      expect(joinedCreditSplits('Percy Faith and His Orchestra')).toEqual([]);
      expect(joinedCreditSplits('Timbaland Feat. Justin Timberlake & Nelly Furtado')).toEqual([]);
      expect(joinedCreditSplits(null)).toEqual([]);
    });

    it('splits only when every name is a known artist', () => {
      expect(splitJoinedCredit('Justin Timberlake & Timbaland', known('Justin Timberlake', 'Timbaland')))
        .toEqual(['Justin Timberlake', 'Timbaland']);
      expect(splitJoinedCredit('Justin Timberlake And Timbaland', known('justin timberlake', 'timbaland')))
        .toEqual(['Justin Timberlake', 'Timbaland']);
      expect(splitJoinedCredit('The Chainsmokers + Kygo', known('The Chainsmokers', 'Kygo')))
        .toEqual(['The Chainsmokers', 'Kygo']);
      expect(splitJoinedCredit('Matrix & Futurebound', known('Futurebound'))).toBeNull();
      expect(splitJoinedCredit('Florence and the Machine', known('Florence'))).toBeNull();
    });

    it('keeps a joined act whole inside a longer credit', () => {
      expect(splitJoinedCredit('Above & Beyond and Spencer Brown', known('Above & Beyond', 'Spencer Brown')))
        .toEqual(['Above & Beyond', 'Spencer Brown']);
    });
  });

  describe('splitPeopleCredit', () => {
    const known = (...names: string[]) => (name: string) => names.map(n => n.toLowerCase()).includes(name.toLowerCase());

    it('splits a comma list stored as one name when every name is a known artist', () => {
      expect(splitPeopleCredit('Morten Hampenberg, Alexander Brown', known('Morten Hampenberg', 'Alexander Brown')))
        .toEqual(['Morten Hampenberg', 'Alexander Brown']);
      expect(splitPeopleCredit('Tim McGraw, Taylor Swift & Keith Urban', known('Tim McGraw', 'Taylor Swift', 'Keith Urban')))
        .toEqual(['Tim McGraw', 'Taylor Swift', 'Keith Urban']);
      // The last name may be a joined act of its own.
      expect(splitPeopleCredit('Young Jeezy, Slick Pulla and Bloodraw', known('Young Jeezy', 'Slick Pulla and Bloodraw')))
        .toEqual(['Young Jeezy', 'Slick Pulla and Bloodraw']);
    });

    it('keeps names whose parts are not all artists whole', () => {
      expect(splitPeopleCredit('Tyler, the Creator', known('Tyler'))).toBeNull();
      expect(splitPeopleCredit('Earth, Wind & Fire', known('Earth'))).toBeNull();
      expect(splitPeopleCredit('Hank Williams, Jr.', known('Hank Williams'))).toBeNull();
      expect(splitPeopleCredit('Dimitri Vegas, Like Mike', known('Dimitri Vegas'))).toBeNull();
      expect(splitPeopleCredit('Justin Timberlake & Timbaland', known('Justin Timberlake', 'Timbaland'))).toBeNull();
      expect(splitPeopleCredit('A, B feat. C', known('A', 'B', 'C'))).toBeNull();
      expect(splitPeopleCredit(null, known())).toBeNull();
    });
  });
});
