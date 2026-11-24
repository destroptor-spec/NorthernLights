import { render } from '@testing-library/react';
import { AlbumCoverDisc } from './AlbumCoverDisc';

jest.mock('../AlbumArt', () => ({ AlbumArt: () => <img alt="" /> }));
const disc = { mediumUrl: undefined as string | undefined, frontUrl: undefined };
jest.mock('../../hooks/useDiscImage', () => ({ useDiscImage: () => disc }));

const rendered = (media?: string | null) => render(<AlbumCoverDisc artUrl="/api/art/x" artist="A" album="B" media={media} />).container.querySelector('.album-disc')!;

it('makes the made-up disc a CD when the files are tagged as one, a record otherwise', () => {
  expect(rendered('CD').getAttribute('data-medium')).toBe('cd');
  expect(rendered('Enhanced CD').getAttribute('data-medium')).toBe('cd');
  expect(rendered('12" Vinyl').getAttribute('data-medium')).toBeNull();
  expect(rendered('Digital Media').getAttribute('data-medium')).toBeNull();
  expect(rendered(undefined).getAttribute('data-medium')).toBeNull();
});

it('keeps a real disc scan whatever the medium', () => {
  disc.mediumUrl = 'https://coverartarchive.org/release/x/medium.jpg';
  const el = rendered('CD');
  expect(el.getAttribute('data-synthetic')).toBe('false');
  expect(el.getAttribute('data-medium')).toBeNull();
  disc.mediumUrl = undefined;
});
