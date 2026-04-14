import React, { useState } from 'react';

interface FadedHeroImageProps {
    src: string;
}

export const FadedHeroImage: React.FC<FadedHeroImageProps> = ({ src }) => {
    const [loaded, setLoaded] = useState(false);

    return (
        <div className="absolute top-0 left-0 w-full h-[300px] md:h-[400px] z-0 pointer-events-none overflow-hidden">
            <img
                src={src}
                alt=""
                aria-hidden="true"
                onLoad={() => setLoaded(true)}
                className={`w-full h-full object-cover transition-opacity duration-700 motion-reduce:transition-none ${loaded ? 'opacity-30 dark:opacity-20' : 'opacity-0'}`}
            />
            {/* Gradient overlay for theme-safe fade */}
            <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-bg)]/60 via-[var(--color-bg)]/40 to-[var(--color-bg)]" />
            {/* Bottom soft fade edge */}
            <div className="absolute bottom-0 left-0 w-full h-24 bg-gradient-to-t from-[var(--color-bg)] to-transparent" />
        </div>
    );
};
