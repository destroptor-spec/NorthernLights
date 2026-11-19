import { act, renderHook } from '@testing-library/react';
import { PRESENCE_MS, usePresenceList } from './usePresenceList';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const key = (item: string) => item;
const view = (entries: ReturnType<typeof usePresenceList<string>>) =>
  entries.map((entry) => `${entry.key}${entry.entering ? '+' : ''}${entry.leaving ? '-' : ''}`);

test('the first list just shows; what comes later folds in', () => {
  const { result, rerender } = renderHook(({ items }) => usePresenceList(items, key), { initialProps: { items: ['a', 'b'] } });
  expect(view(result.current)).toEqual(['a', 'b']);
  rerender({ items: ['a', 'q', 'b'] });
  expect(view(result.current)).toEqual(['a', 'q+', 'b']);
  act(() => { jest.advanceTimersByTime(PRESENCE_MS + 50); });
  expect(view(result.current)).toEqual(['a', 'q', 'b']);
});

test('what goes keeps its place, as it was, until it has folded away', () => {
  const { result, rerender } = renderHook(({ items }) => usePresenceList(items, key), { initialProps: { items: ['a', 'b', 'c'] } });
  rerender({ items: ['a', 'c'] });
  expect(view(result.current)).toEqual(['a', 'b-', 'c']);
  rerender({ items: ['a', 'c'] }); // a re-render meanwhile keeps it
  expect(view(result.current)).toEqual(['a', 'b-', 'c']);
  act(() => { jest.advanceTimersByTime(PRESENCE_MS + 50); });
  expect(view(result.current)).toEqual(['a', 'c']);
});

test('a big change (a new album) just switches', () => {
  const { result, rerender } = renderHook(({ items }) => usePresenceList(items, key, { maxAnimated: 2 }), { initialProps: { items: ['a', 'b'] } });
  rerender({ items: ['x', 'y', 'z'] });
  expect(view(result.current)).toEqual(['x', 'y', 'z']);
});

test('off, nothing folds', () => {
  const { result, rerender } = renderHook(({ items }) => usePresenceList(items, key, { enabled: false }), { initialProps: { items: ['a'] } });
  rerender({ items: ['b'] });
  expect(view(result.current)).toEqual(['b']);
});
