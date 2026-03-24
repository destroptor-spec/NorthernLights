import React from 'react';
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

export const AlbumCard: React.FC<AlbumCardProps> = ({ title, artist, artUrl, subtitle, onPlay, onOpen, linkTo }) => {
    const cardContent = (
        <div
            className="album-card group flex flex-col cursor-pointer"
            onClick={onOpen}
        >
            {/* Art container */}
            <div className="relative aspect-square w-full mb-3 rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)] overflow-hidden">
                <AlbumArt
                    artUrl={artUrl}
                    artist={artist}
                    album={title}
                    size={400}
                    className="w-full h-full object-cover"
                />

                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-300 flex items-center justify-center">
                    <button
                        onClick={(e) => { e.stopPropagation(); onPlay(e); }}
                        aria-label={`Play ${title}`}
                        className="
                            w-14 h-14 rounded-full
                            flex items-center justify-center
                            opacity-0 scale-75
                            group-hover:opacity-100 group-hover:scale-100
                            transition-all duration-300 ease-out
                            hover:scale-110
                        "
                        style={{
                            background: 'linear-gradient(145deg, rgba(139, 92, 246, 0.9), rgba(109, 40, 217, 0.95))',
                            border: '1px solid rgba(168, 85, 247, 0.5)',
                            backdropFilter: 'blur(20px)',
                            WebkitBackdropFilter: 'blur(20px)',
                            boxShadow: '0 0 28px rgba(139, 92, 246, 0.55), inset 0 1px 0 rgba(255,255,255,0.2)',
                            color: '#fff',
                        }}
                    >
                        <Play size={24} className="text-white ml-0.5" />
                    </button>
                </div>
            </div>

            {/* Text */}
            <div className="flex flex-col px-1">
                <div className="font-semibold text-sm md:text-base tracking-wide truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
                    {title}
                </div>
                {subtitle && (
                    <div className="text-xs md:text-sm text-[var(--color-text-secondary)] truncate">{subtitle}</div>
                )}
            </div>
        </div>
    );

    if (linkTo) {
        return <Link to={linkTo} className="no-underline">{cardContent}</Link>;
    }

    return cardContent;
};
