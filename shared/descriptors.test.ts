import { descriptorLabel, descriptorOf, eraOf, moodOf, vocalsOf } from './descriptors';

test('vocals, however a tag says it', () => {
  for (const tag of ['female vocalists', 'Female Vocalist', 'female vocals', 'female', 'Female fronted metal', 'girl group', 'kvindelig vokal'])
    expect(descriptorOf(tag)).toEqual({ kind: 'vocals', value: 'female' });
  for (const tag of ['male vocalists', 'male vocalist', 'boy band', 'boybands'])
    expect(descriptorOf(tag)).toEqual({ kind: 'vocals', value: 'male' });
  expect(vocalsOf('kvindelige vokaler')).toBe('female');
  expect(vocalsOf('female')).toBe('female');
  expect(vocalsOf('alto')).toBeNull();
});

test('moods in English and the Scandinavian spellings', () => {
  for (const tag of ['chillout', 'Chill-out', 'chill', 'mellow', 'rolig']) expect(descriptorOf(tag)).toEqual({ kind: 'mood', value: 'chill' });
  for (const tag of ['melancholic', 'sad', 'trist', 'melankolsk']) expect(descriptorOf(tag)).toEqual({ kind: 'mood', value: 'melancholic' });
  expect(descriptorOf('Uplifting')).toEqual({ kind: 'mood', value: 'uplifting' });
  expect(descriptorOf('party')).toEqual({ kind: 'mood', value: 'party' });
  expect(moodOf('funky')).toBe('funky');
  expect(moodOf('glade')).toBe('uplifting');
  expect(moodOf('electronic')).toBeNull();
  expect(descriptorLabel('mood', 'melancholic')).toBe('Melancholic');
});

test('eras in every spelling tags use', () => {
  for (const tag of ['80s', "80's", '1980s', 'eighties', '80er', "80'erne", 'firserne']) expect(eraOf(tag)).toBe(1980);
  expect(eraOf('90s')).toBe(1990);
  expect(eraOf('00s')).toBe(2000);
  expect(eraOf('10s')).toBe(2010);
  expect(eraOf('2010s')).toBe(2010);
  expect(eraOf('2020s')).toBe(2020);
  expect(eraOf('20s')).toBe(1920);
  expect(eraOf('oldies')).toBeNull();
  expect(eraOf('80s pop')).toBeNull();
  expect(descriptorOf('70s')).toEqual({ kind: 'era', value: '1970' });
});

test('genres and noise are not descriptors', () => {
  for (const tag of ['electronic', 'seen live', 'All', 'spotify', 'danish', 'singer-songwriter']) expect(descriptorOf(tag)).toBeNull();
});
