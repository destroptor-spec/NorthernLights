import { fireEvent, render, screen } from '@testing-library/react';
import { PlayWherePrompt } from './PlayWherePrompt';
import { usePlayerStore } from '../store';

/** "Play where?": the playing device, this device, or nothing at all. */
describe('PlayWherePrompt', () => {
  let resolvePlayWhere: jest.Mock;
  beforeEach(() => {
    resolvePlayWhere = jest.fn().mockResolvedValue(undefined);
    usePlayerStore.setState({ playWherePrompt: { outputName: 'NAD Forstærker' }, resolvePlayWhere } as never);
  });
  afterEach(() => usePlayerStore.setState({ playWherePrompt: null } as never));

  it('offers the playing device first, then this device', () => {
    render(<PlayWherePrompt />);
    expect(screen.getByRole('dialog', { name: 'Play where?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'On NAD Forstærker' }));
    expect(resolvePlayWhere).toHaveBeenLastCalledWith('remote');
    fireEvent.click(screen.getByRole('button', { name: 'On this device' }));
    expect(resolvePlayWhere).toHaveBeenLastCalledWith('here');
  });

  it('does nothing when closed', () => {
    render(<PlayWherePrompt />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(resolvePlayWhere).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: 'Close confirmation' }));
    expect(resolvePlayWhere).toHaveBeenLastCalledWith(null);
  });

  it('offers only this device when the other one is not responding', () => {
    usePlayerStore.setState({ playWherePrompt: { outputName: 'NAD Forstærker', silent: true } } as never);
    render(<PlayWherePrompt />);
    expect(screen.queryByRole('button', { name: 'On NAD Forstærker' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play here' }));
    expect(resolvePlayWhere).toHaveBeenLastCalledWith('here');
  });

  it('shows nothing when not asked', () => {
    usePlayerStore.setState({ playWherePrompt: null } as never);
    const { container } = render(<PlayWherePrompt />);
    expect(container.innerHTML).toBe('');
  });
});
