import React, { useState, useEffect } from 'react';
import { ExternalLink, X, Music2 } from 'lucide-react';
import { fetchLyrics, type LyricsData } from '../utils/externalImagery';

interface LyricsPanelProps {
  trackName: string;
  artistName: string;
  isVisible: boolean;
  onClose: () => void;
}

export const LyricsPanel: React.FC<LyricsPanelProps> = ({ trackName, artistName, isVisible, onClose }) => {
  const [lyricsData, setLyricsData] = useState<LyricsData | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isVisible || !trackName || !artistName) return;
    let mounted = true;
    setIsLoading(true);
    setError(false);
    setLyricsData(undefined);
    fetchLyrics(trackName, artistName)
      .then(data => {
        if (mounted) {
          if (data) setLyricsData(data);
          else setError(true);
        }
      })
      .catch(() => { if (mounted) setError(true); })
      .finally(() => { if (mounted) setIsLoading(false); });
    return () => { mounted = false; };
  }, [trackName, artistName, isVisible]);

  if (!isVisible) return null;

  return (
    <div className="lyrics-panel animate-in slide-in-from-right-4 fade-in duration-300">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider flex items-center gap-2">
          <Music2 size={14} />
          Lyrics
        </h3>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-[var(--glass-bg-hover)] text-[var(--color-text-muted)] transition-colors">
          <X size={14} />
        </button>
      </div>

      {isLoading && (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-6 h-6 border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)] rounded-full animate-spin" />
          <span className="text-xs text-[var(--color-text-muted)]">Searching Genius...</span>
        </div>
      )}

      {!isLoading && error && (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
          <Music2 size={32} className="text-[var(--color-text-muted)] opacity-30" />
          <span className="text-sm text-[var(--color-text-muted)]">No lyrics found</span>
          <span className="text-xs text-[var(--color-text-muted)] opacity-60">Try searching manually on Genius</span>
        </div>
      )}

      {!isLoading && lyricsData && (
        <div className="flex flex-col items-center gap-4">
          {lyricsData.thumbnailUrl && (
            <div className="w-24 h-24 rounded-xl overflow-hidden bg-[var(--color-surface)] border border-[var(--glass-border)] shadow-sm">
              <img src={lyricsData.thumbnailUrl} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="text-center">
            <p className="text-sm font-bold text-[var(--color-text-primary)]">{lyricsData.title}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{lyricsData.artist}</p>
          </div>
          <a
            href={lyricsData.songUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-sm flex items-center gap-2 no-underline"
          >
            <ExternalLink size={14} />
            View on Genius
          </a>
        </div>
      )}
    </div>
  );
};
