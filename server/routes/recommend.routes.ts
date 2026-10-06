import { Router } from 'express';
import { nextRecommendationSchema } from '../../shared/api/v1';
import { getNextInfinityTrackForUser } from '../services/infinityRequest.service';

const router = Router();
const requestSchema = nextRecommendationSchema.omit({ exclude: true }).extend({
  excludeTrackIds: nextRecommendationSchema.shape.exclude,
}).strip();

router.post('/recommend', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid recommendation request' });
  try {
    const { excludeTrackIds, ...input } = parsed.data;
    const track = await getNextInfinityTrackForUser(req.user?.userId, { ...input, exclude: excludeTrackIds });
    res.json({ track: track ?? null });
  } catch (error) {
    console.error('Infinity recommendation error:', error);
    res.status(500).json({ error: 'Failed to compute next track' });
  }
});

export default router;
