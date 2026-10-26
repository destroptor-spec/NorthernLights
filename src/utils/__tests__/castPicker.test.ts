import { CastManager } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ playlist: [], currentIndex: 0 }), setState: jest.fn() } }));

type Picker = {
    openCastPicker(reason: string): 'opened' | 'pending' | 'unavailable';
    isCastPickerPending(): boolean;
    noteUserCastLaunchIntent: jest.Mock;
    notifyStateChange: jest.Mock;
    logCast: jest.Mock;
    state: string;
    castContext: unknown;
};

/**
 * Cast in the Connect menu (step 2): the menu opens Chrome's device picker
 * itself, in place of <google-cast-launcher>, and ignores taps while the
 * picker has not answered (#40: retaps failed with invalid_parameter).
 */
function harness() {
    const answers: Array<{ resolve: (code: unknown) => void; reject: (error: unknown) => void }> = [];
    const order: string[] = [];
    const requestSession = jest.fn(() => {
        order.push('requestSession');
        return new Promise((resolve, reject) => answers.push({ resolve, reject }));
    });
    const manager = Object.create(CastManager.prototype) as Picker;
    Object.assign(manager, {
        castContext: { requestSession },
        state: 'NOT_CONNECTED',
        castPickerPendingSince: 0,
        logCast: jest.fn(),
        notifyStateChange: jest.fn(),
        noteUserCastLaunchIntent: jest.fn(() => order.push('launch-intent')),
    });
    const markers = () => manager.logCast.mock.calls.map(([, marker, detail]) => `${marker} ${detail}`);
    return { manager, requestSession, answers, order, markers };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('opens the picker in the tap, after the launch intent the Cast button used to note', () => {
    const { manager, order } = harness();
    expect(manager.openCastPicker('connect-menu')).toBe('opened');
    // Synchronous: the SDK needs the user gesture.
    expect(order).toEqual(['launch-intent', 'requestSession']);
    expect(manager.noteUserCastLaunchIntent).toHaveBeenCalledWith('connect-menu');
    expect(manager.isCastPickerPending()).toBe(true);
});

it('ignores taps while the picker has not answered, then opens again', async () => {
    const { manager, requestSession, answers, markers } = harness();
    manager.openCastPicker('connect-menu');
    expect(manager.openCastPicker('connect-menu')).toBe('pending');
    expect(requestSession).toHaveBeenCalledTimes(1);
    expect(manager.noteUserCastLaunchIntent).toHaveBeenCalledTimes(1);
    expect(markers()).toContainEqual(expect.stringMatching(/^cast-picker reason=connect-menu result=ignored-pending/));

    answers[0].reject('cancel'); // the user closed the picker
    await jest.advanceTimersByTimeAsync(0);
    expect(manager.isCastPickerPending()).toBe(false);
    expect(markers()).toContainEqual(expect.stringMatching(/^cast-picker-answered reason=connect-menu outcome=error-cancel/));
    expect(manager.notifyStateChange).toHaveBeenCalled();
    expect(manager.openCastPicker('connect-menu')).toBe('opened');
    expect(requestSession).toHaveBeenCalledTimes(2);
});

it('counts a picker that chose a device as answered', async () => {
    const { manager, answers, markers } = harness();
    manager.openCastPicker('connect-menu');
    answers[0].resolve(null);
    await jest.advanceTimersByTimeAsync(0);
    expect(manager.isCastPickerPending()).toBe(false);
    expect(markers()).toContainEqual(expect.stringMatching(/^cast-picker-answered reason=connect-menu outcome=connected/));
});

it('lets go of a picker that never answers, so a later tap can try again', async () => {
    // Prod 2026-10-11 (#40): a stuck launch request ended by itself after ~10.5 s.
    const { manager, requestSession, answers } = harness();
    manager.openCastPicker('connect-menu');
    await jest.advanceTimersByTimeAsync(29_000);
    expect(manager.openCastPicker('connect-menu')).toBe('pending');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(manager.openCastPicker('connect-menu')).toBe('opened');
    expect(requestSession).toHaveBeenCalledTimes(2);
    // The old picker answering late does not end the new one.
    answers[0].reject('cancel');
    await jest.advanceTimersByTimeAsync(0);
    expect(manager.isCastPickerPending()).toBe(true);
});

it('opens nothing while casting or before the SDK is ready', () => {
    const connected = harness();
    connected.manager.state = 'CONNECTED';
    expect(connected.manager.openCastPicker('connect-menu')).toBe('unavailable');
    expect(connected.requestSession).not.toHaveBeenCalled();

    const early = harness();
    early.manager.castContext = null;
    expect(early.manager.openCastPicker('connect-menu')).toBe('unavailable');
    expect(early.manager.noteUserCastLaunchIntent).not.toHaveBeenCalled();
});
