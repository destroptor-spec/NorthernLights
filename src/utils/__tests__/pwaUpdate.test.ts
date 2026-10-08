import { createPwaUpdateHandler, startPwaUpdateChecks, watchPwaUpdates } from '../pwaUpdate';

class WorkerStub extends EventTarget {
  state: ServiceWorkerState = 'installed';
  postMessage = jest.fn();
  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

function setup() {
  const oldWorker = new WorkerStub();
  oldWorker.state = 'activated';
  const worker = new WorkerStub();
  const serviceWorker = Object.assign(new EventTarget(), { controller: oldWorker });
  const registration = Object.assign(new EventTarget(), {
    waiting: worker as WorkerStub | null,
    active: oldWorker,
    installing: null as WorkerStub | null,
    update: jest.fn().mockResolvedValue(undefined),
  });
  const reload = jest.fn();
  const apply = createPwaUpdateHandler(
    registration as unknown as ServiceWorkerRegistration,
    serviceWorker as unknown as ServiceWorkerContainer,
    reload,
  );
  const control = () => {
    registration.waiting = null;
    registration.active = worker;
    serviceWorker.controller = worker;
    serviceWorker.dispatchEvent(new Event('controllerchange'));
  };
  return { worker, serviceWorker, registration, reload, apply, control };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PWA activation', () => {
  it.each(['control-first', 'activation-first'])('reloads once only after activation AND control: %s', async (order) => {
    const s = setup();
    const result = s.apply();
    expect(s.worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(s.reload).not.toHaveBeenCalled();
    if (order === 'control-first') {
      s.worker.transition('activating');
      s.control();
      expect(s.reload).not.toHaveBeenCalled();
      s.worker.transition('activated');
    } else {
      s.worker.transition('activated');
      expect(s.reload).not.toHaveBeenCalled();
      s.control();
    }
    await result;
    s.control();
    s.worker.transition('activated');
    jest.advanceTimersByTime(30_000);
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the app open on a stalled activation, removes listeners, and allows retry', async () => {
    const s = setup();
    const failed = expect(s.apply()).rejects.toThrow('taking longer');
    jest.advanceTimersByTime(15_000);
    await failed;
    // Late activation after the error must not navigate away unexpectedly.
    s.control();
    s.worker.transition('activated');
    expect(s.reload).not.toHaveBeenCalled();
    await s.apply();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('applies an update already activated by another tab without sending another message', async () => {
    const s = setup();
    s.control();
    s.worker.transition('activated');
    await s.apply();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload the old worker when the update has disappeared', async () => {
    const s = setup();
    s.registration.waiting = null;
    await expect(s.apply()).rejects.toThrow('not ready');
    expect(s.reload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects a replaced worker without reloading', async () => {
    const s = setup();
    const failed = expect(s.apply()).rejects.toThrow('replaced');
    s.worker.transition('redundant');
    await failed;
    expect(s.reload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans up when postMessage throws', async () => {
    const s = setup();
    s.worker.postMessage.mockImplementation(() => { throw new Error('transport'); });
    await expect(s.apply()).rejects.toThrow('transport');
    s.control();
    s.worker.transition('activated');
    expect(s.reload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('deduplicates repeated clicks and releases the operation after rejection', async () => {
    jest.resetModules();
    const { setPwaUpdateHandler, applyPendingPwaUpdate } = await import('../pwaUpdate');
    const s = setup();
    setPwaUpdateHandler(s.apply);
    const first = applyPendingPwaUpdate();
    expect(applyPendingPwaUpdate()).toBe(first);
    const failed = expect(first).rejects.toThrow('taking longer');
    await Promise.resolve();
    jest.advanceTimersByTime(15_000);
    await failed;
    const second = applyPendingPwaUpdate();
    await Promise.resolve();
    s.control();
    s.worker.transition('activated');
    await second;
    expect(applyPendingPwaUpdate()).toBe(second);
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('does not navigate if registration has not finished', async () => {
    jest.resetModules();
    const { applyPendingPwaUpdate } = await import('../pwaUpdate');
    await expect(applyPendingPwaUpdate()).rejects.toThrow('not ready yet');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('PWA update discovery', () => {
  it('checks periodically, throttles resume events and cleans up', async () => {
    const s = setup();
    s.registration.waiting = null;
    const stop = startPwaUpdateChecks(s.registration as unknown as ServiceWorkerRegistration);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.registration.update).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    expect(s.registration.update).toHaveBeenCalledTimes(1);
    stop();
    await jest.advanceTimersByTimeAsync(60_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.registration.update).toHaveBeenCalledTimes(1);
  });

  it('skips offline/hidden apps, then checks on resume', async () => {
    const s = setup();
    s.registration.waiting = null;
    const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const visible = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const stop = startPwaUpdateChecks(s.registration as unknown as ServiceWorkerRegistration);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(s.registration.update).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    visible.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.registration.update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('leaves waiting/installing updates undisturbed and retries failed checks', async () => {
    const s = setup();
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = startPwaUpdateChecks(s.registration as unknown as ServiceWorkerRegistration);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.registration.update).not.toHaveBeenCalled();
    s.registration.waiting = null;
    s.registration.installing = s.worker;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.registration.update).not.toHaveBeenCalled();
    s.registration.installing = null;
    s.registration.update.mockRejectedValueOnce(new Error('offline'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(warning).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.registration.update).toHaveBeenCalledTimes(2);
    stop();
  });
});


describe('PWA lifecycle discovery', () => {
  it('announces a waiting worker once and continues watching after a failed installation', () => {
    const s = setup();
    const notify = jest.fn();
    const stop = watchPwaUpdates(
      s.registration as unknown as ServiceWorkerRegistration,
      s.serviceWorker as unknown as ServiceWorkerContainer,
      notify,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    s.registration.waiting = null;
    const failed = new WorkerStub();
    failed.state = 'installing';
    s.registration.installing = failed;
    s.registration.dispatchEvent(new Event('updatefound'));
    failed.transition('redundant');
    expect(notify).toHaveBeenCalledTimes(1);
    const retry = new WorkerStub();
    retry.state = 'installing';
    s.registration.installing = retry;
    s.registration.dispatchEvent(new Event('updatefound'));
    s.registration.waiting = retry;
    retry.transition('installed');
    retry.transition('installed');
    expect(notify).toHaveBeenCalledTimes(2);
    stop();
    s.control();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not prompt on first installation but announces subsequent controller changes', () => {
    const s = setup();
    const container = Object.assign(new EventTarget(), { controller: null as WorkerStub | null });
    s.registration.waiting = null;
    s.registration.installing = s.worker;
    const notify = jest.fn();
    const stop = watchPwaUpdates(
      s.registration as unknown as ServiceWorkerRegistration,
      container as unknown as ServiceWorkerContainer,
      notify,
    );
    s.worker.transition('installed');
    container.controller = s.worker;
    container.dispatchEvent(new Event('controllerchange'));
    expect(notify).not.toHaveBeenCalled();
    container.controller = new WorkerStub();
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
  });
});
