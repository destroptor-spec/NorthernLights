import React, { useEffect, useState } from 'react';
import { formatTime } from '../utils/formatTime';

interface SharedTrack {
  title: string;
  artist: string;
  album: string;
  duration: number;
}

interface SharedPlaylist {
  name: string;
  description: string | null;
  trackCount: number;
  tracks: SharedTrack[];
}

// Public, read-only view of a shared playlist. Rendered outside the auth gate
// (App.tsx) for /share/:token URLs. Fetches the unauthenticated public endpoint,
// which returns display-only fields (no stream URLs) — so this view lists tracks
// but does not play them.
export const SharedPlaylistView: React.FC = () => {
  const [state, setState] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');
  const [playlist, setPlaylist] = useState<SharedPlaylist | null>(null);

  // The app shell globally locks scrolling (body overflow:hidden, #root
  // height:100vh) for its nested in-app layout. This standalone public page has
  // no nested scroller, so opt <html> into normal document scrolling while
  // mounted — long track lists then scroll via mouse, touch, and keyboard.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('share-page');
    return () => html.classList.remove('share-page');
  }, []);

  useEffect(() => {
    const token = decodeURIComponent(window.location.pathname.replace(/^\/share\//, '').replace(/\/$/, ''));
    if (!token) { setState('notfound'); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/playlists/${encodeURIComponent(token)}`);
        if (cancelled) return;
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        const data = (await res.json()) as SharedPlaylist;
        if (cancelled) return;
        setPlaylist(data);
        setState('ok');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalSeconds = playlist?.tracks.reduce((sum, t) => sum + (t.duration || 0), 0) ?? 0;

  return (
    <div className="min-h-screen w-full bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] overflow-y-auto">
      <div className="app-backdrop" aria-hidden="true" />
      <div className="relative z-10 max-w-2xl mx-auto px-5 py-10">
        <a href="/" className="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors mb-8">
          NorthernLights
        </a>

        {state === 'loading' && (
          <div className="flex items-center justify-center py-24">
            <div className="w-10 h-10 border-4 border-primary/20 border-t-[var(--color-primary)] rounded-full animate-spin" />
          </div>
        )}

        {(state === 'notfound' || state === 'error') && (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
            <h1 className="text-xl font-bold">
              {state === 'notfound' ? 'This shared playlist isn’t available' : 'Something went wrong'}
            </h1>
            <p className="text-sm text-[var(--color-text-muted)] max-w-sm">
              {state === 'notfound'
                ? 'The link may have been disabled by its owner, or it’s incorrect.'
                : 'Couldn’t load this playlist. Please try again later.'}
            </p>
            <a href="/" className="btn btn-primary mt-2">Go to NorthernLights</a>
          </div>
        )}

        {state === 'ok' && playlist && (
          <>
            <header className="mb-8">
              <p className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-2">Shared playlist</p>
              <h1 className="text-3xl font-bold mb-2">{playlist.name}</h1>
              {playlist.description && (
                <p className="text-sm text-[var(--color-text-muted)] mb-2">{playlist.description}</p>
              )}
              <p className="text-sm text-[var(--color-text-muted)]">
                {playlist.trackCount} {playlist.trackCount === 1 ? 'track' : 'tracks'}
                {totalSeconds > 0 && ` · ${formatTime(totalSeconds)}`}
              </p>
            </header>

            <ol className="flex flex-col divide-y divide-[var(--glass-border)] rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] overflow-hidden">
              {playlist.tracks.map((t, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 text-right text-xs text-[var(--color-text-muted)] tabular-nums flex-shrink-0">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{t.title}</p>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">
                      {t.artist}{t.album ? ` · ${t.album}` : ''}
                    </p>
                  </div>
                  {t.duration > 0 && (
                    <span className="text-xs text-[var(--color-text-muted)] tabular-nums flex-shrink-0">{formatTime(t.duration)}</span>
                  )}
                </li>
              ))}
            </ol>

            <div className="mt-8 text-center">
              <a href="/" className="btn btn-primary">Open in NorthernLights to play</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
