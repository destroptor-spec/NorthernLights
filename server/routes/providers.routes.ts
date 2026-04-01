import { Router } from 'express';
import { getSystemSetting } from '../database';

const router = Router();

// ─── MusicBrainz Rate Limiter (1 req/s) ──────────────────────────────
const MB_USER_AGENT = 'AuroraMediaServer/1.0 (https://github.com/aurora-music)';
let mbLastRequest = 0;
const mbQueue: { fn: () => Promise<any>; resolve: (val: any) => void; reject: (err: any) => void }[] = [];
let mbQueueRunning = false;

async function mbFetch(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    mbQueue.push({ fn: async () => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': MB_USER_AGENT,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
      return res.json();
    }, resolve, reject });
    processMbQueue();
  });
}

async function processMbQueue() {
  if (mbQueueRunning) return;
  mbQueueRunning = true;
  while (mbQueue.length > 0) {
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - mbLastRequest));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const item = mbQueue.shift()!;
    mbLastRequest = Date.now();
    try {
      item.resolve(await item.fn());
    } catch (err) {
      item.reject(err);
    }
  }
  mbQueueRunning = false;
}

async function checkMbEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting('musicBrainzEnabled');
  return enabled === true || enabled === 'true';
}

// ─── MusicBrainz Proxy Routes ────────────────────────────────────────

router.get('/providers/musicbrainz/artist/:mbid', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { mbid } = req.params;
    const inc = req.query.inc || 'url-rels+tags+genres+ratings';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=${inc}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] artist error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/release-group/:mbid', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { mbid } = req.params;
    const inc = req.query.inc || 'genres+tags+ratings';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/release-group/${mbid}?inc=${inc}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] release-group error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/recording/:mbid', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { mbid } = req.params;
    const json = await mbFetch(`https://musicbrainz.org/ws/2/recording/${mbid}?inc=artist-credits+isrcs+tags&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] recording error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/isrc/:isrc', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { isrc } = req.params;
    const json = await mbFetch(`https://musicbrainz.org/ws/2/isrc/${isrc}?inc=artist-credits+tags&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] isrc error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/search/artist', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter q' });
    const limit = req.query.limit || '5';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query as string)}&limit=${limit}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] search error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/search/release-group', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter q' });
    const limit = req.query.limit || '5';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(query as string)}&limit=${limit}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] search release-group error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/test', async (req, res) => {
  try {
    const json = await mbFetch('https://musicbrainz.org/ws/2/artist/?query=radiohead&limit=1&fmt=json');
    if (json.artists) {
      res.json({ status: 'ok' });
    } else {
      res.status(502).json({ status: 'error', error: 'Unexpected response' });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

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

    if (!geniusRes.ok) {
      return res.status(geniusRes.status).json({ error: `Genius API returned ${geniusRes.status}` });
    }
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

    if (!geniusRes.ok) {
      return res.status(geniusRes.status).json({ error: `Genius API returned ${geniusRes.status}` });
    }
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
