import { create } from 'zustand';

export type MusicVideoEvent =
  | 'no-track' | 'integration-disabled' | 'backgrounds-disabled' | 'casting'
  | 'lookup' | 'lookup-failed' | 'no-match' | 'matched'
  | 'api-loading' | 'api-failed' | 'player-loading' | 'player-timeout'
  | 'ready' | 'state' | 'embed-error' | 'autoplay-blocked' | 'gesture-retry'
  | 'visible' | 'hidden';

interface VideoEvent {
  event: MusicVideoEvent;
  at: string;
  visibility: DocumentVisibilityState;
  code?: number;
}

interface MusicVideoDiagnostics {
  trackId: string | null;
  videoId: string | null;
  events: VideoEvent[];
}

// Only the latest attempt, bounded and in memory. No persistence or uploads.
// Kept after Now Playing closes so Settings can show the failure on a phone.
export const useMusicVideoDiagnostics = create<MusicVideoDiagnostics>(() => ({
  trackId: null, videoId: null, events: [],
}));

export function recordMusicVideoEvent(event: MusicVideoEvent, code?: number) {
  useMusicVideoDiagnostics.setState(state => ({
    events: [...state.events.slice(-19), {
      event, code, at: new Date().toISOString(), visibility: document.visibilityState,
    }],
  }));
}

export function beginMusicVideoDiagnostics(trackId: string | null, event: MusicVideoEvent) {
  useMusicVideoDiagnostics.setState({ trackId, videoId: null, events: [] });
  recordMusicVideoEvent(event);
}

export function musicVideoDiagnosticReport(): string {
  // Script path identifies the actually running build, even if a newer worker
  // has taken control of a page that has not reloaded yet. Omit URL queries.
  const scripts = Array.from(document.scripts)
    .map(script => script.src ? new URL(script.src).pathname : '')
    .filter(path => /\/assets\/index-[\w-]+\.js$/.test(path));
  return JSON.stringify({
    ...useMusicVideoDiagnostics.getState(),
    mode: window.matchMedia('(display-mode: standalone)').matches ? 'installed' : 'browser',
    build: scripts[0] ?? 'unidentified (development or custom entry)',
    origin: window.location.origin,
    browser: navigator.userAgent,
    online: navigator.onLine,
    visibility: document.visibilityState,
    worker: navigator.serviceWorker?.controller?.state ?? 'uncontrolled',
  }, null, 2);
}
