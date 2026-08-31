import { Router } from 'express';
import crypto from 'crypto';
import {
  getPlaylistTracks,
  createPlaylist,
  addTracksToPlaylist,
  deletePlaylist,
  getPlaylistMeta,
  togglePlaylistPin,
  updatePlaylistMeta,
  getPlaylistByIdForUser,
  getPlaylistByIdReadable,
  getPlaylistsForUserWithTracks,
  getDiscoverablePlaylistsWithTracks,
  setPlaylistShare,
  togglePlaylistPrivacy,
  getPlaylistSuggestionPool,
} from '../database';
import { publishApiV1Event } from '../services/apiV1Events.service';

const router = Router();

// Get all playlists for current user. Backed by a two-query helper that
// avoids the previous N+1 (one `getPlaylistTracks` per playlist).
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const playlists = await getPlaylistsForUserWithTracks(userId);
    res.json({ playlists });
  } catch (error) {
    console.error('Playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Manual playlists owned by other household users that are discoverable.
// Defined before `/:id` so the literal path isn't captured by the param route.
router.get('/discover', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const playlists = await getDiscoverablePlaylistsWithTracks(userId);
    res.json({ playlists });
  } catch (error) {
    console.error('Discoverable playlists fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch discoverable playlists' });
  }
});

// Get a single playlist with its tracks. Cheap path for the detail view —
// no need to load every other playlist's tracks just to open one. Readable by
// the owner always, and by any user for discoverable (manual, non-private)
// playlists; the response carries `isOwner` so the client can gate editing.
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { id } = req.params;
    const meta = await getPlaylistByIdReadable(id as string, userId);
    if (!meta) return res.status(404).json({ error: 'Playlist not found' });

    const tracks = await getPlaylistTracks(id as string, userId);
    res.json({ playlist: { ...meta, tracks } });
  } catch (error) {
    console.error('Single playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// Candidate pool for "suggested tracks" — tracks related to this playlist by
// artist/genre/album-artist. The client scores/ranks these (same overlap
// algorithm as before) instead of scanning the whole library.
router.get('/:id/suggestions', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const meta = await getPlaylistByIdForUser(req.params.id, userId);
    if (!meta) return res.status(404).json({ error: 'Playlist not found' });
    const tracks = await getPlaylistSuggestionPool(req.params.id, userId);
    res.json({ tracks });
  } catch (error) {
    console.error('Playlist suggestions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Create new playlist
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const id = `user_${Date.now()}`;
    await createPlaylist(id, title, description, false, userId);
    publishApiV1Event(userId, 'playlist.changed', { playlistId: id, action: 'created', source: 'web' });

    res.json({ id, title, description, isLlmGenerated: false, tracks: [] });
  } catch (error) {
    console.error('Playlist create error:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// Add tracks to playlist (owner check)
router.post('/:id/tracks', async (req, res) => {
  try {
    const { id } = req.params;
    const { trackIds } = req.body;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    if (!Array.isArray(trackIds)) return res.status(400).json({ error: 'trackIds must be an array' });

    const meta = await getPlaylistMeta(id as string);
    if (meta?.isSystem) {
      return res.status(403).json({ error: 'System playlists are read-only' });
    }
    if (meta?.userId && meta.userId !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your playlist' });
    }

    await addTracksToPlaylist(id as string, trackIds);
    publishApiV1Event(meta?.userId || userId, 'playlist.changed', { playlistId: id as string, action: 'tracksReplaced', source: 'web' });
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Playlist track update error:', error);
    res.status(500).json({ error: 'Failed to update playlist tracks' });
  }
});

// Delete a playlist (owner or admin)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const meta = await getPlaylistMeta(id as string);
    if (meta?.isSystem) {
      return res.status(403).json({ error: 'System playlists are read-only' });
    }

    if (req.user?.role === 'admin') {
      await deletePlaylist(id as string);
    } else {
      await deletePlaylist(id as string, userId);
    }
    publishApiV1Event(meta?.userId || userId, 'playlist.changed', { playlistId: id as string, action: 'deleted', source: 'web' });

    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Playlist delete error:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Update an owned playlist's name and/or description (owner or admin).
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { title, description } = req.body;
    if (title === undefined && description === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const updates: { title?: string; description?: string | null } = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Title must be a non-empty string' });
      }
      updates.title = title.trim().slice(0, 200);
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== 'string') {
        return res.status(400).json({ error: 'Description must be a string' });
      }
      updates.description = description === null ? null : description.slice(0, 2000);
    }

    const meta = await getPlaylistMeta(id as string);
    if (!meta) return res.status(404).json({ error: 'Playlist not found' });
    if (meta.isSystem) {
      return res.status(403).json({ error: 'System playlists are read-only' });
    }
    if (meta.userId && meta.userId !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your playlist' });
    }

    const updated = await updatePlaylistMeta(
      id as string,
      userId,
      updates,
      req.user?.role === 'admin'
    );
    if (!updated) return res.status(404).json({ error: 'Playlist not found' });

    publishApiV1Event(meta.userId || userId, 'playlist.changed', { playlistId: id as string, action: 'updated', source: 'web' });

    res.json({ status: 'ok', playlist: updated });
  } catch (error) {
    console.error('Playlist update error:', error);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

// Pin/unpin a playlist
router.patch('/:id/pin', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { pinned } = req.body;
    if (typeof pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    const ok = await togglePlaylistPin(id, userId, pinned);
    if (!ok) return res.status(404).json({ error: 'Playlist not found' });
    publishApiV1Event(userId, 'playlist.changed', { playlistId: id as string, action: 'pinUpdated', source: 'web' });
    res.json({ status: 'ok', pinned });
  } catch (error) {
    console.error('Playlist pin error:', error);
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});

// Mark a playlist private (hidden from discovery) or discoverable again.
// Owner-scoped via togglePlaylistPrivacy's WHERE user_id clause.
router.patch('/:id/privacy', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { isPrivate } = req.body;
    if (typeof isPrivate !== 'boolean') {
      return res.status(400).json({ error: 'isPrivate must be a boolean' });
    }

    const ok = await togglePlaylistPrivacy(id, userId, isPrivate);
    if (!ok) return res.status(404).json({ error: 'Playlist not found' });
    publishApiV1Event(userId, 'playlist.changed', { playlistId: id as string, action: 'privacyUpdated', source: 'web' });
    res.json({ status: 'ok', isPrivate });
  } catch (error) {
    console.error('Playlist privacy error:', error);
    res.status(500).json({ error: 'Failed to update privacy status' });
  }
});

// Enable/disable a public share link for an owned playlist. Returns the share
// token (minted once, stable across re-enables) and the public URL when enabled.
router.post('/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { enable } = req.body;
    if (typeof enable !== 'boolean') {
      return res.status(400).json({ error: 'enable must be a boolean' });
    }

    const candidateToken = crypto.randomBytes(18).toString('base64url'); // 24-char URL-safe
    const result = await setPlaylistShare(id as string, userId, enable, candidateToken);
    if (!result) return res.status(404).json({ error: 'Playlist not found' });
    publishApiV1Event(userId, 'playlist.changed', { playlistId: id as string, action: 'shareUpdated', source: 'web' });

    res.json({
      isPublic: result.isPublic,
      shareToken: result.isPublic ? result.shareToken : null,
      sharePath: result.isPublic && result.shareToken ? `/share/${result.shareToken}` : null,
    });
  } catch (error) {
    console.error('Playlist share error:', error);
    res.status(500).json({ error: 'Failed to update share status' });
  }
});

export default router;
