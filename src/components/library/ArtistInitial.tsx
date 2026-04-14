import React from 'react';

interface ArtistInitialProps {
    name: string;
    className?: string;
}

export const ArtistInitial: React.FC<ArtistInitialProps> = ({ name, className }) => (
    <span
        role="img"
        aria-label={`${name || 'Unknown'} artist initial`}
        className={className ?? 'text-4xl md:text-6xl text-[var(--color-primary)] opacity-50'}
    >
        {(name?.charAt(0) ?? '?')}
    </span>
);
