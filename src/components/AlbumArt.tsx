import React, { useState, useEffect } from 'react';
import { fetchAlbumImage } from '../utils/externalImagery';

interface AlbumArtProps {
  artUrl?: string;
  artist?: string;
  album?: string;
  size?: number;
  className?: string;
}

// Vinyl record SVG shown when no artwork is available or art fetch fails
const VinylPlaceholder: React.FC<{ size?: number }> = ({ size = 200 }) => (
  <div
    className="flex items-center justify-center"
    style={{ width: '100%', height: '100%', minHeight: size }}
  >
    <svg
      viewBox="0 0 100 100"
      style={{ width: '60%', height: '60%', opacity: 0.25 }}
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
    >
      {/* Outer disc */}
      <circle cx="50" cy="50" r="48" />
      {/* Label ring */}
      <circle cx="50" cy="50" r="20" fill="var(--color-background, #111)" />
      {/* Grooves */}
      <circle cx="50" cy="50" r="38" fill="none" stroke="var(--color-background, #111)" strokeWidth="1.2" />
      <circle cx="50" cy="50" r="30" fill="none" stroke="var(--color-background, #111)" strokeWidth="1.2" />
      {/* Center hole */}
      <circle cx="50" cy="50" r="3.5" fill="var(--color-background, #111)" />
      {/* Music note */}
      <text x="42" y="55" fontSize="14" fill="var(--color-text-secondary, #888)" fontFamily="sans-serif">♪</text>
    </svg>
  </div>
);

const AlbumArt: React.FC<AlbumArtProps> = ({ artUrl, artist, album, size = 300, className = '' }) => {
  const [imageError, setImageError] = useState(false);
  const [fetchedArtUrl, setFetchedArtUrl] = useState<string | undefined>();

  // Reset error state when artUrl changes so new art is attempted
  useEffect(() => {
    setImageError(false);
    setFetchedArtUrl(undefined);
  }, [artUrl]);

  useEffect(() => {
    // If local artUrl is missing or errored, try fetching from external
    if ((!artUrl || imageError) && album && artist) {
        let mounted = true;
        fetchAlbumImage(album, artist).then(url => {
            if (mounted && url) {
                setFetchedArtUrl(url);
                setImageError(false); // Reset error if we got a fetched URL
            }
        });
        return () => { mounted = false; };
    }
  }, [artUrl, imageError, album, artist]);

  const activeUrl = fetchedArtUrl || artUrl;
  const showImage = activeUrl && !imageError;

  return (
    <div
      className={`relative overflow-hidden bg-[var(--glass-bg)] w-full h-full ${className}`}
    >
      {showImage ? (
        <img
          src={activeUrl}
          alt={artist ? `${artist} album artwork` : 'Album artwork'}
          className="w-full h-full object-cover"
          onError={() => setImageError(true)}
          loading="lazy"
        />
      ) : (
        <VinylPlaceholder size={size} />
      )}
    </div>
  );
};

export { AlbumArt };
