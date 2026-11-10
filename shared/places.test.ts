import { countryCode, countryName, languageCode, languageName, placeFromTag } from './places';

test('one country however a tag names it, in any of the common languages', () => {
  for (const tag of ['danish', 'Dansk', 'Denmark', 'danmark', 'DK', 'Dänemark', 'danois']) expect(placeFromTag(tag)).toBe('DK');
  for (const tag of ['german', 'deutsch', 'Germany', 'tysk']) expect(placeFromTag(tag)).toBe('DE');
  for (const tag of ['dutch', 'nederlands', 'netherlands', 'Holland']) expect(placeFromTag(tag)).toBe('NL');
  for (const tag of ['american', 'USA', 'United States', 'estados unidos']) expect(placeFromTag(tag)).toBe('US');
  for (const tag of ['british', 'UK', 'United Kingdom', 'england', 'english', 'scottish']) expect(placeFromTag(tag)).toBe('GB');
  expect(placeFromTag('swedish')).toBe('SE');
  expect(placeFromTag('norsk')).toBe('NO');
  expect(placeFromTag('irish')).toBe('IE');
  expect(placeFromTag('japanese')).toBe('JP');
});

test('music words and non-places are not places', () => {
  for (const tag of ['indie', 'latin', 'soul', 'world', 'country', 'electronic', 'female vocalists', '80s', 'scandinavian', 'european', 'seen live', 'georgia', 'jersey'])
    expect(placeFromTag(tag)).toBeNull();
});

test('countries from codes and names; languages from ISO 639-1/-2 codes and names', () => {
  expect(countryCode('Denmark')).toBe('DK');
  expect(countryCode('dk')).toBe('DK');
  expect(countryCode('XE')).toBeNull();
  expect(countryCode('XW')).toBeNull();
  expect(countryCode('Copenhagen')).toBeNull();
  expect(languageCode('dan')).toBe('da');
  expect(languageCode('da')).toBe('da');
  expect(languageCode('eng')).toBe('en');
  expect(languageCode('ger')).toBe('de');
  expect(languageCode('deu')).toBe('de');
  expect(languageCode('nob')).toBe('no');
  expect(languageCode('dansk')).toBe('da');
  expect(languageCode('zxx')).toBeNull();
  expect(languageCode('und')).toBeNull();
  expect(countryName('DK')).toBe('Denmark');
  expect(languageName('da')).toBe('Danish');
});
