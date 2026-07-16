import { Router, type NextFunction, type Request, type Response } from 'express';
import { initDB } from '../database';
import { getTrustedClientIp } from '../middleware/clientIp';

const router = Router();

const MAX_GROUPS = 5;
const MAX_CONDITIONS_PER_GROUP = 10;
const MAX_VALUE_LENGTH = 200;
const MAX_RESULT_IDS = 5000;
const FILTER_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const FILTER_RATE_LIMIT_MAX = 120;

type FilterRateLimitEntry = { count: number; resetAt: number };
const filterRateLimits = new Map<string, FilterRateLimitEntry>();

const ALLOWED_OPERATORS = new Set([
  'contains', 'equals', 'starts with', 'before', 'after',
  'greater than', 'less than', 'is', 'is not',
]);

type Mode = 'text' | 'json' | 'numeric' | 'image_url';

interface FieldDef {
  /** Real DB column name on the primary table. */
  column: string;
  mode: Mode;
  /** Resolve via an EXISTS subquery on tracks (album-derived fields). */
  via?: 'tracks';
  /** Additional column to OR-match against (e.g. tracks.genre alongside tracks.genres). */
  extraColumn?: string;
  /** Postgres expression that yields a numeric year/integer; defaults to CAST(column AS INTEGER). */
  numericExpr?: string;
}

const YEAR_FROM_TEXT = (col: string) =>
  `NULLIF(SUBSTRING(${col} FROM '^[0-9]{4}'), '')::INTEGER`;

const ARTIST_FIELDS: Record<string, FieldDef> = {
  genre: { column: 'genres', mode: 'json' },
  artist_type: { column: 'artist_type', mode: 'text' },
  area: { column: 'area', mode: 'text' },
  lifespan_begin: {
    column: 'lifespan_begin',
    mode: 'numeric',
    numericExpr: YEAR_FROM_TEXT('lifespan_begin'),
  },
  community_tags: { column: 'community_tags', mode: 'json' },
  image_url: { column: 'image_url', mode: 'image_url' },
  listeners: { column: 'listeners', mode: 'numeric' },
  name: { column: 'name', mode: 'text' },
};

const ALBUM_FIELDS: Record<string, FieldDef> = {
  // Albums don't carry genre/release_type/year directly; resolve through tracks.
  genre: { column: 'genres', mode: 'json', via: 'tracks', extraColumn: 'genre' },
  release_type: { column: 'release_type', mode: 'text', via: 'tracks' },
  year: { column: 'year', mode: 'numeric', via: 'tracks' },
  artist_name: { column: 'artist_name', mode: 'text' },
  tags: { column: 'tags', mode: 'json' },
  image_url: { column: 'image_url', mode: 'image_url' },
  listeners: { column: 'listeners', mode: 'numeric' },
  title: { column: 'title', mode: 'text' },
};

interface BuildResult { sql: string; params: any[]; }

function consumeFilterRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const routeKey = req.path || req.originalUrl;
  const userKey = req.user?.userId ? `user:${req.user.userId}` : `ip:${getTrustedClientIp(req)}`;
  const key = `${routeKey}:${userKey}`;
  const existing = filterRateLimits.get(key);

  for (const [entryKey, entry] of filterRateLimits) {
    if (entry.resetAt <= now) filterRateLimits.delete(entryKey);
  }

  const nextEntry: FilterRateLimitEntry = existing && existing.resetAt > now
    ? { count: existing.count + 1, resetAt: existing.resetAt }
    : { count: 1, resetAt: now + FILTER_RATE_LIMIT_WINDOW_MS };

  filterRateLimits.set(key, nextEntry);

  if (nextEntry.count > FILTER_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((nextEntry.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many filter requests. Try again later.' });
  }

  next();
}

/** Build the SQL fragment for a single condition relative to its base table.
 *  The fragment references the column by its bare name; the caller wraps in
 *  EXISTS(...) when the field resolves through tracks. */
function buildInnerCondition(
  def: FieldDef,
  operator: string,
  value: string,
  paramIdx: number,
): BuildResult | null {
  const col = def.column;
  const next = () => paramIdx + 1;

  if (def.mode === 'image_url') {
    if (operator === 'is') return { sql: `${col} IS NOT NULL AND ${col} != ''`, params: [] };
    if (operator === 'is not') return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
    return null;
  }

  if (def.mode === 'numeric') {
    const num = parseInt(value, 10);
    if (!Number.isFinite(num)) return null;
    const expr = def.numericExpr || `CAST(${col} AS INTEGER)`;
    switch (operator) {
      case 'equals':
      case 'is':
        return { sql: `${expr} = $${next()}`, params: [num] };
      case 'is not':
        return { sql: `${expr} != $${next()}`, params: [num] };
      case 'before':
      case 'less than':
        return { sql: `${expr} < $${next()}`, params: [num] };
      case 'after':
      case 'greater than':
        return { sql: `${expr} > $${next()}`, params: [num] };
      default:
        return null;
    }
  }

  if (def.mode === 'json') {
    // Columns store stringified JSON (either string arrays or {name} object
    // arrays). Treat operators as substring matches against the serialized
    // text. The same placeholder is referenced twice when extraColumn is
    // set, so only one param is pushed.
    const p = next();
    const ilike = `${col} ILIKE $${p}`;
    const extraIlike = def.extraColumn ? ` OR ${def.extraColumn} ILIKE $${p}` : '';
    const extraNot = def.extraColumn
      ? ` AND (${def.extraColumn} IS NULL OR ${def.extraColumn} NOT ILIKE $${p})`
      : '';
    switch (operator) {
      case 'contains':
      case 'equals':
      case 'is':
        return { sql: `(${ilike}${extraIlike})`, params: [`%${value}%`] };
      case 'starts with':
        return { sql: `(${ilike}${extraIlike})`, params: [`%"${value}%`] };
      case 'is not':
        return {
          sql: `((${col} IS NULL OR ${col} NOT ILIKE $${p})${extraNot})`,
          params: [`%${value}%`],
        };
      default:
        return null;
    }
  }

  // text mode
  switch (operator) {
    case 'contains':
      return { sql: `${col} ILIKE $${next()}`, params: [`%${value}%`] };
    case 'equals':
    case 'is':
      return { sql: `${col} = $${next()}`, params: [value] };
    case 'is not':
      return { sql: `${col} != $${next()}`, params: [value] };
    case 'starts with':
      return { sql: `${col} ILIKE $${next()}`, params: [`${value}%`] };
    default:
      return null;
  }
}

function buildCondition(
  view: 'artists' | 'albums',
  metadataType: string,
  operator: string,
  value: string,
  paramIdx: number,
): BuildResult | null {
  if (!ALLOWED_OPERATORS.has(operator)) return null;
  const fields = view === 'artists' ? ARTIST_FIELDS : ALBUM_FIELDS;
  const def = fields[metadataType];
  if (!def) return null;

  if (view === 'albums' && metadataType === 'genre') {
    const parameter = `$${paramIdx + 1}`;
    const exact = operator === 'equals' || operator === 'is' || operator === 'is not';
    const positive = exact ? `lower(g.name) = lower(${parameter})` : `g.name ILIKE ${parameter}`;
    const pattern = exact ? value : operator === 'starts with' ? `${value}%` : `%${value}%`;
    if (operator === 'is not') {
      return {
        sql: `NOT EXISTS (
          SELECT 1 FROM tracks t
          JOIN track_genres tg ON tg.track_id = t.id
          JOIN genres g ON g.id = tg.genre_id
          WHERE t.album_id = albums.id AND ${positive}
        )`,
        params: [pattern],
      };
    }
    if (['contains', 'equals', 'is', 'starts with'].includes(operator)) {
      return {
        sql: `EXISTS (
          SELECT 1 FROM tracks t
          JOIN track_genres tg ON tg.track_id = t.id
          JOIN genres g ON g.id = tg.genre_id
          WHERE t.album_id = albums.id AND ${positive}
        )`,
        params: [pattern],
      };
    }
    return null;
  }

  const inner = buildInnerCondition(def, operator, value, paramIdx);
  if (!inner) return null;

  if (def.via === 'tracks') {
    return {
      sql: `EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id AND (${inner.sql}))`,
      params: inner.params,
    };
  }
  return inner;
}

interface QueryCondition { metadataType: string; operator: string; value: string; }
interface QueryGroup { id: string; conditions: QueryCondition[]; }

function validateGroups(
  raw: unknown,
): { groups: QueryGroup[]; error?: undefined } | { error: string; groups?: undefined } {
  if (!Array.isArray(raw)) return { error: 'groups must be an array' };
  if (raw.length > MAX_GROUPS) return { error: `Maximum ${MAX_GROUPS} query groups allowed` };

  const groups: QueryGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object' || !Array.isArray((g as any).conditions)) {
      return { error: 'Each group must have a conditions array' };
    }
    const rawConds = (g as any).conditions;
    if (rawConds.length > MAX_CONDITIONS_PER_GROUP) {
      return { error: `Maximum ${MAX_CONDITIONS_PER_GROUP} conditions per group allowed` };
    }
    const conditions: QueryCondition[] = [];
    for (const c of rawConds) {
      if (!c || typeof c !== 'object') continue;
      const metadataType = String(c.metadataType || '');
      const operator = String(c.operator || '');
      const value = String(c.value || '').slice(0, MAX_VALUE_LENGTH);
      conditions.push({ metadataType, operator, value });
    }
    if (conditions.length > 0) {
      groups.push({ id: String((g as any).id || ''), conditions });
    }
  }
  return { groups };
}

function buildSql(view: 'artists' | 'albums', groups: QueryGroup[]): BuildResult {
  const params: any[] = [];
  const groupClauses: string[] = [];
  for (const group of groups) {
    const condClauses: string[] = [];
    for (const cond of group.conditions) {
      const built = buildCondition(view, cond.metadataType, cond.operator, cond.value, params.length);
      if (!built) continue;
      condClauses.push(built.sql);
      params.push(...built.params);
    }
    if (condClauses.length > 0) {
      groupClauses.push(`(${condClauses.join(' OR ')})`);
    }
  }
  if (groupClauses.length === 0) return { sql: '', params: [] };
  return { sql: ` AND (${groupClauses.join(' AND ')})`, params };
}

router.post('/artists', consumeFilterRateLimit, async (req, res) => {
  try {
    const result = validateGroups(req.body.groups);
    if (result.error) return res.status(400).json({ error: result.error });
    const groups = result.groups!;
    if (groups.length === 0) return res.json({ ids: [] });

    const { sql, params } = buildSql('artists', groups);
    if (!sql) return res.json({ ids: [] });

    const db = await initDB();
    const query = `SELECT id FROM artists WHERE merged_into IS NULL${sql} LIMIT ${MAX_RESULT_IDS}`;
    const dbResult = await db.query(query, params);
    res.json({ ids: dbResult.rows.map((r: any) => r.id) });
  } catch (error) {
    console.error('Filter artists error:', error);
    res.status(500).json({ error: 'Failed to filter artists' });
  }
});

router.post('/albums', consumeFilterRateLimit, async (req, res) => {
  try {
    const result = validateGroups(req.body.groups);
    if (result.error) return res.status(400).json({ error: result.error });
    const groups = result.groups!;
    if (groups.length === 0) return res.json({ ids: [] });

    const { sql, params } = buildSql('albums', groups);
    if (!sql) return res.json({ ids: [] });

    const db = await initDB();
    const query = `SELECT id FROM albums WHERE 1=1${sql} LIMIT ${MAX_RESULT_IDS}`;
    const dbResult = await db.query(query, params);
    res.json({ ids: dbResult.rows.map((r: any) => r.id) });
  } catch (error) {
    console.error('Filter albums error:', error);
    res.status(500).json({ error: 'Failed to filter albums' });
  }
});

export default router;
