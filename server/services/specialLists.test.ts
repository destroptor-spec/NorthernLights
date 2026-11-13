import { assembleMenu, conceptForTheme, menuForAi, themeMinimums, type Theme } from './specialLists.service';

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

const style = (id: number, songs: number, recentPlays = 0): Theme =>
  ({ key: `style:${id}`, kind: 'style', label: `S${id}`, genre: 'Electronic', styleId: id, styleName: `S${id}`, songs, artists: 20, recentPlays });

test('the menu ranks by recent plays, then depth', () => {
  const menu = assembleMenu([style(1, 100), style(2, 1000), style(3, 50, 30)]);
  expect(menu.map(t => t.key)).toEqual(['style:3', 'style:2', 'style:1']);
});

test('recent themes stay off while enough others remain; a small library takes turns', () => {
  const big = Array.from({ length: 10 }, (_, i) => style(i + 1, 100 + i));
  // Plenty left: every recent theme is left out.
  expect(assembleMenu(big, { recentKeys: ['style:10', 'style:9'], keepAtLeast: 2 }).map(t => t.key)).not.toContain('style:10');
  // Two themes, one list wanted: yesterday's theme stays off, the other is made.
  const two = [style(1, 100), style(2, 200)];
  expect(assembleMenu(two, { recentKeys: ['style:2'], keepAtLeast: 1 }).map(t => t.key)).toEqual(['style:1']);
  // Both made recently: the older one comes back.
  expect(assembleMenu(two, { recentKeys: ['style:1', 'style:2'], keepAtLeast: 1 }).map(t => t.key)).toEqual(['style:2']);
  // A recent theme just past the limit does not slip in when others leave.
  const menu = assembleMenu(big, { recentKeys: ['style:1', 'style:10'], keepAtLeast: 1, limit: 9 });
  expect(menu.map(t => t.key)).not.toContain('style:1');
});
