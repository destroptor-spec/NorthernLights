import { isPlaybackSyncEnabled, parsePlaybackSyncMode } from './playbackSync';

test('the admin decides, and a user only when the admin left it to them', () => {
  expect(isPlaybackSyncEnabled('off', true)).toBe(false);
  expect(isPlaybackSyncEnabled('on', false)).toBe(true);
  expect(isPlaybackSyncEnabled('user', false)).toBe(false);
  expect(isPlaybackSyncEnabled('user', true)).toBe(true);
});

test('anything the server has not set, or does not know, is off', () => {
  for (const value of [null, undefined, '', 'sometimes', true]) expect(parsePlaybackSyncMode(value)).toBe('off');
  expect(parsePlaybackSyncMode('user')).toBe('user');
});
