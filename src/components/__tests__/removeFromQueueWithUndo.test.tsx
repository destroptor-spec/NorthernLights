import { act, renderHook } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { useRemoveFromQueueWithUndo } from '../QueueList';

const track = (n: number) => ({ id: `t${n}`, path: `p${n}`, title: `Track ${n}`, queueEntryId: `e${n}` });

beforeEach(() => {
  usePlayerStore.setState({ playlist: [track(1), track(2), track(3)], currentIndex: 0, toasts: [] } as never);
});

test('the track menu removes the entry it was opened on, wherever it is now, with Undo', () => {
  const { result } = renderHook(() => useRemoveFromQueueWithUndo());
  // The queue moved after the menu opened: e3 is now second.
  usePlayerStore.setState({ playlist: [track(1), track(3), track(2)] } as never);
  act(() => result.current('e3'));
  expect(usePlayerStore.getState().playlist.map((t) => t.queueEntryId)).toEqual(['e1', 'e2']);

  const toast = usePlayerStore.getState().toasts.at(-1)!;
  expect(toast.message).toBe('Removed "Track 3" from queue.');
  act(() => toast.onAction!());
  expect(usePlayerStore.getState().playlist.map((t) => t.queueEntryId)).toEqual(['e1', 'e3', 'e2']);
});

test('never removes the track that plays, or an entry that is already gone', () => {
  const { result } = renderHook(() => useRemoveFromQueueWithUndo());
  act(() => result.current('e1'));
  act(() => result.current('gone'));
  expect(usePlayerStore.getState().playlist).toHaveLength(3);
  expect(usePlayerStore.getState().toasts).toHaveLength(0);
});
