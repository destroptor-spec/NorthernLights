import { MENU_EDGE_MARGIN as M, placeMenu, type MenuPlacement, type MenuSize } from '../ContextMenu';

const viewport = { width: 1183, height: 746 };

function expectOnScreen(placed: MenuPlacement, size: MenuSize) {
  const height = placed.maxHeight ?? size.height;
  expect(placed.left).toBeGreaterThanOrEqual(M);
  expect(placed.top).toBeGreaterThanOrEqual(M);
  expect(placed.left + size.width).toBeLessThanOrEqual(viewport.width - M);
  expect(placed.top + height).toBeLessThanOrEqual(viewport.height - M);
}

describe('placeMenu at a point (a click or right-click)', () => {
  const track = { width: 248, height: 480 };

  test('opens down and to the right where there is room', () => {
    const placed = placeMenu({ size: track, viewport, point: { x: 200, y: 100 } });
    expect(placed).toEqual({ left: 200, top: 100, origin: 'top left' });
  });

  test('the ⋯ of a queue row in the bottom-right corner: opens up and to the left, all of it on screen', () => {
    const point = { x: 1150, y: 600 };
    const placed = placeMenu({ size: track, viewport, point });
    expect(placed).toEqual({ left: point.x - track.width, top: point.y - track.height, origin: 'bottom right' });
    expectOnScreen(placed, track);
  });

  test('with room neither below nor above, it moves up just enough', () => {
    const size = { width: 248, height: 600 };
    const placed = placeMenu({ size, viewport, point: { x: 200, y: 300 } });
    expect(placed.top).toBe(viewport.height - size.height - M);
    expect(placed.maxHeight).toBeUndefined();
    expectOnScreen(placed, size);
  });

  test('a menu taller than the window is pinned to the top and scrolls', () => {
    const size = { width: 248, height: 900 };
    const placed = placeMenu({ size, viewport, point: { x: 200, y: 400 } });
    expect(placed.top).toBe(M);
    expect(placed.maxHeight).toBe(viewport.height - 2 * M);
    expectOnScreen(placed, size);
  });
});

describe('placeMenu on a button', () => {
  const size = { width: 248, height: 200 };

  test('hangs below it, right-aligned by default', () => {
    const anchor = { left: 600, right: 640, top: 100, bottom: 140 };
    expect(placeMenu({ size, viewport, anchor })).toEqual({ left: 640 - 248, top: 148, origin: 'top right' });
  });

  test('flips above a button near the bottom', () => {
    const anchor = { left: 100, right: 140, top: 680, bottom: 720 };
    const placed = placeMenu({ size, viewport, anchor, align: 'left' });
    expect(placed).toEqual({ left: 100, top: 680 - 8 - 200, origin: 'bottom left' });
  });

  test("'above' (the player bar) stays above while it fits, and goes below when only that fits", () => {
    const bar = { left: 700, right: 740, top: 690, bottom: 730 };
    expect(placeMenu({ size, viewport, anchor: bar, placement: 'above' }).origin).toBe('bottom right');
    const nearTop = { left: 700, right: 740, top: 40, bottom: 80 };
    const placed = placeMenu({ size, viewport, anchor: nearTop, placement: 'above' });
    expect(placed.top).toBe(88);
    expectOnScreen(placed, size);
  });
});
