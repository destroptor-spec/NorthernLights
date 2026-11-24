import React from 'react';
import { AlbumArt } from '../AlbumArt';
import { AboutBlock, AboutCard, CollapsibleText, TagPills } from './AboutCard';

/**
 * "About {album}" at the foot of the album page, below Genres and styles: a
 * card like the artist page's, with the cover as its picture (square), the
 * description (Last.fm), and the genres in the files with Last.fm's tags.
 * Nothing without a description or tags.
 */
export const AlbumAboutSection: React.FC<{
    title: string;
    artist: string;
    releaseType: string;
    year?: number | string;
    artUrl?: string;
    description?: string;
    /** Genres from the files' tags. */
    genres: string[];
    /** Last.fm's tags for the album. */
    tags?: string[];
    className?: string;
}> = ({ title, artist, releaseType, year, artUrl, description, genres, tags = [], className }) => {
    // The files' genres first, then Last.fm's tags (its top five), each once.
    const seen = new Set<string>();
    const pills: Array<{ name: string; title?: string }> = [];
    for (const name of genres) {
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        pills.push({ name, title: 'From your files' });
    }
    for (const name of tags.slice(0, 5)) {
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        pills.push({ name, title: 'From Last.fm' });
    }
    if (!description && pills.length === 0) return null;

    return (
        <AboutCard
            title={`About ${title}`}
            name={title}
            kind={[releaseType, artist, year].filter(Boolean).join(' · ')}
            imageUrl={artUrl}
            shape="square"
            picture={<AlbumArt artUrl={artUrl} album={title} artist={artist} size={160} className="h-full w-full object-cover" />}
            className={className}
        >
            {description && (
                <AboutBlock heading="Description">
                    <CollapsibleText text={description} />
                </AboutBlock>
            )}
            {pills.length > 0 && (
                <AboutBlock heading="Tags">
                    <TagPills tags={pills} />
                </AboutBlock>
            )}
        </AboutCard>
    );
};
