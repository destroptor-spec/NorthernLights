import { render, screen, within } from '@testing-library/react';
import { AlbumAboutSection } from './AlbumAboutSection';

jest.mock('../AlbumArt', () => ({ AlbumArt: ({ artUrl }: { artUrl?: string }) => <img alt="" src={artUrl} /> }));

const album = (patch: Partial<React.ComponentProps<typeof AlbumAboutSection>> = {}) => (
  <AlbumAboutSection title="Wasting Light" artist="Foo Fighters" releaseType="Album" genres={[]} {...patch} />
);

it('is a card like the artist’s: the cover, the title with kind, artist and year, then Description and Tags', () => {
  const { container } = render(album({
    year: 2011,
    artUrl: '/api/art/abc',
    description: 'The seventh studio album by Foo Fighters.',
    genres: ['Rock', 'Alternative Rock'],
    tags: ['rock', 'grunge', 'foo fighters'],
  }));

  const section = screen.getByRole('region', { name: 'About Wasting Light' });
  expect(container.querySelector('.about-card__portrait[data-shape="square"] img')?.getAttribute('src')).toBe('/api/art/abc');
  expect(within(section).getByText('Wasting Light', { selector: '.about-card__name' })).toBeTruthy();
  expect(within(section).getByText('Album · Foo Fighters · 2011')).toBeTruthy();
  expect(within(section).getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['Description', 'Tags']);
  expect(within(section).getByText('The seventh studio album by Foo Fighters.')).toBeTruthy();

  // The files' genres first, then Last.fm's tags, each once (Rock and rock are one).
  const tags = within(section).getByRole('list', { name: 'Tags' });
  expect(within(tags).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Rock', 'Alternative Rock', 'grunge', 'foo fighters']);
  expect(within(tags).getByText('Rock').getAttribute('title')).toBe('From your files');
  expect(within(tags).getByText('grunge').getAttribute('title')).toBe('From Last.fm');
});

it('leaves out what it has nothing for, and the whole card with neither text nor tags', () => {
  const { rerender } = render(album({ description: 'Short.' }));
  expect(screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['Description']);
  expect(screen.getByText('Album · Foo Fighters')).toBeTruthy();

  rerender(album());
  expect(screen.queryByRole('region', { name: 'About Wasting Light' })).toBeNull();
});

it('opens with At a glance, written from the release its files are tagged with', () => {
  render(album({
    description: 'The seventh studio album.',
    release: { label: 'RCA Records', releaseDate: '2011-04-12', originalDate: '2011-04-12', media: 'CD' },
  }));
  expect(screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['At a glance', 'Description']);
  expect(screen.getByText(/^Wasting Light is an album/).textContent)
    .toBe('Wasting Light is an album by Foo Fighters, released on 12 April 2011 by RCA Records. Your copy is the CD release.');
});

it('shows the card for release facts alone', () => {
  render(album({ release: { label: null, releaseDate: null, originalDate: null, media: '12" Vinyl' } }));
  expect(screen.getByText('Your copy is the 12″ vinyl release.')).toBeTruthy();
});
