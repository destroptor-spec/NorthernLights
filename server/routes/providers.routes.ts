import { Router } from 'express';
import { getSystemSetting } from '../database';

const router = Router();

// Genius API proxy — avoids CORS issues in browser
router.post('/providers/genius/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Genius API key not configured' });

    const geniusRes = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const json = await geniusRes.json();
    res.status(geniusRes.status).json(json);
  } catch (err: any) {
    console.error('[Genius Proxy] search error:', err.message);
    res.status(502).json({ error: 'Genius API request failed' });
  }
});

router.post('/providers/genius/artist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Genius API key not configured' });

    const geniusRes = await fetch(`https://api.genius.com/artists/${id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const json = await geniusRes.json();
    res.status(geniusRes.status).json(json);
  } catch (err: any) {
    console.error('[Genius Proxy] artist error:', err.message);
    res.status(502).json({ error: 'Genius API request failed' });
  }
});

// Test endpoint — validates the configured key or one provided in body
router.post('/providers/genius/test', async (req, res) => {
  try {
    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ status: 'error', error: 'No API key configured' });

    const geniusRes = await fetch(`https://api.genius.com/search?q=test`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (geniusRes.ok) {
      res.json({ status: 'ok' });
    } else if (geniusRes.status === 401) {
      res.status(401).json({ status: 'error', error: 'Invalid token' });
    } else {
      res.status(geniusRes.status).json({ status: 'error', error: `HTTP ${geniusRes.status}` });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

export default router;
