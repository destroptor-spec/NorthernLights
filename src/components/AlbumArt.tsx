import React, { useState, useEffect } from 'react';
import { fetchAlbumImage } from '../utils/externalImagery';
import { Disc3 } from 'lucide-react';

interface AlbumArtProps {
  artUrl?: string;
  artist?: string;
  album?: string;
  size?: number;
  className?: string;
}

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
        <div className="flex items-center justify-center w-full h-full">
          <Disc3 size={Math.min(size * 0.5, 64)} className="text-[var(--color-text-muted)] opacity-30" />
        </div>
      )}
    </div>
  );
};

export { AlbumArt };
