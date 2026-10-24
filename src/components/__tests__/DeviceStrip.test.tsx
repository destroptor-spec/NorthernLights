import { act, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { DeviceStrip } from '../DeviceStrip';
import type { FollowedOutput } from '../../utils/sessionFollow';

const follow = (overrides: Partial<FollowedOutput> = {}): FollowedOutput => ({
  sessionId: 's1', outputId: 'receiver:nad', name: 'NAD Forstærker', kind: 'receiver', generation: 3,
  state: 'playing', entryId: 'e1', positionMs: 0, anchorMs: 0, ...overrides,
} as FollowedOutput);

afterEach(() => act(() => { usePlayerStore.setState({ sessionFollow: null } as never); }));

test('shows nothing while this device plays, or nothing plays elsewhere', () => {
  usePlayerStore.setState({ sessionFollow: null } as never);
  const { container } = render(<DeviceStrip />);
  expect(container.firstChild).toBeNull();
});

test('names the device that plays, and opens "Play where?"', () => {
  const openPlayWhere = jest.fn();
  usePlayerStore.setState({ sessionFollow: follow(), openPlayWhere } as never);
  render(<DeviceStrip />);
  screen.getByRole('button', { name: 'Playing on NAD Forstærker. Choose where to play' }).click();
  expect(openPlayWhere).toHaveBeenCalled();
});

test('says paused, and warns when the device stops answering', () => {
  usePlayerStore.setState({ sessionFollow: follow({ state: 'paused' }) } as never);
  const { rerender } = render(<DeviceStrip />);
  expect(screen.getByText('Paused on NAD Forstærker')).toBeTruthy();
  act(() => { usePlayerStore.setState({ sessionFollow: follow({ silent: true } as Partial<FollowedOutput>) } as never); });
  rerender(<DeviceStrip />);
  expect(screen.getByText("NAD Forstærker isn't responding").closest('button')!.className).toContain('is-silent');
});
