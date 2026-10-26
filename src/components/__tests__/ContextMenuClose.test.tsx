import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { ContextMenuPortal, POPOVER_CLOSE_MS, SHEET_CLOSE_MS } from '../ContextMenu';

/**
 * Andreas, 2026-10-27: menus (the Connect card first) fade away instead of
 * vanishing. The content stays as it was while it fades, and takes no taps.
 */
const Menu: React.FC<{ open: boolean; label: string }> = ({ open, label }) => (
  <ContextMenuPortal open={open} onClose={() => undefined}>
    {() => <div>{label}</div>}
  </ContextMenuPortal>
);

const setWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
const width = window.innerWidth;
let reducedMotion = false;

beforeEach(() => {
  jest.useFakeTimers();
  reducedMotion = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce') && reducedMotion, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});
afterEach(() => {
  jest.useRealTimers();
  setWidth(width);
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

test('the popover fades away, showing what it showed, before it goes', () => {
  setWidth(1280);
  const view = render(<Menu open label="Cast to a device" />);
  act(() => { jest.runOnlyPendingTimers(); });
  view.rerender(<Menu open={false} label="changed after closing" />);
  const menu = screen.getByText('Cast to a device').parentElement as HTMLElement;
  expect(menu.style.opacity).toBe('0');
  expect(menu.style.pointerEvents).toBe('none');
  expect(screen.queryByText('changed after closing')).toBeNull();
  act(() => { jest.advanceTimersByTime(POPOVER_CLOSE_MS); });
  expect(screen.queryByText('Cast to a device')).toBeNull();
});

test("the phone's sheet slides down and its backdrop fades, taking no taps", () => {
  setWidth(390);
  const view = render(<Menu open label="This device" />);
  view.rerender(<Menu open={false} label="This device" />);
  const backdrop = document.body.querySelector('.fixed.inset-0') as HTMLElement;
  expect(backdrop.style.opacity).toBe('0');
  expect(backdrop.style.pointerEvents).toBe('none');
  expect(screen.getByText('This device')).toBeTruthy();
  act(() => { jest.advanceTimersByTime(SHEET_CLOSE_MS - 1); });
  expect(screen.getByText('This device')).toBeTruthy();
  act(() => { jest.advanceTimersByTime(1); });
  expect(screen.queryByText('This device')).toBeNull();
});

test('opening again while it fades shows it again', () => {
  setWidth(1280);
  const view = render(<Menu open label="Connect" />);
  view.rerender(<Menu open={false} label="Connect" />);
  view.rerender(<Menu open label="Connect" />);
  act(() => { jest.advanceTimersByTime(POPOVER_CLOSE_MS * 2); });
  expect(screen.getByText('Connect')).toBeTruthy();
});

test('with reduced motion it goes at once', () => {
  setWidth(1280);
  reducedMotion = true;
  const view = render(<Menu open label="Connect" />);
  view.rerender(<Menu open={false} label="Connect" />);
  act(() => { jest.advanceTimersByTime(0); });
  expect(screen.queryByText('Connect')).toBeNull();
});
