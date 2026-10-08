/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './utils/pwaInstall';
import { usePlayerStore } from './store';
import { createPwaUpdateHandler, reloadAppOnce, setPwaUpdateHandler, startPwaUpdateChecks, watchPwaUpdates } from './utils/pwaUpdate';
import { OriginAccessGate } from './components/OriginAccessGate';

// Auto-recover from stale lazy chunks. After a deploy the hashed route chunks
// change; a tab still running the old build that navigates to a not-yet-loaded
// route asks for a chunk the server no longer has → Vite fires `vite:preloadError`
// and React would otherwise show a blank screen until a manual F5. We reload once
// to pull the new build, guarding with sessionStorage so a genuinely missing
// asset can't trap us in a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const RELOAD_KEY = 'nl-chunk-reload-at';
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  // Allow a fresh recovery reload at most once every 10s.
  if (Date.now() - last < 10000) return;
  event.preventDefault();
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  reloadAppOnce();
});

// Vite generates the worker; native lifecycle events drive the prompt and
// activation. Avoid the plugin's heuristic update classification/reload paths.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const serviceWorker = navigator.serviceWorker;
  const controllerAtLoad = serviceWorker.controller;
  void serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((registration) => {
    setPwaUpdateHandler(createPwaUpdateHandler(registration, serviceWorker, reloadAppOnce, controllerAtLoad));
    watchPwaUpdates(registration, serviceWorker, () => usePlayerStore.getState().setPendingUpdate(true));
    if (controllerAtLoad && serviceWorker.controller !== controllerAtLoad) {
      usePlayerStore.getState().setPendingUpdate(true);
    }
    startPwaUpdateChecks(registration);
  }).catch((error: unknown) => {
    console.error('[PWA] Service worker registration failed.', error);
  });
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App crashed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'sans-serif',
          color: '#ccc',
          background: '#1a1a2e',
          gap: '16px',
        }}>
          <h1 style={{ fontSize: '1.5rem', color: '#ff6b6b' }}>Something went wrong</h1>
          <pre style={{
            maxWidth: '600px',
            padding: '16px',
            background: '#16213e',
            borderRadius: '8px',
            fontSize: '0.85rem',
            overflow: 'auto',
            maxHeight: '200px',
          }}>
            {this.state.error?.message}
          </pre>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const playerState = usePlayerStore.getState();
  playerState.setTheme(playerState.theme);
  playerState.setReducedMotion(playerState.reducedMotion);

  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <OriginAccessGate>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </OriginAccessGate>
      </ErrorBoundary>
    </React.StrictMode>
  );
}
