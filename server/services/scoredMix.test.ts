/** @jest-environment node */
jest.mock('../database', () => ({ initDB: jest.fn() }));
jest.mock('../utils/db', () => ({ queryWithRetry: jest.fn() }));
import { baseTitle, leadArtistKey, versionKey } from './scoredMix.service';

test('an artist counts under the lead name of each credit', () => {
  for (const credit of ['ATB', 'ATB feat. JanSoon', 'ATB & Sean Ryan', 'ATB, Amurai & Melissa Loretta', 'ATB with Dash Berlin']) {
    expect(leadArtistKey(credit)).toBe('atb');
  }
  expect(leadArtistKey('Above & Beyond feat. Alex Vargas')).toBe(leadArtistKey('Above & Beyond'));
  expect(leadArtistKey('Tiësto')).toBe('tiesto');
});

test('versions of one song share a key', () => {
  expect(baseTitle('Hey Baby (Olav Basoski mix)')).toBe('hey baby');
  expect(baseTitle('Hey Baby - Radio Edit')).toBe('hey baby');
  expect(baseTitle('Dooms Night [Crookers Remix]')).toBe('dooms night');
  expect(versionKey({ artist: 'Melleefresh & deadmau5', title: 'Hey Baby (Starkillers & Dmitry KO club mix)' }))
    .toBe(versionKey({ artist: 'Melleefresh vs. deadmau5', title: 'Hey Baby' }));
  expect(versionKey({ artist: 'A', title: 'Hey Baby' })).not.toBe(versionKey({ artist: 'B', title: 'Hey Baby' }));
});
