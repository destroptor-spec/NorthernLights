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
import { actionWhenReplaced, sessionMirror } from './utils/SessionMirror';
import { sessionFollower } from './utils/SessionFollower';
import { getAuroraClientId } from './api/auroraApi';
import { toPlayableTracks } from './utils/playableTracks';
import { applySessionCommand } from './utils/sessionCommands';
import { getPlaybackSession } from './api/playbackSessions';
import { playbackManager } from './utils/PlaybackManager';
import type { PlaybackSession } from '../shared/api/v1';
import { castManager } from './utils/CastManager';
import { getPlaybackTimeSnapshot, setPlaybackTimeState } from './store/playbackTime';
import { describeThisDevice } from './utils/deviceName';
import { logPlaybackInfo } from './utils/playbackDebug';

// The session's queue as playable tracks, each keeping its session entry ID.
const sessionQueueTracks = (session: PlaybackSession) => toPlayableTracks(session.queue.map((entry) => entry.track))
  .map((track, index) => ({ ...track, queueEntryId: session.queue[index].queueEntryId }));

// "Sync playback across devices" (off unless the user turns it on here).
sessionMirror.start(usePlayerStore, {
  getPositionSeconds: () => getPlaybackTimeSnapshot().currentTime,
  getOutputName: () => (usePlayerStore.getState().castConnected && castManager.getCastDeviceName()) || describeThisDevice(),
  getCastSessionId: () => castManager.getCastSessionId() || null,
  canClaim: () => !castManager.isLeavingJoinedSession(),
  log: logPlaybackInfo,
  diagnostic: (level, marker, detail) => castManager.logSyncEvent(level, marker, detail),
  onSyncDisabled: () => void usePlayerStore.getState().refreshPlaybackSync(),
  // One device plays at a time: another device took over, so stop here.
  onDisplaced: (replacement) => {
    const state = usePlayerStore.getState();
    const action = actionWhenReplaced({
      replacement,
      castConnected: state.castConnected,
      castDeviceName: castManager.getCastDeviceName(),
      playing: state.playbackState === 'playing',
    });
    if (action === 'stop-casting' && castManager.stopCastingBecauseReplaced(`${replacement!.kind}:${replacement!.name ?? 'unnamed'}`)) return;
    if (action !== 'none' && state.playbackState === 'playing') state.pause();
  },
});
sessionFollower.start(usePlayerStore, {
  clientId: getAuroraClientId,
  mirror: sessionMirror,
  toTracks: sessionQueueTracks,
  setPlaybackTime: (currentTime, duration) => setPlaybackTimeState({ currentTime, duration }),
  onPlaybackSyncChanged: () => void usePlayerStore.getState().refreshPlaybackSync(),
  diagnostic: (level, marker, detail) => castManager.logSyncEvent(level, marker, detail),
  // Another of the user's devices controls this one (it plays the session).
  onCommand: (sessionId, command) => {
    const store = () => usePlayerStore.getState();
    void applySessionCommand(sessionId, command, {
      resume: () => store().resume(),
      pause: () => store().pause(),
      next: () => store().nextTrack(),
      previous: () => store().prevTrack(),
      seek: (seconds) => playbackManager.seek(seconds),
      playlist: () => store().playlist,
      playAtIndex: (index) => store().playAtIndex(index),
      playQueue: (tracks, index) => store().playSessionQueue(tracks, index),
      fetchSession: (id) => getPlaybackSession(store().getAuthHeader(), id),
      toTracks: sessionQueueTracks,
      log: logPlaybackInfo,
    })
      .then((applied) => {
        castManager.logSessionCommand(command.type, applied);
        // Let the sender see it took, even when nothing visible changed (a seek).
        sessionMirror.reportNow();
      })
      .catch((error) => {
        castManager.logSessionCommand(command.type, false);
        logPlaybackInfo('[SessionCommand] failed', error);
      });
  },
  log: logPlaybackInfo,
});
// Picking, in the Cast dialog, a Cast device another of the user's devices is
// casting to: this device leaves that Cast session again and controls it from
// here instead ("Play where?" → that device), since a second sender is
// unreliable (CastManager.setCastingElsewhereCheck).
castManager.setCastingElsewhereCheck((castDeviceName) => {
  if (!usePlayerStore.getState().syncPlaybackAcrossDevices) return false;
  const other = sessionFollower.castingElsewhere(castDeviceName, castManager.getCastSessionId() || null);
  if (!other) return false;
  usePlayerStore.setState({ remoteControlOutputId: other.outputId });
  return true;
});

// A new Cast session while still casting (a stale-transport reconnect):
// tell the server, so joins of the new session are recognised.
let lastCastSessionId = '';
castManager.addStateChangeListener((state) => {
  if (state === 'CONNECTED') {
    const castSessionId = castManager.getCastSessionId();
    if (castSessionId && lastCastSessionId && castSessionId !== lastCastSessionId) sessionMirror.noteCastSessionChanged();
    if (castSessionId) lastCastSessionId = castSessionId;
  } else if (state !== 'CONNECTING') {
    // Only a real disconnect forgets it; a reconnect passes through CONNECTING.
    lastCastSessionId = '';
  }
});

// A page brought back as it was (Android may keep a closed PWA in the
// back/forward cache): note it, with what the restored page thinks it plays,
// since another device may have taken over meanwhile.
// A cold start, once the saved state is restored: what this page thinks it plays.
const logAppStart = () => {
  const state = usePlayerStore.getState();
  castManager.logSyncEvent('ok', 'sync-app-start', `state=${state.playbackState} sync=${state.syncPlaybackAcrossDevices}`);
};
if (usePlayerStore.persist.hasHydrated()) logAppStart();
else usePlayerStore.persist.onFinishHydration(logAppStart);

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  const state = usePlayerStore.getState();
  castManager.logSyncEvent('ok', 'sync-page-restored', `state=${state.playbackState} holdsOutput=${sessionMirror.holdsOutput()} cast=${state.castConnected}`);
});

// The sync setting lives on the server (an admin's, or this user's from another
// device). A device with sync off has no event stream to hear it turn on, so
// every device re-reads it when it comes back to the foreground.
let playbackSyncReadAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || Date.now() - playbackSyncReadAt < 15_000) return;
  playbackSyncReadAt = Date.now();
  void usePlayerStore.getState().refreshPlaybackSync();
});

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
