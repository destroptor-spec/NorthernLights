import { isSameSong } from './recommendation.service';

// Infinity's repeat check: cases found playing Infinity on the dev library.
describe('isSameSong', () => {
  it('is the same song on another album, even with another recording id', () => {
    expect(isSameSong(
      { artist: 'Lady Gaga', title: 'Electric Chapel', mb_recording_id: 'eec596e9' },
      { artist: 'Lady Gaga', title: 'Electric Chapel', mb_recording_id: '493ea0d6' },
    )).toBe(true);
  });

  it('is the same song with a featured or joint credit', () => {
    expect(isSameSong({ artist: 'Sia', title: 'Hey Boy' }, { artist: 'Sia featuring Burna Boy', title: 'Hey Boy' })).toBe(true);
    expect(isSameSong({ artist: 'Shakira', title: 'Did It Again' }, { artist: 'Shakira, Kid Cudi', title: 'Did It Again' })).toBe(true);
    expect(isSameSong({ artist: 'Lady Gaga', title: 'Telephone' }, { artist: 'Lady Gaga', title: 'Telephone (feat. Beyoncé)' })).toBe(true);
  });

  it('ignores edition noise, case and accents', () => {
    expect(isSameSong({ artist: '2Pac', title: 'Fame' }, { artist: '2pac', title: 'Fame (Remastered)' })).toBe(true);
    expect(isSameSong({ artist: 'Björk', title: 'Jóga' }, { artist: 'Bjork', title: 'Joga' })).toBe(true);
  });

  it('is the same recording whatever the tags say', () => {
    expect(isSameSong({ artist: 'A', title: 'One', mb_recording_id: 'x1' }, { artist: 'B', title: 'Two', mb_recording_id: 'X1' })).toBe(true);
  });

  it('keeps remixes, other artists and other titles apart', () => {
    expect(isSameSong({ artist: 'Lady Gaga', title: 'Electric Chapel' }, { artist: 'Lady Gaga', title: 'Electric Chapel (Two Door Cinema Club remix)' })).toBe(false);
    expect(isSameSong({ artist: 'Adele', title: 'Hello' }, { artist: 'Lionel Richie', title: 'Hello' })).toBe(false);
    expect(isSameSong({ artist: 'Adele', title: 'Hello' }, { artist: 'Adele', title: 'Remedy' })).toBe(false);
    expect(isSameSong({ artist: 'Adele', title: '' }, { artist: 'Adele', title: '' })).toBe(false);
  });
});
