import { Router } from 'express';
import { getAlbumById, getAllAlbums, getTracksByAlbum } from '../database';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const albums = await getAllAlbums();
    res.json(albums);
  } catch (error) {
    console.error('Albums fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const album = await getAlbumById(req.params.id);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    const tracks = await getTracksByAlbum(req.params.id);
    res.json({ ...album, tracks });
  } catch (error) {
    console.error('Album fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch album' });
  }
});

export default router;
