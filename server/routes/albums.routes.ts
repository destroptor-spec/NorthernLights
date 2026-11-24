import { Router } from 'express';
import {
  getAlbumById,
  getReleaseGroupEditions,
  mergeAlbumIntoGroup,
  unmergeAlbumFromGroup,
  getAlbumCredits,
  getTrackCredits,
  getRepresentativeReleaseMbid,
} from '../database';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// Returns every album sharing this album's release-group, with track
// counts. The first entry is the canonical edition (most tracks, then
// earliest year, then earliest created_at). Used by AlbumDetail to
// render the "other editions" strip and the Manage editions modal.
router.get('/:id/editions', async (req, res) => {
  try {
    const album = await getAlbumById(req.params.id);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    if (!album.release_group_id) {
      const representative_release_mbid = await getRepresentativeReleaseMbid(album.id);
      const solo = { ...album, representative_release_mbid };
      return res.json({ canonical: solo, editions: [solo] });
    }
    const editions = await getReleaseGroupEditions(album.release_group_id);
    res.json({
      canonical: editions[0] || album,
      editions,
    });
  } catch (error) {
    console.error('Album editions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch album editions' });
  }
});

// Manual merge: pin this album into the target album's release-group.
router.post('/:id/merge-into', requireAdmin, async (req, res) => {
  try {
    const sourceAlbumId = String(req.params.id);
    const { targetAlbumId } = (req.body || {}) as { targetAlbumId?: string };
    if (!targetAlbumId) return res.status(400).json({ error: 'targetAlbumId is required' });
    if (sourceAlbumId === targetAlbumId) return res.status(400).json({ error: 'Cannot merge an album into itself' });
    await mergeAlbumIntoGroup(sourceAlbumId, targetAlbumId);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Album merge error:', error);
    res.status(500).json({ error: error?.message || 'Failed to merge album' });
  }
});

// Manual split: detach this album into a fresh release-group of its own.
router.post('/:id/unmerge', requireAdmin, async (req, res) => {
  try {
    await unmergeAlbumFromGroup(String(req.params.id));
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Album unmerge error:', error);
    res.status(500).json({ error: error?.message || 'Failed to unmerge album' });
  }
});

// All multi-role credits for every track on this album, keyed by track id.
// Used by AlbumDetail to render the per-track credit chips and the
// expanded "view credits" panel.
router.get('/:id/credits', async (req, res) => {
  try {
    const rows = await getAlbumCredits(String(req.params.id));
    const byTrack: Record<string, Array<{ artistId: string; artistName: string; role: string; position: number; detail?: string; source: string }>> = {};
    for (const r of rows) {
      const list = byTrack[r.track_id] || (byTrack[r.track_id] = []);
      list.push({
        artistId: r.artist_id,
        artistName: r.artist_name,
        role: r.role,
        position: r.position,
        detail: r.detail || undefined,
        source: r.source,
      });
    }
    res.json({ credits: byTrack });
  } catch (error) {
    console.error('Album credits fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch album credits' });
  }
});

// Credits for a single track. Used by the track context menu's
// "view credits" sub-panel without forcing a whole-album fetch.
router.get('/track/:id/credits', async (req, res) => {
  try {
    const rows = await getTrackCredits(String(req.params.id));
    res.json({
      credits: rows.map((r: any) => ({
        artistId: r.artist_id,
        artistName: r.artist_name,
        role: r.role,
        position: r.position,
        detail: r.detail || undefined,
        source: r.source,
      })),
    });
  } catch (error) {
    console.error('Track credits fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch track credits' });
  }
});

export default router;
