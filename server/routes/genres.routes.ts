import { Router } from 'express';
import { getGenreTaxonomyPaths } from '../database';

const router = Router();

// MBDB-derived genre hierarchy for the library. Always resolves: when the
// taxonomy has not been imported it returns { available: false }.
router.get('/taxonomy', async (req, res) => {
  try {
    res.json(await getGenreTaxonomyPaths());
  } catch (error) {
    console.error('Genre taxonomy fetch error:', error);
    res.json({ available: false, paths: {} });
  }
});

export default router;
