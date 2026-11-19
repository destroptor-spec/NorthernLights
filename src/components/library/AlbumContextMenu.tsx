import React, { useEffect } from 'react';
import { ChevronRight, ListPlus, Play } from 'lucide-react';
import { usePlayerStore } from '../../store';
import { fetchAlbumTracks } from '../../utils/albumTracks';
import type { TrackInfo } from '../../utils/fileSystem';
import {
    ContextMenuButton,
    ContextMenuDivider,
    ContextMenuFrame,
    ContextMenuHeader,
    ContextMenuList,
    ContextMenuPortal,
} from '../ContextMenu';
import { addablePlaylistItems, FilterableListPanel, useMenuNav } from './TrackContextMenu';

export interface AlbumMenuTarget {
    id: string;
    title: string;
    artist: string;
}

/**
 * An album's menu (AlbumCard's ⋯, right-click, long press): Play album, Add
 * to queue (all its tracks, behind the ones queued by hand) and Add to
 * playlist. The tracks are read from API v1 when an action is chosen; the
 * menu closes at once and a toast says how it went.
 */
export const AlbumContextMenu: React.FC<{
    album: AlbumMenuTarget;
    position: { x: number; y: number } | null;
    onClose: () => void;
}> = ({ album, position, onClose }) => {
    const playlists = usePlayerStore((state) => state.playlists);
    const nav = useMenuNav();
    const open = position !== null;
    const playlistItems = addablePlaylistItems(playlists);

    useEffect(() => {
        if (open) nav.reset();
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    // Reads the album, then acts on its tracks; the menu is already gone.
    const withTracks = (act: (tracks: TrackInfo[]) => Promise<void> | void, failed: string) => {
        onClose();
        void (async () => {
            const { getAuthHeader, addToast } = usePlayerStore.getState();
            let tracks: TrackInfo[];
            try {
                tracks = await fetchAlbumTracks(album.id, getAuthHeader());
            } catch {
                addToast("Couldn't load this album. Try again.", 'error');
                return;
            }
            if (tracks.length === 0) {
                addToast('This album has no tracks to play.', 'info');
                return;
            }
            try {
                await act(tracks);
            } catch {
                addToast(failed, 'error');
            }
        })();
    };

    const playAlbum = () => withTracks(
        (tracks) => usePlayerStore.getState().setPlaylist(tracks, 0, { kind: 'album', id: album.id, name: album.title }),
        "Couldn't play this album.",
    );
    const addToQueue = () => withTracks(
        (tracks) => usePlayerStore.getState().addTracksToQueue(tracks, { notify: true, undo: true, message: `Added "${album.title}" to queue.` }),
        "Couldn't add this album to the queue.",
    );
    const addToPlaylist = (playlistId: string, playlistName: string) => withTracks(
        async (tracks) => {
            await usePlayerStore.getState().addTracksToUserPlaylist(playlistId, tracks.map((track) => track.id));
            usePlayerStore.getState().addToast(`Added "${album.title}" to ${playlistName}.`, 'success');
        },
        `Couldn't add "${album.title}" to ${playlistName}.`,
    );

    const subPanelOpen = nav.current !== null;

    return (
        <ContextMenuPortal
            open={open}
            onClose={onClose}
            position={position ?? undefined}
            desktopWidth={248}
            desktopHeight={200}
        >
            {({ isMobile }) => (
                // Room for the playlist list when it slides in.
                <ContextMenuFrame isMobile={isMobile} className={subPanelOpen ? 'min-h-[320px]' : ''}>
                    <div
                        style={{
                            transition: 'opacity 0.2s',
                            opacity: subPanelOpen ? 0 : 1,
                            pointerEvents: subPanelOpen ? 'none' : 'auto',
                        }}
                    >
                        <ContextMenuHeader title={album.title} subtitle={album.artist} />
                        <ContextMenuList>
                            <ContextMenuButton icon={<Play size={15} />} label="Play Album" onClick={playAlbum} />
                            <ContextMenuButton icon={<ListPlus size={15} />} label="Add to Queue" onClick={addToQueue} />
                            {playlistItems.length > 0 && (
                                <>
                                    <ContextMenuDivider />
                                    <ContextMenuButton
                                        icon={<ListPlus size={15} />}
                                        label="Add to Playlist"
                                        onClick={() => nav.push('playlists')}
                                        trailingIcon={<ChevronRight size={15} />}
                                    />
                                </>
                            )}
                        </ContextMenuList>
                    </div>
                    <FilterableListPanel
                        title="Add to Playlist"
                        placeholder="Filter playlists…"
                        items={playlistItems}
                        onSelect={(id, label) => addToPlaylist(id, label)}
                        onBack={nav.pop}
                        isActive={nav.current === 'playlists'}
                        emptyText="No playlists found"
                    />
                </ContextMenuFrame>
            )}
        </ContextMenuPortal>
    );
};
