import React from 'react';
import { formatDuration } from '../../utils/formatTime';
import { ArtistInitial } from './ArtistInitial';
import { artistSummary } from '../../utils/artistSummary';
import { AboutBlock, AboutCard, CollapsibleText, TagPills } from './AboutCard';
import { AboutCarousel, type CarouselImage } from './AboutCarousel';

// The artist page's "About {artist}" section, above Similar artists. (Its
// "Genres and styles", below them, is browse/StyleProfileSection.) The header
// keeps only the name and the Play, Radio and Links buttons.

export interface ArtistTag {
    name: string;
    isCommunity: boolean;
    providers?: string[];
    count?: number;
}

const providerName = (p: string) => (p === 'lastfm' ? 'Last.fm' : p === 'theaudiodb' ? 'TheAudioDB' : 'MusicBrainz');

/** Where a tag came from, for its tooltip; none for the plain genre list. */
const tagSource = (tag: ArtistTag) => (tag.isCommunity
    ? `From ${(tag.providers || []).map(providerName).join(' + ')}${tag.count && !(tag.providers || []).every(p => p === 'theaudiodb') ? ` · ${tag.count}` : ''}`
    : undefined);

function formatListeners(raw: string): string {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return raw;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M listeners`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K listeners`;
    return `${n} listeners`;
}

export const ArtistAboutSection: React.FC<{
    artistName: string;
    /** The artist's picture, as in the page's header. */
    imageUrl?: string;
    bio?: string;
    loading: boolean;
    members?: string[];
    roles: Array<{ role: string }>;
    type?: string;
    disambiguation?: string;
    area?: string;
    lifeSpan?: { begin?: string; end?: string };
    stats: { totalTracks: number; totalAlbums: number; totalDuration: number };
    listeners?: string;
    tags: ArtistTag[];
    /** Wide pictures from the providers for the card's carousel (GET /artists/:id/hero-images). */
    heroImages?: CarouselImage[] | null;
}> = ({ artistName, imageUrl, bio, loading, members, roles, type, disambiguation, area, lifeSpan, stats, listeners, tags, heroImages }) => {
    // "At a glance": a short summary written from the facts (utils/artistSummary).
    const glance = artistSummary({
        name: artistName,
        type,
        area,
        lifeSpan,
        roles: roles.map(r => r.role),
        tracks: stats.totalTracks,
        albums: stats.totalAlbums,
        duration: stats.totalDuration > 60 ? formatDuration(stats.totalDuration) : undefined,
        listeners: listeners ? formatListeners(listeners) : undefined,
    });
    const hasMembers = !!members && members.length > 0;
    if (!bio && !loading && !type && !disambiguation && glance.length === 0 && !hasMembers && tags.length === 0) return null;

    return (
        <AboutCard
            title={`About ${artistName}`}
            name={artistName}
            kind={(type || disambiguation) && (
                <>
                    {type}
                    {type && disambiguation && ' – '}
                    {disambiguation && <span className="about-card__disambiguation">{disambiguation}</span>}
                </>
            )}
            imageUrl={imageUrl}
            gallery={heroImages?.length
                ? <AboutCarousel images={heroImages} label={`Pictures of ${artistName}`} shape="wide" />
                : undefined}
            shape="round"
            picture={imageUrl
                ? <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                : <ArtistInitial name={artistName} lookup={false} className="text-2xl md:text-3xl text-[var(--color-primary)] opacity-60" />}
        >
            {glance.length > 0 && (
                <AboutBlock heading="At a glance">
                    <p className="about-card__summary">{glance.join(' ')}</p>
                </AboutBlock>
            )}

            {bio && (
                <AboutBlock heading="Biography">
                    <CollapsibleText text={bio} />
                </AboutBlock>
            )}
            {loading && !bio && (
                <div className="about-card__block space-y-2" aria-hidden="true">
                    <div className="h-4 w-full rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                    <div className="h-4 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                </div>
            )}

            {hasMembers && (
                <AboutBlock heading="Members">
                    <ul className="about-card__members">
                        {members!.map(member => <li key={member}>{member}</li>)}
                    </ul>
                </AboutBlock>
            )}

            {tags.length > 0 && (
                <AboutBlock heading="Tags">
                    <TagPills tags={tags.map(tag => ({ name: tag.name, title: tagSource(tag) }))} />
                </AboutBlock>
            )}
        </AboutCard>
    );
};
