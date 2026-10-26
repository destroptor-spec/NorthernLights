import {
  CAST_MEDIA_NAMESPACE,
  LIFECYCLE_RECONCILE_DELAYS_MS,
  ReconcileBurst,
  mediaStatusFailureNeedsRecovery,
  probeCastTransport,
} from '../castTransportRecovery';

const realTimers = {
  set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as unknown as number,
  clear: (id: number) => clearTimeout(id),
};

/**
 * Issue #39 and prod 2026-10-10 16:16Z: on resume from a frozen tab, every
 * reconcile attempt in a burst sent into a dead PresentationConnection, racing
 * the stale-transport recovery the first attempt had already started.
 */
describe('ReconcileBurst', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs every attempt on a healthy resume, as before', () => {
    const burst = new ReconcileBurst(realTimers);
    const ran: number[] = [];
    burst.start({ attempt: (d) => ran.push(d), shouldStandDown: () => false });

    jest.advanceTimersByTime(2500);
    expect(ran).toEqual([...LIFECYCLE_RECONCILE_DELAYS_MS]);
    expect(burst.isActive()).toBe(false);
  });

  it('collapses overlapping lifecycle events into one burst', () => {
    const burst = new ReconcileBurst(realTimers);
    const ran: number[] = [];
    const options = { attempt: (d: number) => ran.push(d), shouldStandDown: () => false };

    expect(burst.start(options)).toBe(true);
    expect(burst.start(options)).toBe(false); // focus on the heels of visibilitychange
    jest.advanceTimersByTime(2500);
    expect(ran).toEqual([0, 750, 2500]);

    expect(burst.start(options)).toBe(true); // the next resume gets its own burst
  });

  it('stands down once the first attempt hands the session to recovery', () => {
    const burst = new ReconcileBurst(realTimers);
    let recoveryInFlight = false;
    const ran: number[] = [];
    const stoodDown: number[] = [];
    burst.start({
      attempt: (d) => {
        ran.push(d);
        recoveryInFlight = true; // the refresh threw InvalidStateError
      },
      shouldStandDown: () => recoveryInFlight,
      onStandDown: (d) => stoodDown.push(d),
    });

    jest.advanceTimersByTime(2500);
    expect(ran).toEqual([0]);
    expect(stoodDown).toEqual([750]); // reported once, later attempts dropped
    expect(burst.isActive()).toBe(false);
  });

  it('stands down when the timers coalesce after a frozen tab', () => {
    // All three callbacks firing in one tick is what the issue observed.
    const queued: Array<() => void> = [];
    const burst = new ReconcileBurst({
      set: (callback) => queued.push(callback),
      clear: () => {},
    });
    let recoveryInFlight = false;
    const ran: number[] = [];
    burst.start({
      attempt: (d) => {
        ran.push(d);
        recoveryInFlight = true;
      },
      shouldStandDown: () => recoveryInFlight,
    });

    queued.forEach((callback) => callback());
    expect(ran).toEqual([0]);
  });

  it('cannot get stuck when an attempt throws', () => {
    const burst = new ReconcileBurst(realTimers);
    const attempted: number[] = [];
    burst.start({
      attempt: (d) => {
        attempted.push(d);
        throw new Error('boom');
      },
      shouldStandDown: () => false,
    });

    let previous = 0;
    for (const delay of LIFECYCLE_RECONCILE_DELAYS_MS) {
      expect(() => jest.advanceTimersByTime(delay - previous)).toThrow('boom');
      previous = delay;
    }
    expect(attempted).toEqual([0, 750, 2500]);
    expect(burst.isActive()).toBe(false);
    expect(burst.start({ attempt: () => {}, shouldStandDown: () => false })).toBe(true);
  });

  it('cancel drops pending attempts and frees the burst', () => {
    const burst = new ReconcileBurst(realTimers);
    const ran: number[] = [];
    burst.start({ attempt: (d) => ran.push(d), shouldStandDown: () => false });
    jest.advanceTimersByTime(0);
    burst.cancel();
    jest.advanceTimersByTime(5000);
    expect(ran).toEqual([0]);
    expect(burst.isActive()).toBe(false);
  });
});

// Mirrors CastManager.isDisconnectedPresentationError.
const isDisconnected = (error: unknown) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /PresentationConnection.*disconnected/i.test(detail)
    || /InvalidStateError/i.test(detail)
    || /session_error/i.test(detail);
};

const deadTransportError = () => {
  const error = new Error("Failed to execute 'send' on 'PresentationConnection': Presentation connection is disconnected.");
  error.name = 'InvalidStateError';
  return error;
};

describe('probeCastTransport', () => {
  const opts = { requestId: 7, isDisconnected };

  it('sends the same GET_STATUS the watchdog sends', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    await expect(probeCastTransport({ sendMessage }, opts)).resolves.toBe('alive');
    expect(sendMessage).toHaveBeenCalledWith(CAST_MEDIA_NAMESPACE, { type: 'GET_STATUS', requestId: 7 });
  });

  it('reports dead for the 2026-10-10 signature, thrown synchronously', async () => {
    const session = { sendMessage: () => { throw deadTransportError(); } };
    await expect(probeCastTransport(session, opts)).resolves.toBe('dead');
  });

  it('reports dead for the same signature as a rejection', async () => {
    const session = { sendMessage: () => Promise.reject(deadTransportError()) };
    await expect(probeCastTransport(session, opts)).resolves.toBe('dead');
  });

  it('reports dead for a session_error code, rejected or resolved', async () => {
    await expect(probeCastTransport({ sendMessage: () => Promise.reject('session_error') }, opts)).resolves.toBe('dead');
    await expect(probeCastTransport({ sendMessage: () => Promise.resolve('session_error') }, opts)).resolves.toBe('dead');
  });

  it('never calls a transport dead on evidence it does not recognise', async () => {
    // These must leave recovery behaving as it did before the probe existed.
    await expect(probeCastTransport({ sendMessage: () => Promise.reject('timeout') }, opts)).resolves.toBe('unknown');
    await expect(probeCastTransport({ sendMessage: () => { throw new TypeError('nope'); } }, opts)).resolves.toBe('unknown');
    await expect(probeCastTransport({}, opts)).resolves.toBe('unknown');
    await expect(probeCastTransport(null, opts)).resolves.toBe('unknown');
  });

  it('treats a send that returns no promise as delivered', async () => {
    await expect(probeCastTransport({ sendMessage: () => undefined }, opts)).resolves.toBe('alive');
  });

  it('gives up as unknown when the send never settles', async () => {
    jest.useFakeTimers();
    try {
      const pending = probeCastTransport({ sendMessage: () => new Promise(() => {}) }, { ...opts, timeoutMs: 1500 });
      jest.advanceTimersByTime(1500);
      await expect(pending).resolves.toBe('unknown');
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * Prod 2026-10-23 11:52Z, Beoplay A9: getStatus during a LOAD came back
 * `session_error` on a healthy transport, and the recovery it set off ended
 * the session.
 */
describe('mediaStatusFailureNeedsRecovery', () => {
  const opts = { requestId: 9, isDisconnected };
  const sessionError = '{"code":"session_error","description":null,"details":null}';

  it('leaves a session_error alone when the transport still carries messages', async () => {
    const sendMessage = jest.fn(() => Promise.resolve());
    await expect(mediaStatusFailureNeedsRecovery({ sendMessage }, sessionError, opts)).resolves.toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(CAST_MEDIA_NAMESPACE, { type: 'GET_STATUS', requestId: 9 });
  });

  it('recovers from a session_error when the probe finds the transport dead', async () => {
    const session = { sendMessage: () => Promise.reject('session_error') };
    await expect(mediaStatusFailureNeedsRecovery(session, sessionError, opts)).resolves.toBe(true);
  });

  it('recovers from a session_error when the probe cannot tell, as before', async () => {
    await expect(mediaStatusFailureNeedsRecovery(null, sessionError, opts)).resolves.toBe(true);
    await expect(mediaStatusFailureNeedsRecovery({ sendMessage: () => Promise.reject('timeout') }, sessionError, opts)).resolves.toBe(true);
  });

  it('recovers from a disconnected PresentationConnection without probing', async () => {
    const sendMessage = jest.fn(() => Promise.resolve());
    const detail = "InvalidStateError: Failed to execute 'send' on 'PresentationConnection': Presentation connection is disconnected.";
    await expect(mediaStatusFailureNeedsRecovery({ sendMessage }, detail, opts)).resolves.toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores errors that never meant a dead transport', async () => {
    const sendMessage = jest.fn(() => Promise.resolve());
    await expect(mediaStatusFailureNeedsRecovery({ sendMessage }, '{"code":"timeout"}', opts)).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
