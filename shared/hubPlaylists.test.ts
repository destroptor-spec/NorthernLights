import { normalizeHubPlaylistCount, specialListCount } from './hubPlaylists';

test('the Hub makes 2, 3, 6 or 9 AI playlists; an old 5 becomes 6', () => {
  expect([2, 3, 6, 9].map(normalizeHubPlaylistCount)).toEqual([2, 3, 6, 9]);
  expect(normalizeHubPlaylistCount(5)).toBe(6);
  expect(normalizeHubPlaylistCount('3')).toBe(3);
  expect(normalizeHubPlaylistCount(1)).toBe(2);
  expect(normalizeHubPlaylistCount(20)).toBe(9);
  expect(normalizeHubPlaylistCount(undefined)).toBe(3);
});

test('up to 1, 1, 2 or 3 of them are special lists', () => {
  expect([2, 3, 6, 9].map(specialListCount)).toEqual([1, 1, 2, 3]);
  expect(specialListCount(5)).toBe(2);
});
