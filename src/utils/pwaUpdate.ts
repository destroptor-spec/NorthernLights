let applyUpdateHandler: (() => Promise<void>) | null = null;
let pendingUpdate: Promise<void> | null = null;
let reloadStarted = false;

export function reloadAppOnce() {
  if (reloadStarted) return;
  reloadStarted = true;
  window.location.reload();
}

export function setPwaUpdateHandler(handler: () => Promise<void>) {
  applyUpdateHandler = handler;
}

// A resolved skipWaiting message does not mean activation has finished. Wait
// for both control and activation (including precache cleanup) before loading
// the new shell. This module is the sole owner of update-triggered navigation.
export function createPwaUpdateHandler(
  registration: ServiceWorkerRegistration,
  serviceWorker: ServiceWorkerContainer,
  reload: () => void = reloadAppOnce,
  originalController = serviceWorker.controller,
) {
  return () => new Promise<void>((resolve, reject) => {
    const worker = registration.waiting
      || (registration.active !== originalController ? registration.active : null);
    if (!worker) {
      reject(new Error('The update is not ready. Please try again shortly.'));
      return;
    }

    const cleanup = () => {
      window.clearTimeout(timeout);
      serviceWorker.removeEventListener('controllerchange', checkActivation);
      worker.removeEventListener('statechange', checkActivation);
    };
    const checkActivation = () => {
      if (worker.state === 'redundant') {
        cleanup();
        reject(new Error('The update was replaced. Please try again.'));
      } else if (serviceWorker.controller === worker && worker.state === 'activated') {
        cleanup();
        reload();
        resolve();
      }
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('The update is taking longer than expected. Please try again.'));
    }, 15000);

    serviceWorker.addEventListener('controllerchange', checkActivation);
    worker.addEventListener('statechange', checkActivation);
    try {
      if (registration.waiting === worker) worker.postMessage({ type: 'SKIP_WAITING' });
      // Another tab may already have activated this update.
      checkActivation();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

// Watch every installation, including retries and updates initiated by another
// tab. Workbox-window's external-update heuristic stops watching updatefound
// after an external installation, which can hide all subsequent updates.
export function watchPwaUpdates(
  registration: ServiceWorkerRegistration,
  serviceWorker: ServiceWorkerContainer,
  onUpdate: () => void,
) {
  let controller = serviceWorker.controller;
  const watched = new Set<ServiceWorker>();
  const announced = new WeakSet<ServiceWorker>();
  const announceWaiting = () => {
    const worker = registration.waiting;
    if (worker && serviceWorker.controller && !announced.has(worker)) {
      announced.add(worker);
      onUpdate();
    }
  };
  const stateChanged = () => {
    announceWaiting();
    for (const worker of watched) {
      if (worker.state === 'installed' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', stateChanged);
        watched.delete(worker);
      }
    }
  };
  const updateFound = () => {
    const worker = registration.installing;
    if (worker && !watched.has(worker)) {
      watched.add(worker);
      worker.addEventListener('statechange', stateChanged);
    }
  };
  const controllerChanged = () => {
    const next = serviceWorker.controller;
    // First install is offline readiness, not a request to interrupt the app.
    if (controller && next && next !== controller) onUpdate();
    controller = next;
  };
  registration.addEventListener('updatefound', updateFound);
  serviceWorker.addEventListener('controllerchange', controllerChanged);
  updateFound();
  announceWaiting();
  return () => {
    registration.removeEventListener('updatefound', updateFound);
    serviceWorker.removeEventListener('controllerchange', controllerChanged);
    for (const worker of watched) worker.removeEventListener('statechange', stateChanged);
  };
}

// Keep one operation in flight, but release it after failure so Retry works.
// Never use a timer to navigate away from a still-working app.
export function applyPendingPwaUpdate(): Promise<void> {
  if (pendingUpdate) return pendingUpdate;
  if (!applyUpdateHandler) {
    return Promise.reject(new Error('Updates are not ready yet. Please try again shortly.'));
  }
  pendingUpdate = Promise.resolve().then(applyUpdateHandler).catch((error: unknown) => {
    pendingUpdate = null;
    throw error;
  });
  return pendingUpdate;
}

// Long-lived installed apps otherwise only check at startup. Throttle resume,
// reconnect and periodic checks together, and leave a ready update undisturbed.
export function startPwaUpdateChecks(registration: ServiceWorkerRegistration) {
  const intervalMs = 60_000;
  let lastCheck = Date.now(); // registration already checked on startup
  let checking = false;
  const check = async () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine
      || checking || registration.installing || registration.waiting
      || Date.now() - lastCheck < intervalMs) return;
    checking = true;
    lastCheck = Date.now();
    try {
      await registration.update();
    } catch (error) {
      console.warn('[PWA] Update check failed; will retry.', error);
    } finally {
      checking = false;
    }
  };
  const interval = window.setInterval(check, intervalMs);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('online', check);
  };
}
