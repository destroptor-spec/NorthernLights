import React from 'react';
import { act, createEvent, fireEvent, render } from '@testing-library/react';
import { LONG_PRESS_MS, useContextMenuTrigger } from './useContextMenuTrigger';

// jsdom has no PointerEvent; React reads pointerType, pointerId and isPrimary from it.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}
(window as any).PointerEvent = TestPointerEvent;

function Row({ onOpen, onPlay }: { onOpen: (x: number, y: number) => void; onPlay: () => void }) {
  const trigger = useContextMenuTrigger(onOpen);
  return (
    <div {...trigger} data-testid="row" onClick={onPlay}>
      <span data-testid="title">Title</span>
      <a href="/library/artist/1" data-testid="link">Artist</a>
      <a href="/library/album/1" data-testid="card-link" data-card-link>Album</a>
      <span data-testid="handle" data-no-long-press>⋮⋮</span>
    </div>
  );
}

function setup() {
  const onOpen = jest.fn();
  const onPlay = jest.fn();
  const view = render(<Row onOpen={onOpen} onPlay={onPlay} />);
  return { onOpen, onPlay, ...view };
}

const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('right-click opens the menu where the mouse is, instead of the browser menu', () => {
  const { onOpen, getByTestId } = setup();
  const event = createEvent.contextMenu(getByTestId('title'), { clientX: 120, clientY: 80 });
  fireEvent(getByTestId('title'), event);
  expect(onOpen).toHaveBeenCalledWith(120, 80);
  expect(event.defaultPrevented).toBe(true);
});

test('right-click on a link keeps the browser menu', () => {
  const { onOpen, getByTestId } = setup();
  const event = createEvent.contextMenu(getByTestId('link'), { clientX: 10, clientY: 10 });
  fireEvent(getByTestId('link'), event);
  expect(onOpen).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

test("right-click on a card's own link (it covers the card) opens the card's menu", () => {
  const { onOpen, getByTestId } = setup();
  const event = createEvent.contextMenu(getByTestId('card-link'), { clientX: 12, clientY: 14 });
  fireEvent(getByTestId('card-link'), event);
  expect(onOpen).toHaveBeenCalledWith(12, 14);
  expect(event.defaultPrevented).toBe(true);
});

test('the keyboard menu key opens it by the row', () => {
  const { onOpen, getByTestId } = setup();
  getByTestId('row').getBoundingClientRect = () => ({ left: 100, top: 200, width: 400, height: 40, right: 500, bottom: 240, x: 100, y: 200, toJSON: () => ({}) });
  fireEvent.contextMenu(getByTestId('row'), { clientX: 0, clientY: 0 });
  expect(onOpen).toHaveBeenCalledWith(148, 220);
});

test('a long press opens the menu once (iOS sends no contextmenu), and the tap it ends with does not play the row', () => {
  const { onOpen, onPlay, getByTestId } = setup();
  const title = getByTestId('title');
  fireEvent.pointerDown(title, { ...touch, clientX: 50, clientY: 60 });
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS - 1); });
  expect(onOpen).not.toHaveBeenCalled();
  act(() => { jest.advanceTimersByTime(1); });
  expect(onOpen).toHaveBeenCalledWith(50, 60);

  fireEvent.pointerUp(title, touch);
  const touchEnd = createEvent.touchEnd(title);
  fireEvent(title, touchEnd);
  expect(touchEnd.defaultPrevented).toBe(true);
  fireEvent.click(title);
  expect(onPlay).not.toHaveBeenCalled();
  expect(onOpen).toHaveBeenCalledTimes(1);

  // The next tap plays as usual.
  act(() => { jest.advanceTimersByTime(1000); });
  fireEvent.click(title);
  expect(onPlay).toHaveBeenCalledTimes(1);
});

test("Android's own long-press contextmenu opens it once, before or after the timer", () => {
  const { onOpen, getByTestId } = setup();
  const title = getByTestId('title');

  fireEvent.pointerDown(title, { ...touch, clientX: 30, clientY: 40 });
  const early = createEvent.contextMenu(title, { clientX: 31, clientY: 41 });
  fireEvent(title, early);
  expect(early.defaultPrevented).toBe(true);
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS * 2); });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(30, 40);
  fireEvent.pointerUp(title, touch);

  act(() => { jest.advanceTimersByTime(1000); });
  fireEvent.pointerDown(title, { ...touch, clientX: 30, clientY: 40 });
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS); });
  fireEvent.contextMenu(title, { clientX: 31, clientY: 41 });
  expect(onOpen).toHaveBeenCalledTimes(2);
});

test('moving the finger (a scroll) or the browser taking the touch cancels the press', () => {
  const { onOpen, getByTestId } = setup();
  const title = getByTestId('title');
  fireEvent.pointerDown(title, { ...touch, clientX: 50, clientY: 60 });
  fireEvent.pointerMove(title, { ...touch, clientX: 50, clientY: 75 });
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS * 2); });

  fireEvent.pointerDown(title, { ...touch, clientX: 50, clientY: 60 });
  fireEvent.pointerCancel(title, touch);
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS * 2); });
  expect(onOpen).not.toHaveBeenCalled();
});

test('a small wobble still counts as a long press', () => {
  const { onOpen, getByTestId } = setup();
  const title = getByTestId('title');
  fireEvent.pointerDown(title, { ...touch, clientX: 50, clientY: 60 });
  fireEvent.pointerMove(title, { ...touch, clientX: 54, clientY: 63 });
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS); });
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('a press on a drag handle, or with a mouse, never starts a long press', () => {
  const { onOpen, getByTestId } = setup();
  fireEvent.pointerDown(getByTestId('handle'), touch);
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS * 2); });
  fireEvent.pointerDown(getByTestId('title'), { pointerType: 'mouse', pointerId: 1 });
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS * 2); });
  expect(onOpen).not.toHaveBeenCalled();
});

test('a short tap plays the row', () => {
  const { onOpen, onPlay, getByTestId } = setup();
  const title = getByTestId('title');
  fireEvent.pointerDown(title, touch);
  act(() => { jest.advanceTimersByTime(120); });
  fireEvent.pointerUp(title, touch);
  fireEvent.click(title);
  act(() => { jest.advanceTimersByTime(LONG_PRESS_MS * 2); });
  expect(onPlay).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});
