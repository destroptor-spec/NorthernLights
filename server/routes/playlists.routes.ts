import { Router } from 'express';
import { getPlaylists, getPlaylistTracks, createPlaylist, addTracksToPlaylist, deletePlaylist, getPlaylistOwner, togglePlaylistPin } from '../database';

const router = Router();

// Get all playlists for current user
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const playlists = await getPlaylists(userId);

    const populated = await Promise.all(playlists.map(async (pl: any) => {
      const tracks = await getPlaylistTracks(pl.id);
      return { ...pl, tracks };
    }));

    res.json({ playlists: populated });
  } catch (error) {
    console.error('Playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
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

    const owner = await getPlaylistOwner(id as string);
    if (owner && owner !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your playlist' });
    }

    await addTracksToPlaylist(id as string, trackIds);
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

    if (req.user?.role === 'admin') {
      await deletePlaylist(id as string);
    } else {
      await deletePlaylist(id as string, userId);
    }

    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Playlist delete error:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
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
    res.json({ status: 'ok', pinned });
  } catch (error) {
    console.error('Playlist pin error:', error);
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});

export default router;
