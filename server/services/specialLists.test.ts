import { conceptForTheme, menuForAi, themeMinimums } from './specialLists.service';

const pick = { title: 'Danish Rap Commute', description: 'x', target_vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] };

test('a theme needs twice the playlist length in songs, from half as many artists', () => {
  expect(themeMinimums(20)).toEqual({ songs: 40, artists: 10 });
  expect(themeMinimums(5)).toEqual({ songs: 10, artists: 3 });
});

test('a theme becomes a concept: its style or genre as target, its country or decade as hard filters', () => {
  const place = conceptForTheme({ key: 'place:Hip Hop:DK', kind: 'place', label: 'Hip Hop · Denmark', genre: 'Hip Hop', country: 'DK', songs: 667, artists: 22, recentPlays: 4 }, pick);
  expect(place).toMatchObject({ title: 'Danish Rap Commute', target_genres: ['Hip Hop'], countries: ['DK'], banned_genres: [] });
  expect(place).not.toHaveProperty('year_from');
  const era = conceptForTheme({ key: 'era:7:1990', kind: 'era', label: 'Eurodance · 1990s', genre: 'Electronic', styleId: 7, styleName: 'Eurodance', decade: 1990, songs: 50, artists: 20, recentPlays: 0 }, pick);
  expect(era).toMatchObject({ target_genres: ['Eurodance'], year_from: 1990, year_to: 1999 });
  const activity = conceptForTheme({ key: 'activity:focus', kind: 'activity', label: 'Focus', activity: 'focus', songs: 700, artists: 200, recentPlays: 0 }, pick);
  expect(activity.target_genres).toEqual([]);
  expect(activity.special.activity).toBe('focus');
});

test('the AI sees each theme by key, with what an activity means', () => {
  const [entry] = menuForAi([{ key: 'activity:focus', kind: 'activity', label: 'Focus', activity: 'focus', songs: 700, artists: 200, recentPlays: 0 }]);
  expect(entry).toMatchObject({ key: 'activity:focus', label: 'Focus' });
  expect(entry.describe).toMatch(/instrumental/);
});
