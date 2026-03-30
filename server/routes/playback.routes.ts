import { Router } from 'express';
import { recordPlaybackForUser, recordSkipForUser } from '../database';
import { addToSessionHistory } from '../state';

const router = Router();

// Record session history for Infinity Mode
router.post('/history', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  addToSessionHistory(req.user.userId, trackId);
  res.json({ status: 'recorded' });
});

// Record a successful playback
router.post('/record', async (req, res) => {
  try {
    const { trackId } = req.body;
    if (!trackId) return res.status(400).json({ error: 'trackId required' });
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await recordPlaybackForUser(userId, trackId);
    addToSessionHistory(userId, trackId);
    res.json({ status: 'recorded' });
  } catch (err) {
    console.error('Playback record error:', err);
    res.status(500).json({ error: 'Failed to record playback' });
  }
});

// Record a track skip
router.post('/skip', async (req, res) => {
  try {
    const { trackId } = req.body;
    if (!trackId) return res.status(400).json({ error: 'trackId required' });
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await recordSkipForUser(userId, trackId);
    res.json({ status: 'recorded' });
  } catch (err) {
    console.error('Skip record error:', err);
    res.status(500).json({ error: 'Failed to record skip' });
  }
});

export default router;
