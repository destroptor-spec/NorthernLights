import React from 'react';
import { render } from '@testing-library/react';
import { AuroraCover, sublabelLayout, systemDecadeGenreCoverLabel, systemPlaylistCover } from './AuroraCover';

test('a decade-genre title gives its style; a plain decade none', () => {
  expect(systemDecadeGenreCoverLabel("House from the 2010's")).toBe('House');
  expect(systemDecadeGenreCoverLabel("Progressive House from the 2020's")).toBe('Progressive House');
  expect(systemDecadeGenreCoverLabel("The 2010's")).toBeUndefined();
});

test('each Discover family keeps its cover, seeded by title; other playlists have none', () => {
  expect(systemPlaylistCover('engine_decade-genre-2010-house_u1', "House from the 2010's"))
    .toEqual({ variant: 'decade', seed: "House from the 2010's", label: '2010', sublabel: 'House' });
  expect(systemPlaylistCover('engine_decade-2010_u1', "The 2010's")).toEqual({ variant: 'decade', seed: "The 2010's", label: '2010', sublabel: undefined });
  expect(systemPlaylistCover('engine_genre-most-trance_u1', 'Your Trance favourites')).toMatchObject({ variant: 'favourites', label: 'Trance' });
  expect(systemPlaylistCover('engine_genre-stale-trance_u1', 'Rediscover Trance')).toMatchObject({ variant: 'rediscover', label: 'Trance' });
  expect(systemPlaylistCover('engine_upnext_u1', 'Up Next')).toBeNull();
  expect(systemPlaylistCover('llm_1', "House from the 2010's")).toBeNull();
});

test('the style line shrinks to fit, then wraps, and is never squeezed', () => {
  expect(sublabelLayout('House')).toEqual({ lines: ['House'], fontSize: 22 });
  const prog = sublabelLayout('Progressive House');
  expect(prog.lines).toEqual(['Progressive House']);
  expect(prog.fontSize).toBeGreaterThanOrEqual(17);
  expect(prog.fontSize).toBeLessThan(22);
  expect(sublabelLayout('Contemporary Jazz Fusion Revival').lines).toEqual(['Contemporary Jazz', 'Fusion Revival']);
});

test('a decade-genre cover prints the style under the numeral', () => {
  const { container, rerender } = render(<AuroraCover variant="decade" seed="x" label="2010" sublabel="Progressive House" />);
  const texts = () => [...container.querySelectorAll('text')];
  expect(texts().map(t => t.textContent)).toEqual(['2010', 'Progressive House']);
  expect(container.querySelector('[textLength]')).toBeNull();
  rerender(<AuroraCover variant="decade" seed="x" label="2010" />);
  expect(texts().map(t => t.textContent)).toEqual(['2010']);
});
