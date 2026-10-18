import { firstTagValue, joinTagValues, splitTagValues } from './tagValues';

describe('splitTagValues', () => {
  it('splits NUL-separated values instead of gluing them', () => {
    expect(splitTagValues('Sebastian Ingrosso\0Steve Angello')).toEqual(['Sebastian Ingrosso', 'Steve Angello']);
  });

  it('flattens lists, trims and drops empty values and non-strings', () => {
    expect(splitTagValues(['House\0 Electro ', '', '\0', 42, null, 'Trance'])).toEqual(['House', 'Electro', 'Trance']);
  });

  it('returns nothing for a missing tag', () => {
    expect(splitTagValues(undefined)).toEqual([]);
  });
});

describe('joinTagValues', () => {
  it('keeps a Picard display credit and drops the individual artists it already names', () => {
    expect(joinTagValues('Headhunterz Vs. Wildstylez\0Headhunterz\0Wildstylez')).toBe('Headhunterz Vs. Wildstylez');
  });

  it('joins separate values as a comma list the artist splitter understands', () => {
    expect(joinTagValues('Headhunterz\0Wildstylez')).toBe('Headhunterz, Wildstylez');
  });

  it('leaves single values unchanged and returns null when empty', () => {
    expect(joinTagValues('Hall & Oates')).toBe('Hall & Oates');
    expect(joinTagValues(['', '\0'])).toBeNull();
    expect(joinTagValues(undefined)).toBeNull();
  });

  it('uses the given separator for titles', () => {
    expect(joinTagValues('Part One\0Part Two', ' / ')).toBe('Part One / Part Two');
  });
});

describe('firstTagValue', () => {
  it('takes the first id from a list or a NUL-separated string', () => {
    expect(firstTagValue(['79dbc936', '43fca023'])).toBe('79dbc936');
    expect(firstTagValue('79dbc936\u000043fca023')).toBe('79dbc936');
    expect(firstTagValue(undefined)).toBeNull();
  });
});
