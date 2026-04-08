import React, { memo } from 'react';
import { Link } from 'react-router-dom';
import { AlbumArt } from '../AlbumArt';
import { Play } from 'lucide-react';

interface AlbumCardProps {
    title: string;
    artist: string;
    artUrl?: string;
    subtitle?: string;
    onPlay: (e: React.MouseEvent) => void;
    onOpen?: () => void;
    linkTo?: string;
}

export const AlbumCard: React.FC<AlbumCardProps> = memo(({ title, artist, artUrl, subtitle, onPlay, onOpen, linkTo }) => {
    return (
        <div
            className="group flex flex-col relative cursor-pointer"
            role={!linkTo ? "button" : undefined}
            tabIndex={!linkTo ? 0 : undefined}
            onClick={!linkTo ? onOpen : undefined}
            onKeyDown={!linkTo ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (onOpen) onOpen();
                }
            } : undefined}
        >
            {/* Semantic Invisible Link Overlay */}
            {linkTo && (
                <Link 
                    to={linkTo} 
                    className="absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    aria-label={`View album: ${title}`}
                />
            )}
            
            {/* Art container */}
            <div className="relative aspect-square w-full mb-3 rounded-2xl border border-black/5 dark:border-white/5 bg-white/5 dark:bg-black/20 shadow-md overflow-hidden transition-transform duration-300 group-hover:scale-[1.02]">
                <AlbumArt
                    artUrl={artUrl}
                    artist={artist}
                    album={title}
                    size={400}
                    className="w-full h-full object-cover"
                />

                {/* Hover overlay */}
                <div className="absolute inset-0 bg-transparent group-hover:bg-black/40 transition-colors duration-300 flex items-center justify-center z-10 pointer-events-none rounded-2xl">
                    <button
                        onClick={(e) => { 
                            e.preventDefault(); 
                            e.stopPropagation(); 
                            onPlay(e); 
                        }}
                        aria-label={`Play ${title}`}
                        className="
                            z-20 pointer-events-auto
                            w-14 h-14 rounded-full
                            flex items-center justify-center
                            opacity-0 scale-75
                            group-hover:opacity-100 group-hover:scale-100
                            transition-all duration-300 ease-out
                            hover:scale-110 active:scale-95
                            bg-emerald-500/90 hover:bg-emerald-400 text-white backdrop-blur-sm
                            shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.5)]
                            focus-visible:opacity-100 focus-visible:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white
                        "
                    >
                        <Play size={24} fill="currentColor" className="text-white ml-1" />
                    </button>
                </div>
            </div>

            {/* Text */}
            <div className="flex flex-col px-1 relative z-10 pointer-events-none">
                <div className="font-semibold text-sm md:text-base tracking-wide truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
                    {title}
                </div>
                {subtitle && (
                    <div className="text-xs md:text-sm text-[var(--color-text-secondary)] truncate mt-0.5">{subtitle}</div>
                )}
            </div>
        </div>
    );
});

AlbumCard.displayName = 'AlbumCard';

