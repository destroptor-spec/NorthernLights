import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RaysSoundMap } from './RaysSoundMap';
import type { TrackRays } from '../../../shared/api/v1';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) }) as Response;
const originalFetch = global.fetch;
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

beforeAll(() => {
  // The test DOM has no layout: give the sky a 16:9 frame.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 450 });
});
afterAll(() => {
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth);
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalHeight);
  global.fetch = originalFetch;
});

const near = [
  { id: 'n1', title: 'Pause', artist: 'Fred again..', artworkId: null, artworkUrl: null },
  { id: 'n2', title: 'Signs of Life', artist: 'Pink Floyd', artworkId: null, artworkUrl: null },
] as unknown as NonNullable<TrackRays['soundsCloseTo']>['tracks'];

test('centres the sky on the track and puts each nearby track at its place, linking to its rays', async () => {
  global.fetch = jest.fn(async () => ok({
    status: 'ready', builtAt: '2026-11-27T20:05:42.000Z', trackCount: 3, points: [[0, 0], [1, 1], [-1, -1]], labels: [],
  })) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <RaysSoundMap position={{ x: 0, y: 0, near: [{ trackId: 'n1', x: 0.2, y: 0 }, { trackId: 'n2', x: 0, y: -0.2 }] }} cover={undefined} title="Great Falls" near={near} />
    </MemoryRouter>,
  );
  const stars = await screen.findByRole('list', { name: 'Tracks that sound closest' });
  const links = await within(stars).findAllByRole('link');
  expect(links.map(a => a.getAttribute('aria-label'))).toEqual(['Pause by Fred again..', 'Signs of Life by Pink Floyd']);
  expect(links[0].getAttribute('href')).toBe('/library/rays/n1');
  // n1 sits to the right of the centre, n2 below it.
  const [right, below] = links.map(a => (a.parentElement as HTMLElement).style);
  expect(parseFloat(right.left)).toBeGreaterThan(50);
  expect(parseFloat(right.top)).toBeCloseTo(50);
  expect(parseFloat(below.top)).toBeGreaterThan(50);
  expect(parseFloat(below.left)).toBeCloseTo(50);
  // The hover card names the track.
  expect(within(links[1]).getByText('Signs of Life')).toBeTruthy();
});
