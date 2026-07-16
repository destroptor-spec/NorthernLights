import { Router } from 'express';
import {
  getArtistById,
  getAllArtists,
  getTracksByArtist,
  getSimilarArtistsByAudioProfile,
  getArtistRolesInLibrary,
  getArtistAlbumsByRole,
  getArtistAlbumsAllRoles,
  getArtistAppearsOnTracks,
  getUncreditedTracksOnOwnedAlbums,
  getAlbumsOwnedByArtistName,
} from '../database';

const router = Router();

// Artists
router.get('/', async (req, res) => {
  try {
    const artists = await getAllArtists();
    res.json(artists);
  } catch (error) {
    console.error('Artists fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
});

router.get('/:id/similar', async (req, res) => {
  try {
    const artist = await getArtistById(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 8;
    const similarArtists = await getSimilarArtistsByAudioProfile(
      req.params.id,
      Number.isFinite(rawLimit) ? rawLimit : 8
    );
    res.json({ artists: similarArtists });
  } catch (error) {
    console.error('Similar artists fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch similar artists' });
  }
});

// Credit-driven role breakdown for an artist. Returns the roles they
// hold across the library (sorted by frequency) and, optionally, the
// albums where they hold a given role (when ?role=… is passed).
router.get('/:id/credits', async (req, res) => {
  try {
    const artistId = String(req.params.id);
    const role = typeof req.query.role === 'string' ? req.query.role.trim().toLowerCase() : '';
    const roles = await getArtistRolesInLibrary(artistId);
    const albumsByRole: Record<string, any[]> = {};
    if (role) {
      albumsByRole[role] = await getArtistAlbumsByRole(artistId, role);
    } else {
      // Single query for all roles instead of one round-trip per role.
      const rows = await getArtistAlbumsAllRoles(artistId);
      for (const row of rows) {
        const { role: rowRole, ...album } = row;
        (albumsByRole[rowRole] ||= []).push(album);
      }
    }
    res.json({ roles, albumsByRole });
  } catch (error) {
    console.error('Artist credits fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artist credits' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const artist = await getArtistById(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    // DJ-mix / mixed compilations the artist owns as album_artist without a
    // single performer credit are invisible to the artist_id track query.
    // Real artists get those albums' TRACKS appended (credited tracks stay
    // first: the client derives the artist's MBID and artist-level links from
    // them). VA pseudo-artists own hundreds of comps — a quarter of the
    // library's tracks — so they get lean album ROWS (ownedAlbums) instead.
    const isVaPseudo = !!artist.is_va_pseudo;
    const [tracks, roles, ownedAlbumTracks, ownedAlbums] = await Promise.all([
      getTracksByArtist(req.params.id, req.user?.userId || null),
      getArtistRolesInLibrary(req.params.id),
      isVaPseudo
        ? Promise.resolve([])
        : getUncreditedTracksOnOwnedAlbums(req.params.id, artist.name, req.user?.userId || null),
      isVaPseudo ? getAlbumsOwnedByArtistName(artist.name) : Promise.resolve([]),
    ]);
    res.json({ ...artist, tracks: [...tracks, ...ownedAlbumTracks], ownedAlbums, rolesInLibrary: roles });
  } catch (error) {
    console.error('Artist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

// Tracks this artist appears on but doesn't primarily own (collaborations,
// features). Separate from /:id so the main artist load stays lean.
router.get('/:id/appears-on', async (req, res) => {
  try {
    const artist = await getArtistById(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    const tracks = await getArtistAppearsOnTracks(req.params.id, artist.name, req.user?.userId || null);
    res.json({ tracks });
  } catch (error) {
    console.error('Artist appears-on fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch appears-on tracks' });
  }
});

export default router;
