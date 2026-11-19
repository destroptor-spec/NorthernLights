import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { UserMenu } from '../UserMenu';
import { formatSleepRemaining } from '../../hooks/useSleepTimerRemaining';

jest.mock('../../hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ canInstall: false, isInstalled: true, platform: 'native-prompt', install: jest.fn() }) }));

const startSleepTimer = jest.fn((minutes: number) => usePlayerStore.setState({ sleepTimerEndsAt: Date.now() + minutes * 60000 }));
const cancelSleepTimer = jest.fn(() => usePlayerStore.setState({ sleepTimerEndsAt: null }));

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    usePlayerStore.setState({
      currentUser: { id: 'u1', username: 'listener', role: 'user' },
      sleepTimerEndsAt: null, startSleepTimer, cancelSleepTimer,
    } as never);
  });
});

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /listener/ }));

it('sets the sleep timer on a slider from 10 to 90 minutes, in a modal from the user menu', () => {
  render(<UserMenu />);
  openMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Sleep timer' }));
  expect(screen.getByRole('dialog', { name: 'Sleep timer' })).toBeTruthy();
  const slider = screen.getByRole('slider', { name: 'Minutes' }) as HTMLInputElement;
  expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['10', '90', '5', '30']);
  fireEvent.change(slider, { target: { value: '45' } });
  expect(screen.getByText('45 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(startSleepTimer).toHaveBeenCalledWith(45);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('while a timer runs: its countdown and a cancel, and no way to start a second one', () => {
  act(() => { usePlayerStore.setState({ sleepTimerEndsAt: Date.now() + 12 * 60000 + 5000 }); });
  render(<UserMenu />);
  openMenu();
  expect(screen.getByRole('timer').textContent).toMatch(/^12:0[45]$/);
  expect(screen.queryByRole('button', { name: 'Sleep timer' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sleep timer' }));
  expect(cancelSleepTimer).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Sleep timer' })).toBeTruthy();
});

it('formats the countdown, with hours from an hour up', () => {
  expect(formatSleepRemaining(65_000)).toBe('1:05');
  expect(formatSleepRemaining(3_725_000)).toBe('1:02:05');
  expect(formatSleepRemaining(0)).toBe('0:00');
});
