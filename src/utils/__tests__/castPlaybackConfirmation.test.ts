import { CastPlaybackConfirmation } from '../castPlaybackConfirmation';

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
const setup = () => {
    const confirmation = new CastPlaybackConfirmation();
    const callbacks = {
        entryId: 'selected', isCurrent: jest.fn(() => true), retry: jest.fn().mockResolvedValue(undefined),
        confirmed: jest.fn(), failed: jest.fn(), cancelled: jest.fn(),
    };
    confirmation.start(callbacks);
    return { confirmation, callbacks };
};
const playing = (currentTime: number, entryId = 'selected') => ({ entryId, playerState: 'PLAYING', currentTime });

test('PLAYING alone, a frozen position and another entry never confirm playback', () => {
    const { confirmation, callbacks } = setup();
    confirmation.observe(playing(100, 'previous'));
    confirmation.observe(playing(101, 'previous'));
    confirmation.observe({ ...playing(0), playerState: 'BUFFERING' });
    confirmation.observe(playing(0));
    confirmation.observe(playing(0));
    expect(confirmation.pending).toBe(true);
    expect(callbacks.confirmed).not.toHaveBeenCalled();
    confirmation.observe(playing(1));
    expect(callbacks.confirmed).toHaveBeenCalledWith(1, 0);
    jest.advanceTimersByTime(60000);
    expect(callbacks.retry).not.toHaveBeenCalled();
});

test('two independent increases confirm even below a second; duplicate samples do not', () => {
    const { confirmation, callbacks } = setup();
    confirmation.observe(playing(12));
    confirmation.observe(playing(12.2));
    confirmation.observe(playing(12.2));
    expect(callbacks.confirmed).not.toHaveBeenCalled();
    confirmation.observe(playing(12.4));
    expect(callbacks.confirmed).toHaveBeenCalledTimes(1);
});

test('retries once at 15 seconds, then fails even when the retry hangs', () => {
    const { confirmation, callbacks } = setup();
    callbacks.retry.mockImplementation(() => new Promise(() => {}));
    jest.advanceTimersByTime(15000);
    expect(callbacks.retry).toHaveBeenCalledTimes(1);
    expect(callbacks.failed).not.toHaveBeenCalled();
    jest.advanceTimersByTime(15000);
    expect(callbacks.failed).toHaveBeenCalledWith(2, 30000);
    expect(confirmation.pending).toBe(false);
    expect(confirmation.unconfirmed).toBe(true);
    jest.advanceTimersByTime(60000);
    expect(callbacks.retry).toHaveBeenCalledTimes(1);
});

test('a retry requires new advancing evidence', () => {
    const { confirmation, callbacks } = setup();
    confirmation.observe(playing(0));
    confirmation.observe(playing(0.2));
    jest.advanceTimersByTime(15000);
    confirmation.observe(playing(0.4));
    expect(callbacks.confirmed).not.toHaveBeenCalled();
    confirmation.observe(playing(1.4));
    expect(callbacks.confirmed).toHaveBeenCalledWith(2, 15000);
});

test('session/selection changes and cancellation stop old retries', () => {
    const { confirmation, callbacks } = setup();
    callbacks.isCurrent.mockReturnValue(false);
    jest.advanceTimersByTime(15000);
    expect(callbacks.retry).not.toHaveBeenCalled();
    expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
    expect(confirmation.unconfirmed).toBe(false);
    confirmation.start({ ...callbacks, isCurrent: () => true });
    confirmation.cancel();
    jest.advanceTimersByTime(30000);
    expect(callbacks.failed).not.toHaveBeenCalled();
});


test('a timer delayed by phone suspension reports uncertainty without restarting playback', () => {
    const { confirmation, callbacks } = setup();
    jest.setSystemTime(Date.now() + 120000);
    jest.advanceTimersByTime(15000);
    expect(callbacks.retry).not.toHaveBeenCalled();
    expect(callbacks.failed).toHaveBeenCalledTimes(1);
    confirmation.observe(playing(120));
    confirmation.observe(playing(121));
    expect(callbacks.confirmed).toHaveBeenCalledTimes(1);
});

test('a pause on the device for the requested entry ends confirmation without a retry', () => {
    const { confirmation, callbacks } = setup();
    const pausedElsewhere = jest.fn();
    confirmation.start({ ...callbacks, pausedElsewhere });
    confirmation.observe({ entryId: 'previous', playerState: 'PAUSED', currentTime: 3 });
    expect(confirmation.unconfirmed).toBe(true);
    confirmation.observe({ entryId: 'selected', playerState: 'PAUSED', currentTime: 3 });
    expect(pausedElsewhere).toHaveBeenCalledTimes(1);
    expect(confirmation.unconfirmed).toBe(false);
    jest.advanceTimersByTime(60000);
    expect(callbacks.retry).not.toHaveBeenCalled();
    expect(callbacks.failed).not.toHaveBeenCalled();
});

test('a start already visible at the deadline is given more time instead of a reload', () => {
    const { confirmation, callbacks } = setup();
    const extended = jest.fn();
    confirmation.start({ ...callbacks, extended });
    confirmation.observe({ entryId: 'selected', playerState: 'BUFFERING', currentTime: 0 });
    jest.advanceTimersByTime(15000);
    expect(extended).toHaveBeenCalledTimes(1);
    expect(callbacks.retry).not.toHaveBeenCalled();
    confirmation.observe(playing(0));
    confirmation.observe(playing(1.2));
    expect(callbacks.confirmed).toHaveBeenCalledWith(2, 15000);
});

test('a visible start that never progresses still fails at the second deadline', () => {
    const { confirmation, callbacks } = setup();
    confirmation.observe({ entryId: 'selected', playerState: 'BUFFERING', currentTime: 0 });
    jest.advanceTimersByTime(30000);
    expect(callbacks.retry).not.toHaveBeenCalled();
    expect(callbacks.failed).toHaveBeenCalledWith(2, 30000);
});
