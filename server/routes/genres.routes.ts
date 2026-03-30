import { Router } from 'express';
import { getGenreById, getAllGenres, getTracksByGenre } from '../database';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const genres = await getAllGenres();
    res.json(genres);
  } catch (error) {
    console.error('Genres fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const genre = await getGenreById(req.params.id);
    if (!genre) return res.status(404).json({ error: 'Genre not found' });
    const tracks = await getTracksByGenre(req.params.id);
    res.json({ ...genre, tracks });
  } catch (error) {
    console.error('Genre fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch genre' });
  }
});

export default router;
