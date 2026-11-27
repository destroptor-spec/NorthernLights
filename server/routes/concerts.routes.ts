import { Router } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  getSystemSetting,
  getArtistById,
  getArtistSubscriptions,
  countArtistSubscriptions,
  isSubscribedToArtist,
  addArtistSubscription,
  removeArtistSubscription,
  searchLibraryArtists,
  getUserTopArtists,
  getUpcomingEventsForArtist,
  getHubEventsForUser,
  getArtistConcertsCache,
  getUserSetting,
  dismissAutoArtist,
  undismissAutoArtist,
  getDismissedAutoArtists,
  getAutoAddCandidates,
  isCompilationArtistName,
} from '../database';
import {
  isJambaseEnabled,
  testJambaseConnection,
  getCurrentMonthUsage,
  refreshArtistConcertsIfStale,
  JambaseBudgetError,
  JambaseConfigError,
} from '../services/jambase.service';

const router = Router();

// Concert lookups fan out to external services (JamBase) and the DB. Apply a
// per-user/IP rate limit across every route on this router.
router.use(createRateLimiter({
  keyPrefix: 'concerts',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many concert requests. Try again later.',
}));

// Fill the user's empty subscription slots with their top-played artists.
// No-op if auto-add is disabled, or if all slots are already filled.
// Newly added subscriptions kick off a background cache warm-up so the Hub
// card has data ready next time the user opens it.
async function runAutoAddForUser(userId: string): Promise<{ added: number; skipped: string }> {
  const enabled = await getUserSetting(userId, 'concertsAutoAddEnabled');
  if (enabled !== true) return { added: 0, skipped: 'disabled' };

  const max = ((await getSystemSetting('jambaseMaxSubscriptionsPerUser')) as number | null) ?? 10;
  const current = await countArtistSubscriptions(userId);
  const slots = max - current;
  if (slots <= 0) return { added: 0, skipped: 'no-slots' };

  const candidates = await getAutoAddCandidates(userId, slots);
  let added = 0;
  for (const c of candidates) {
    await addArtistSubscription(userId, (c as any).id, 'auto');
    refreshArtistConcertsIfStale((c as any).id).catch(() => {});
    added += 1;
  }
  return { added, skipped: '' };
}

// ─── Admin: connection / status / usage ──────────────────────────────

router.get('/providers/jambase/status', requireAdmin, async (_req, res) => {
  try {
    const enabled = (await getSystemSetting('jambaseEnabled')) === true;
    const hasKey = !!(process.env.JAMBASE_API_KEY || '').trim();
    const usage = await getCurrentMonthUsage();
    res.json({
      enabled,
      hasKey,
      usage,
      maxSubscriptionsPerUser: (await getSystemSetting('jambaseMaxSubscriptionsPerUser')) ?? 10,
      cacheTtlDays: (await getSystemSetting('jambaseCacheTtlDays')) ?? 7,
      hardStop: (await getSystemSetting('jambaseHardStop')) ?? true,
      monthlyCap: (await getSystemSetting('jambaseMonthlyCap')) ?? 1000,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/jambase/test', requireAdmin, async (_req, res) => {
  try {
    const result = await testJambaseConnection();
    if (result.ok) {
      res.json({ status: 'ok', sample: result.sample });
    } else {
      res.status(400).json({ status: 'error', error: result.error });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

// ─── User: subscriptions ─────────────────────────────────────────────

router.get('/concerts/subscriptions', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const subs = await getArtistSubscriptions(userId);
    const max = ((await getSystemSetting('jambaseMaxSubscriptionsPerUser')) as number | null) ?? 10;
    res.json({ subscriptions: subs, max });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/concerts/subscriptions/:artistId', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const artistId = String(req.params.artistId);

    const artist = await getArtistById(artistId);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    if (isCompilationArtistName((artist as any).name)) {
      return res.status(400).json({ error: 'Cannot subscribe to compilation artists' });
    }

    const already = await isSubscribedToArtist(userId, artistId);
    if (already) return res.json({ status: 'ok', alreadySubscribed: true });

    const max = ((await getSystemSetting('jambaseMaxSubscriptionsPerUser')) as number | null) ?? 10;
    const current = await countArtistSubscriptions(userId);
    if (current >= max) {
      return res.status(400).json({ error: `Subscription limit reached (${max}). Remove an artist to add another.` });
    }

    await addArtistSubscription(userId, artistId);

    // Best-effort warm-up of the cache for the newly subscribed artist so the
    // Hub card has something to show immediately. Failures are silent — the
    // user can still see other artists' events while this one resolves.
    refreshArtistConcertsIfStale(artistId).catch(() => {});

    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/concerts/subscriptions/:artistId', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const artistId = String(req.params.artistId);
    const removedSource = await removeArtistSubscription(userId, artistId);
    // If the row was auto-added, dismiss it so the next auto-add run doesn't
    // immediately put it back. Explicit removals leave the dismissed list
    // alone — the user might just want to re-add later.
    if (removedSource === 'auto') {
      await dismissAutoArtist(userId, artistId);
    }
    // Re-fill the freed slot with the next-best candidate (no-op if disabled).
    runAutoAddForUser(userId).catch(() => {});
    res.json({ status: 'ok', dismissedAuto: removedSource === 'auto' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User: auto-add controls ─────────────────────────────────────────

router.post('/concerts/auto-add/refresh', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const result = await runAutoAddForUser(userId);
    res.json({ status: 'ok', ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/concerts/auto-add/dismissed', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const dismissed = await getDismissedAutoArtists(userId);
    res.json({ dismissed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/concerts/auto-add/undismiss/:artistId', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const artistId = String(req.params.artistId);
    await undismissAutoArtist(userId, artistId);
    // After un-dismissing, re-run auto-add so this artist can re-enter the
    // candidate pool immediately if a slot is open.
    runAutoAddForUser(userId).catch(() => {});
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User: library-only artist lookup ────────────────────────────────

router.get('/concerts/library/artist-search', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const q = (req.query.q as string) || '';
    if (!q.trim()) return res.json({ artists: [] });
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10) || 20, 50);
    const artists = await searchLibraryArtists(userId, q, limit);
    res.json({ artists });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/concerts/library/top-artists', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(parseInt((req.query.limit as string) || '10', 10) || 10, 50);
    const artists = await getUserTopArtists(userId, limit);
    res.json({ artists });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User: read events ───────────────────────────────────────────────

// Hub feed — events for subscribed artists, optionally filtered to a radius
// around the user's saved location. Reads from cache only; never triggers a
// fetch (refresh happens lazily on subscribe / artist-detail visit).
router.get('/concerts/hub', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const concertsEnabled = await getUserSetting(userId, 'concertsEnabled');
    if (concertsEnabled !== true) {
      return res.json({ events: [], disabled: true });
    }

    const lat = (await getUserSetting(userId, 'concertsLat')) as number | null;
    const lng = (await getUserSetting(userId, 'concertsLng')) as number | null;
    const radius = ((await getUserSetting(userId, 'concertsRadiusKm')) as number | null) ?? 50;

    const events = await getHubEventsForUser(userId, {
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      radiusKm: radius,
      limit: 20,
    });

    const usage = await getCurrentMonthUsage();
    // The server's time zone, so the Hub writes show dates and times the way
    // they're written where Aurora runs (24-hour in Europe). Show times
    // themselves stay the venue's own wall clock.
    res.json({ events, stale: usage.stopped, usage: { stopped: usage.stopped }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single artist's upcoming events. Visiting this endpoint triggers a stale-
// check refresh. This is the "explicit" budget tier — bounded by the cache TTL
// and the global hard stop.
router.get('/concerts/artist/:artistId', requireAuth, async (req, res) => {
  try {
    const artistId = String(req.params.artistId);

    if (!(await isJambaseEnabled())) {
      // Even if disabled at the system level, we'll still return whatever's
      // in cache — the sticker/ section just won't be live.
      const events = await getUpcomingEventsForArtist(artistId, 5);
      return res.json({ events, refreshed: false, disabled: true });
    }

    let refreshed = false;
    let stale = false;
    try {
      const r = await refreshArtistConcertsIfStale(artistId);
      refreshed = r.refreshed;
    } catch (err) {
      if (err instanceof JambaseBudgetError) {
        stale = true;
      } else if (err instanceof JambaseConfigError) {
        // No key — fall back to whatever cache exists.
      } else {
        // Don't fail the request; show cached results and signal staleness.
        stale = true;
      }
    }

    const events = await getUpcomingEventsForArtist(artistId, 5);
    const cache = await getArtistConcertsCache(artistId);
    res.json({
      events,
      refreshed,
      stale,
      onTour: events.length > 0,
      lastFetchedAt: cache?.fetched_at || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
