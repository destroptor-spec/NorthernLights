import React, { useEffect, useState } from 'react';
import { useArtistImageLookup } from '../../utils/artistImageLookups';

interface ArtistInitialProps {
    name: string;
    className?: string;
    /**
     * Ask the server for this artist's picture and show it once it has one
     * (default). Off where the page looks the artist up itself (its own page).
     */
    lookup?: boolean;
}

// What a card shows for an artist without a picture. While shown, it asks for
// one in the background (utils/artistImageLookups) and swaps it in when it
// arrives; it fills the card's frame like the card's own picture would.
export const ArtistInitial: React.FC<ArtistInitialProps> = ({ name, className, lookup = true }) => {
    const imageUrl = useArtistImageLookup(lookup ? name : null);
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [imageUrl]);

    if (imageUrl && !failed) {
        return <img src={imageUrl} alt="" loading="lazy" decoding="async" className="artist-initial-image" onError={() => setFailed(true)} />;
    }
    return (
        <span
            role="img"
            aria-label={`${name || 'Unknown'} artist initial`}
            className={className ?? 'text-4xl md:text-6xl text-[var(--color-primary)] opacity-50'}
        >
            {(name?.charAt(0) ?? '?')}
        </span>
    );
};
