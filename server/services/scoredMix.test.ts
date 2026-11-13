/** @jest-environment node */
jest.mock('../database', () => ({ initDB: jest.fn() }));
jest.mock('../utils/db', () => ({ queryWithRetry: jest.fn() }));
import { leadArtistKey } from './scoredMix.service';

test('an artist counts under the lead name of each credit', () => {
  for (const credit of ['ATB', 'ATB feat. JanSoon', 'ATB & Sean Ryan', 'ATB, Amurai & Melissa Loretta', 'ATB with Dash Berlin']) {
    expect(leadArtistKey(credit)).toBe('atb');
  }
  expect(leadArtistKey('Above & Beyond feat. Alex Vargas')).toBe(leadArtistKey('Above & Beyond'));
  expect(leadArtistKey('Tiësto')).toBe('tiesto');
});
