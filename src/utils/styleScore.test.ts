import { scoreWord } from './styleScore';

test('says a style score in words, on the bands measured over the library', () => {
  expect([0.63, 0.5, 0.47, 0.3, 0.29, 0.15, 0.14, 0.05, 0.049, 0].map(scoreWord))
    .toEqual(['Strong', 'Strong', 'Clear', 'Clear', 'Noticeable', 'Noticeable', 'A hint', 'A hint', 'Faint', 'Faint']);
});
