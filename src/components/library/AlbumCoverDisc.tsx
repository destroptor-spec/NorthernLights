import React, { useEffect, useState } from 'react';
import { AlbumArt } from '../AlbumArt';
import { useDiscImage } from '../../hooks/useDiscImage';
import { discKind } from '../../utils/albumSummary';

/** Proxy an external (CAA) image through the server for CORS + caching. */
function proxyImageUrl(externalUrl: string): string {
    return `/api/providers/external/proxy-image?url=${encodeURIComponent(externalUrl)}`;
}

interface AlbumCoverDiscProps {
    albumId?: string;
    /** Local cover art (from file tags) — always-available fallback / label source. */
    artUrl?: string;
    artist: string;
    album: string;
    /** Tailwind sizing classes for the square cover (must set both w and h). */
    sizeClassName?: string;
    /** The release's medium as tagged ("CD", "12\" Vinyl"): a made-up disc looks like a CD for a CD. */
    media?: string | null;
    /** Laid over the cover (the now-playing chip); positions itself. */
    children?: React.ReactNode;
}

/**
 * Album hero cover with a disc that rolls out from behind it. The disc shows a
 * real printed-medium scan (Cover Art Archive "Medium" image) when available,
 * otherwise a procedural disc built from the cover art: a vinyl record with
 * the cover as its label, or a CD when the files are tagged as one. So it works for
 * every album, including when MusicBrainz is disabled. Motion is opt-in via the
 * prefers-reduced-motion convention (handled in CSS).
 */
export const AlbumCoverDisc: React.FC<AlbumCoverDiscProps> = ({
    albumId,
    artUrl,
    artist,
    album,
    sizeClassName = 'w-48 h-48 md:w-60 md:h-60',
    media,
    children,
}) => {
    const { mediumUrl, frontUrl } = useDiscImage(albumId);
    const [rolled, setRolled] = useState(false);

    // Real disc scan when present; otherwise the cover becomes the label —
    // local file art first, then the CAA front cover if the file had none.
    const hasRealDisc = !!mediumUrl;
    const discArt = mediumUrl
        ? proxyImageUrl(mediumUrl)
        : (artUrl || (frontUrl ? proxyImageUrl(frontUrl) : undefined));

    // Trigger the roll-out once the cover has settled. Re-arm per album.
    useEffect(() => {
        setRolled(false);
        let raf2 = 0;
        const raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => setRolled(true));
        });
        return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    }, [albumId, hasRealDisc]);

    return (
        <div className={`album-cover-disc relative shrink-0 ${sizeClassName}`} data-rolled={rolled}>
            {discArt && (
                <div
                    className="album-disc"
                    data-synthetic={!hasRealDisc}
                    data-medium={!hasRealDisc && discKind(media) === 'cd' ? 'cd' : undefined}
                    aria-hidden="true"
                    style={{ ['--disc-art' as string]: `url("${discArt}")` }}
                />
            )}
            <div className="album-cover-disc__cover absolute inset-0 z-10 rounded-2xl shadow-2xl overflow-hidden bg-black/10 dark:bg-white/5">
                <AlbumArt artUrl={artUrl} artist={artist} album={album} size={640} className="w-full h-full object-cover rounded-2xl" />
                {children}
            </div>
        </div>
    );
};
