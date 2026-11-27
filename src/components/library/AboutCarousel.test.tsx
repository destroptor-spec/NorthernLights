import { fireEvent, render, screen } from '@testing-library/react';
import { AboutCarousel } from './AboutCarousel';
import { AlbumAboutSection } from './AlbumAboutSection';

jest.mock('../AlbumArt', () => ({ AlbumArt: ({ artUrl }: { artUrl?: string }) => <img alt="" src={artUrl} /> }));

const images = [
  { url: 'https://assets.fanart.tv/a.jpg' },
  { url: 'https://assets.fanart.tv/b.jpg', label: 'Back' },
  { url: 'https://r2.theaudiodb.com/c.jpg' },
];
const current = (container: HTMLElement) => container.querySelector('.about-carousel__slide[data-active="true"]')?.getAttribute('aria-label');

it('shows one picture at a time through the image proxy, with a dot per picture centred in the frame', () => {
  const { container } = render(<AboutCarousel images={images} label="Pictures of Daysend" shape="wide" />);
  expect(screen.getByRole('group', { name: 'Pictures of Daysend' }).getAttribute('aria-roledescription')).toBe('carousel');
  expect(current(container)).toBe('1 of 3');
  expect(container.querySelector('.about-carousel__slide[data-active="true"] img')?.getAttribute('src'))
    .toBe(`/api/providers/external/proxy-image?url=${encodeURIComponent(images[0].url)}`);
  const dots = screen.getAllByRole('button', { name: /^Show picture/ });
  expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual(['Show picture 1 of 3', 'Show picture 2 of 3: Back', 'Show picture 3 of 3']);
  expect(dots[0].getAttribute('aria-current')).toBe('true');
  fireEvent.click(dots[1]);
  expect(current(container)).toBe('2 of 3');
  expect(dots[1].getAttribute('aria-current')).toBe('true');
});

it('steps with the arrow keys on the dots, wrapping round, and moves focus along', () => {
  const { container } = render(<AboutCarousel images={images} label="Pictures" shape="wide" />);
  const dots = screen.getAllByRole('button', { name: /^Show picture/ });
  fireEvent.keyDown(dots[0], { key: 'ArrowLeft' });
  expect(current(container)).toBe('3 of 3');
  expect(document.activeElement).toBe(dots[2]);
  fireEvent.keyDown(dots[2], { key: 'ArrowRight' });
  expect(current(container)).toBe('1 of 3');
  expect(dots[0].tabIndex).toBe(0);
  expect(dots[1].tabIndex).toBe(-1);
});

it('drops a picture that fails to load, has no dots for one picture, and nothing for none', () => {
  const { container, rerender } = render(<AboutCarousel images={images.slice(0, 2)} label="Pictures" shape="wide" />);
  fireEvent.error(container.querySelector('.about-carousel__slide[data-active="true"] img')!);
  expect(container.querySelectorAll('.about-carousel__slide')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /^Show picture/ })).toBeNull();
  fireEvent.error(container.querySelector('.about-carousel__slide img')!);
  expect(container.querySelector('.about-carousel')).toBeNull();
  rerender(<AboutCarousel images={[]} label="Pictures" shape="wide" />);
  expect(container.querySelector('.about-carousel')).toBeNull();
});

it('puts an album’s artwork beside the card’s text, after it in the DOM; no frame without artwork', () => {
  const { container, rerender } = render(
    <AlbumAboutSection title="Nevermind" artist="Nirvana" releaseType="Album" genres={['Grunge']} artworkImages={[{ url: 'https://coverartarchive.org/b.jpg', label: 'Back' }]} />,
  );
  const layout = container.querySelector('.about-card__layout')!;
  expect([...layout.children].map(child => child.className)).toEqual(['about-card__main', 'about-card__gallery']);
  expect(container.querySelector('.about-carousel[data-shape="square"] img')?.getAttribute('alt')).toBe('Back');
  expect(screen.getByRole('group', { name: 'Artwork of Nevermind' })).toBeTruthy();
  rerender(<AlbumAboutSection title="Nevermind" artist="Nirvana" releaseType="Album" genres={['Grunge']} artworkImages={[]} />);
  expect(container.querySelector('.about-card__layout')).toBeNull();
  expect(container.querySelector('.about-carousel')).toBeNull();
});
