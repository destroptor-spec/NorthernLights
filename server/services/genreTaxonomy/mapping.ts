/**
 * Original tags → genre / style mappings (phase 1 of docs/Aurora genre and
 * style redesign.md).
 *
 * Order per tag key: hand alias → exact genre → exact style → duplicate-review
 * merge → MusicBrainz alias → nearest MusicBrainz parent → compound tag split
 * ("Hard Rock/Heavy Metal"). Anything left goes to the review list. Manual rows and manual ignores are never touched; an
 * automatic row that is produced again keeps its review mark.
 */
import type { Pool } from 'pg';
import { getSystemSetting, setSystemSetting } from '../../database';
import { loadDiscogsLabels, loadTagAliases, parseLabel, tagKey } from './data';

// Bump when the resolution rules change; the alias file has its own version.
export const MAPPING_ALGORITHM_VERSION = 1;
const MB_SUBGENRE_LINK = 944810; // l_genre_genre: entity0 is the parent of entity1
const RELIABILITY = { exact: 1, alias: 1, merge: 1, mb_alias: 1, mb_parent: 0.8, compound: 0.8, ambiguous: 0.5 } as const;
// Compound tags list several genres in one string; normalisation turns these
// separators into spaces, so splitting works on the original text.
const COMPOUND_SEPARATOR = /\s*[/;|]\s*/;

export type MappingMethod = 'exact' | 'alias' | 'merge' | 'mb_alias' | 'mb_parent' | 'compound';
export interface ResolvedMapping { genre: string; styleLabel: string | null; method: MappingMethod; reliability: number; detail: string | null }

export function mappingVersion(aliasVersion: number) {
  return MAPPING_ALGORITHM_VERSION * 1000 + aliasVersion;
}

// ── Resolution ───────────────────────────────────────────────────────────

export interface MappingContext {
  aliases: Record<string, string>;
  genreByKey: Map<string, string>;
  stylesByKey: Map<string, string[]>;   // style-name key → full labels (16 names have two)
  mergedInto: Map<string, string>;       // duplicate-review merge: key → canonical genre name
  mbNameByKey: Map<string, number>;      // MusicBrainz genre name key → id
  mbAliasByKey: Map<string, number>;     // MusicBrainz alias key → genre id
  mbName: Map<number, string>;
  mbParents: Map<number, number[]>;
}

export function buildContext(labels: string[], aliases: Record<string, string>, extra?: Partial<MappingContext>): MappingContext {
  const genreByKey = new Map<string, string>();
  const stylesByKey = new Map<string, string[]>();
  for (const label of labels) {
    const { genre, name } = parseLabel(label);
    genreByKey.set(tagKey(genre), genre);
    const key = tagKey(name);
    stylesByKey.set(key, [...(stylesByKey.get(key) || []), label]);
  }
  return {
    aliases, genreByKey, stylesByKey,
    mergedInto: extra?.mergedInto ?? new Map(),
    mbNameByKey: extra?.mbNameByKey ?? new Map(),
    mbAliasByKey: extra?.mbAliasByKey ?? new Map(),
    mbName: extra?.mbName ?? new Map(),
    mbParents: extra?.mbParents ?? new Map(),
  };
}

function target(value: string): { genre: string; styleLabel: string | null } {
  return value.includes('---') ? { genre: parseLabel(value).genre, styleLabel: value } : { genre: value, styleLabel: null };
}

/** Exact genre or style name; ambiguous style names yield one low-reliability row per genre. */
function direct(key: string, ctx: MappingContext): Array<{ genre: string; styleLabel: string | null; ambiguous: boolean }> {
  if (ctx.aliases[key]) return [{ ...target(ctx.aliases[key]), ambiguous: false }];
  const genre = ctx.genreByKey.get(key);
  if (genre) return [{ genre, styleLabel: null, ambiguous: false }];
  const styles = ctx.stylesByKey.get(key) || [];
  return styles.map(label => ({ genre: parseLabel(label).genre, styleLabel: label, ambiguous: styles.length > 1 }));
}

function rows(hits: ReturnType<typeof direct>, method: MappingMethod, detail: string | null): ResolvedMapping[] {
  return hits.map(hit => ({
    genre: hit.genre,
    styleLabel: hit.styleLabel,
    method,
    reliability: hit.ambiguous ? RELIABILITY.ambiguous : RELIABILITY[method],
    detail: hit.ambiguous ? [detail, 'ambiguous style name'].filter(Boolean).join('; ') : detail,
  }));
}

function resolveSingle(key: string, ctx: MappingContext): ResolvedMapping[] {
  if (ctx.aliases[key]) return rows(direct(key, ctx), 'alias', null);
  const exact = direct(key, ctx);
  if (exact.length) return rows(exact, 'exact', null);

  const canonical = ctx.mergedInto.get(key);
  if (canonical) {
    const hits = direct(tagKey(canonical), ctx);
    if (hits.length) return rows(hits, 'merge', `merged into ${canonical}`);
  }

  const mbId = ctx.mbNameByKey.get(key) ?? ctx.mbAliasByKey.get(key);
  if (mbId === undefined) return [];
  const mbName = ctx.mbName.get(mbId) || '';
  if (!ctx.mbNameByKey.has(key)) {
    const hits = direct(tagKey(mbName), ctx);
    if (hits.length) return rows(hits, 'mb_alias', `MusicBrainz alias of ${mbName}`);
  }
  // Nearest ancestor(s) that map; several at the same depth all count.
  let frontier = [mbId];
  const seen = new Set(frontier);
  for (let depth = 1; depth <= 6 && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) for (const parent of ctx.mbParents.get(id) || []) {
      if (!seen.has(parent)) { seen.add(parent); next.push(parent); }
    }
    const found: ResolvedMapping[] = [];
    for (const parent of next) {
      const parentName = ctx.mbName.get(parent) || '';
      found.push(...rows(direct(tagKey(parentName), ctx), 'mb_parent', `via ${parentName}, ${depth} up`));
    }
    if (found.length) {
      const unique = new Map(found.map(r => [`${r.genre}|${r.styleLabel}`, r]));
      return Array.from(unique.values()).map(r => ({ ...r, reliability: Math.min(r.reliability, RELIABILITY.mb_parent) }));
    }
    frontier = next;
  }
  return [];
}

/**
 * Resolves one tag key. `original` (any original spelling of the tag) lets a
 * compound tag such as "R&B / Soul / Funk" map each part when the whole fails.
 */
export function resolveTag(key: string, ctx: MappingContext, original?: string): ResolvedMapping[] {
  const whole = resolveSingle(key, ctx);
  if (whole.length || !original) return whole;
  const parts = original.split(COMPOUND_SEPARATOR).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const found = new Map<string, ResolvedMapping>();
  const resolvedParts: string[] = [];
  for (const part of parts) {
    const hits = resolveSingle(tagKey(part), ctx);
    if (hits.length) resolvedParts.push(part);
    for (const hit of hits) {
      const id = `${hit.genre}|${hit.styleLabel}`;
      if (!found.has(id)) found.set(id, { ...hit, method: 'compound', reliability: Math.min(hit.reliability, RELIABILITY.compound), detail: `part "${part}" of compound tag` });
    }
  }
  return Array.from(found.values());
}

async function loadContext(db: Pool, labels: string[], aliases: Record<string, string>): Promise<MappingContext> {
  const merged = (await db.query(
    `SELECT g.name, c.name AS canonical FROM genres g JOIN genres c ON c.id = g.merged_into`)).rows;
  const mbGenres = (await db.query('SELECT id, name FROM genre')).rows as { id: number; name: string }[];
  const mbAliases = (await db.query('SELECT genre, name FROM genre_alias')).rows as { genre: number; name: string }[];
  const links = (await db.query('SELECT entity0, entity1 FROM l_genre_genre WHERE link = $1', [MB_SUBGENRE_LINK])).rows as { entity0: number; entity1: number }[];
  const mbParents = new Map<number, number[]>();
  for (const l of links) mbParents.set(l.entity1, [...(mbParents.get(l.entity1) || []), l.entity0]);
  return buildContext(labels, aliases, {
    mergedInto: new Map(merged.map((m: any) => [tagKey(m.name), m.canonical])),
    mbNameByKey: new Map(mbGenres.map(g => [tagKey(g.name), g.id])),
    mbAliasByKey: new Map(mbAliases.map(a => [tagKey(a.name), a.genre])),
    mbName: new Map(mbGenres.map(g => [g.id, g.name])),
    mbParents,
  });
}

// ── Mapping run ──────────────────────────────────────────────────────────

export interface MappingRunResult { version: number; keys: number; mapped: number; unmapped: number; rowsWritten: number; rowsRemoved: number }

/**
 * Maps every tag key seen in track_tags or artist_tags. Incremental by
 * default (keys without any decision yet); `full` re-resolves every key that
 * has no manual decision, e.g. after the alias file or algorithm changed.
 */
export async function runTagMapping(db: Pool, { full = false } = {}): Promise<MappingRunResult> {
  const { raw, styles } = loadDiscogsLabels();
  const aliasData = loadTagAliases(raw.classes);
  const version = mappingVersion(aliasData.aliasVersion);
  const styleId = new Map((await db.query('SELECT id, label FROM style')).rows.map((r: any) => [r.label, r.id as number]));
  if (styleId.size < styles.length) throw new Error('Taxonomy not seeded');

  const decided = full
    ? `SELECT tag FROM tag_map WHERE method = 'manual' UNION SELECT tag FROM tag_ignored WHERE source = 'manual'`
    : `SELECT tag FROM tag_map UNION SELECT tag FROM tag_ignored`;
  const keyRows = (await db.query(
    `SELECT k, MIN(example) AS example FROM (
       SELECT tag_key AS k, tag AS example FROM track_tags
       UNION ALL SELECT tag_key, tag FROM artist_tags) all_keys
     WHERE k NOT IN (${decided}) GROUP BY k`)).rows as { k: string; example: string }[];
  const keys = keyRows.map(r => r.k);
  const example = new Map(keyRows.map(r => [r.k, r.example]));
  const ctx = await loadContext(db, raw.classes, aliasData.aliases);

  let mapped = 0; let rowsWritten = 0; let rowsRemoved = 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const key of keys) {
      if (aliasData.ignored[key]) {
        await client.query(
          `INSERT INTO tag_ignored (tag, reason, source) VALUES ($1, $2, 'seed')
           ON CONFLICT (tag) DO NOTHING`, [key, aliasData.ignored[key]]);
        rowsRemoved += (await client.query(`DELETE FROM tag_map WHERE tag = $1 AND method <> 'manual'`, [key])).rowCount || 0;
        continue;
      }
      // No longer on the alias file's ignore list: drop a seeded ignore.
      await client.query(`DELETE FROM tag_ignored WHERE tag = $1 AND source = 'seed'`, [key]);
      const resolved = resolveTag(key, ctx, example.get(key));
      if (resolved.length) mapped++;
      const keep: Array<[string, number | null]> = [];
      for (const r of resolved) {
        const sid = r.styleLabel ? styleId.get(r.styleLabel) ?? null : null;
        keep.push([r.genre, sid]);
        await client.query(
          `INSERT INTO tag_map (tag, genre, style_id, method, reliability, mapping_version, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tag, genre, style_id) DO UPDATE SET
             method = EXCLUDED.method, reliability = EXCLUDED.reliability,
             mapping_version = EXCLUDED.mapping_version, detail = EXCLUDED.detail
           WHERE tag_map.method <> 'manual'`,
          [key, r.genre, sid, r.method, r.reliability, version, r.detail]);
        rowsWritten++;
      }
      // Drop automatic rows this run no longer produces (review marks go with them).
      const stale = await client.query(
        `DELETE FROM tag_map WHERE tag = $1 AND method <> 'manual'
           AND NOT ((genre, COALESCE(style_id, -1)) IN (SELECT g, COALESCE(s, -1) FROM unnest($2::text[], $3::int[]) AS k(g, s)))`,
        [key, keep.map(k => k[0]), keep.map(k => k[1])]);
      rowsRemoved += stale.rowCount || 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await setSystemSetting('tagMappingVersion', version);
  return { version, keys: keys.length, mapped, unmapped: keys.length - mapped, rowsWritten, rowsRemoved };
}

export async function mappingIsCurrent(): Promise<boolean> {
  const { raw } = loadDiscogsLabels();
  const version = mappingVersion(loadTagAliases(raw.classes).aliasVersion);
  return Number(await getSystemSetting('tagMappingVersion')) === version;
}
