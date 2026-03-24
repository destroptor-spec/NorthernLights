import React from 'react';

interface ArtistInitialProps {
    name: string;
    className?: string;
}

export const ArtistInitial: React.FC<ArtistInitialProps> = ({ name, className }) => (
    <span className={className ?? 'text-4xl md:text-6xl text-[var(--color-primary)] opacity-50'}>
        {name.charAt(0)}
    </span>
);
