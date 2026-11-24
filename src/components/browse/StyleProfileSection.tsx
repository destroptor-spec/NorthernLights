import React, { useEffect, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { fetchAlbumStyles, fetchArtistStyles, genrePath, stylePath } from '../../api/browse';
import type { StyleProfileEntry } from '../../../shared/api/v1';
import { AuroraCard } from './AuroraCard';
import { useBrowsePlayer } from './browseParts';

/**
 * "Genres and styles" at the foot of an artist's or album's page: its genres
 * and styles in the library (summarised from its tracks; an artist's with each
 * album counted once), strongest first, as the Browse cards "Sounds close to"
 * uses on a track's rays: open the genre or style, or shuffle it. Shown while
 * genre & style browse is on, as its pages are; nothing without a profile.
 */
export const StyleProfileSection: React.FC<{
    kind: 'album' | 'artist';
    id: string | undefined;
    /** The artist's or album's name, for the Back link on the pages it opens. */
    name: string;
    className?: string;
}> = ({ kind, id, name, className = 'mb-12' }) => {
    const enabled = usePlayerStore(s => s.newBrowseEnabled);
    const [entries, setEntries] = useState<StyleProfileEntry[]>([]);
    const { busy, playFilter } = useBrowsePlayer();

    useEffect(() => {
        setEntries([]);
        if (!enabled || !id) return;
        let live = true;
        const auth = usePlayerStore.getState().getAuthHeader();
        (kind === 'album' ? fetchAlbumStyles(auth, id) : fetchArtistStyles(auth, id))
            .then(profile => { if (live) setEntries(profile.entries); })
            .catch(() => {});
        return () => { live = false; };
    }, [enabled, kind, id]);

    if (!enabled || entries.length === 0) return null;
    const backLabel = `Back to ${name}`;
    return (
        <section className={className} aria-label="Genres and styles">
            <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                Genres and styles
            </h3>
            <div className="browse-card-grid browse-card-grid--compact">
                {entries.map(entry => {
                    const isStyle = entry.styleId !== null;
                    const key = isStyle ? `style:${entry.styleId}` : `genre:${entry.genre}`;
                    return (
                        <AuroraCard
                            key={key}
                            name={entry.style ?? entry.genre}
                            meta={isStyle ? entry.genre : 'Genre'}
                            to={isStyle ? stylePath(entry.styleId!) : genrePath(entry.genre)}
                            backLabel={backLabel}
                            onPlay={() => void playFilter(key, isStyle ? { style: entry.styleId! } : { genre: entry.genre })}
                            busy={busy === key}
                        />
                    );
                })}
            </div>
        </section>
    );
};
