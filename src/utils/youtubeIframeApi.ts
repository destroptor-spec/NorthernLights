// Singleton loader for the YouTube IFrame Player API.
//
// Unlike a plain <iframe> embed, the IFrame API (YT.Player) lets us detect
// buffering/playing, seek to a position, and react to the video ending — all
// of which the mobile now-playing background video needs. The API script must
// be loaded once globally; it then invokes the global `onYouTubeIframeAPIReady`
// callback. We wrap that in a memoised promise so any number of players can
// await readiness.

// Minimal typings — we intentionally avoid pulling in @types/youtube.
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  mute(): void;
  unMute(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getPlayerState(): number;
  destroy(): void;
}

export interface YTPlayerEvent {
  target: YTPlayer;
  data: number;
}

export interface YTPlayerOptions {
  videoId?: string;
  host?: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: Pick<YTPlayerEvent, 'target'>) => void;
    onStateChange?: (event: YTPlayerEvent) => void;
    onError?: (event: YTPlayerEvent) => void;
    onAutoplayBlocked?: (event: Pick<YTPlayerEvent, 'target'>) => void;
  };
}

export interface YTNamespace {
  Player: new (element: HTMLElement | string, options: YTPlayerOptions) => YTPlayer;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
const API_LOAD_TIMEOUT_MS = 15000;

let apiPromise: Promise<YTNamespace> | null = null;

export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('YouTube IFrame API unavailable outside the browser'));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${IFRAME_API_SRC}"]`);
    const script = existing ?? document.createElement('script');
    const previous = window.onYouTubeIframeAPIReady;
    const cleanup = () => {
      window.clearTimeout(timeout);
      script.removeEventListener('error', onError);
      if (window.onYouTubeIframeAPIReady === onReady) {
        window.onYouTubeIframeAPIReady = previous;
      }
    };
    const fail = (message: string) => {
      cleanup();
      script.remove(); // A failed tag must not prevent the next attempt.
      apiPromise = null;
      reject(new Error(message));
    };
    const onError = () => fail('Failed to load YouTube IFrame API script');
    const onReady = () => {
      try {
        previous?.();
      } finally {
        if (window.YT?.Player) {
          cleanup();
          resolve(window.YT);
        } else {
          fail('YouTube IFrame API loaded without YT.Player');
        }
      }
    };
    const timeout = window.setTimeout(() => fail('YouTube IFrame API timed out'), API_LOAD_TIMEOUT_MS);
    window.onYouTubeIframeAPIReady = onReady;
    script.addEventListener('error', onError);
    if (!existing) {
      script.src = IFRAME_API_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });

  return apiPromise;
}
