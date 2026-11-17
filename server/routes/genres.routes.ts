import { Router } from 'express';
import { deprecatedRoute } from '../middleware/deprecatedRoute';
import { getGenreById, getAllGenres, getTracksByGenre, getGenreTaxonomyPaths } from '../database';

const router = Router();

router.get('/', deprecatedRoute('GET /api/v1/genres'), async (req, res) => {
  try {
    const genres = await getAllGenres();
    res.json(genres);
  } catch (error) {
    console.error('Genres fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

// MBDB-derived genre hierarchy for the library. Registered before '/:id' so the
// literal path is not captured by the param route. Always resolves: when the
// taxonomy has not been imported it returns { available: false }.
router.get('/taxonomy', async (req, res) => {
  try {
    res.json(await getGenreTaxonomyPaths());
  } catch (error) {
    console.error('Genre taxonomy fetch error:', error);
    res.json({ available: false, paths: {} });
  }
});

router.get('/:id', deprecatedRoute('GET /api/v1/genres/:id'), async (req, res) => {
  try {
    const genre = await getGenreById(req.params.id);
    if (!genre) return res.status(404).json({ error: 'Genre not found' });
    const tracks = await getTracksByGenre(req.params.id, genre.name, req.user?.userId || null);
    res.json({ ...genre, tracks });
  } catch (error) {
    console.error('Genre fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch genre' });
  }
});

export default router;
