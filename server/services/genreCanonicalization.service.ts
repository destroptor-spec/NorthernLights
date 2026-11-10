import type { PoolClient } from 'pg';
import {
  initDB,
  invalidateGenreEntityCache,
  setSystemSetting,
} from '../database';
import {
  isSlashCompoundGenre,
  normalizeGenreIdentity,
  scoreGenreSimilarity,
  type GenreSimilarityEvidence,
} from '../utils/genreIdentity';

const MIN_CANDIDATE_SCORE = 65;

interface GenreReviewRow {
  id: string;
  name: string;
  normalizedKey: string;
  trackCount: number;
  albumCount: number;
  taxonomyPath: string | null;
  exactMbPath: string | null;
}

export interface GenreDuplicateCandidate {
  candidateKey: string;
  signature: string;
  score: number;
  reasons: string[];
  taxonomyConflict: boolean;
  genres: GenreReviewRow[];
}

export interface GenreCompoundCandidate {
  candidateKey: string;
  signature: string;
  genre: GenreReviewRow;
  reason: 'compound-tag';
}

export interface ActiveGenreGroup {
  canonical: GenreReviewRow;
  aliases: GenreReviewRow[];
}

function pathRoot(path: string | null): string | null {
  return path ? path.split('.')[0]?.trim().toLowerCase() || null : null;
}

function sortGenreRows(rows: GenreReviewRow[]): GenreReviewRow[] {
  return [...rows].sort((a, b) => b.trackCount - a.trackCount || a.name.localeCompare(b.name));
}

function candidateSignature(rows: GenreReviewRow[]): string {
  return [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(row => `${row.id}:${row.name}:${row.trackCount}:${row.albumCount}:${row.taxonomyPath || ''}`)
    .join('|');
}

function hasTaxonomyConflict(rows: GenreReviewRow[]): boolean {
  const roots = new Set(rows.map(row => pathRoot(row.taxonomyPath)).filter(Boolean));
  return roots.size > 1;
}

async function fetchGenreReviewRows(client?: PoolClient): Promise<GenreReviewRow[]> {
  const db = client || await initDB();
  const res = await db.query(`
    SELECT
      g.id,
      g.name,
      COALESCE(g.normalized_key, '') AS normalized_key,
      COUNT(DISTINCT tt.track_id)::int AS track_count,
      COUNT(DISTINCT t.album_id)::int AS album_count,
      mapped.genre AS taxonomy_path,
      EXISTS (SELECT 1 FROM genre mb WHERE lower(mb.name) = lower(g.name)) AS is_mb_genre
    FROM genres g
    -- Spellings are file tags: count the tracks tagged with this exact one.
    JOIN track_tags tt ON lower(tt.tag) = lower(g.name)
    LEFT JOIN tracks t ON t.id = tt.track_id
    -- The genre the tag maps to, so two spellings in different genres are flagged.
    LEFT JOIN LATERAL (
      SELECT lower(m.genre) AS genre FROM tag_map m
      WHERE m.tag = g.normalized_key ORDER BY m.reliability DESC, m.genre LIMIT 1
    ) mapped ON true
    WHERE g.merged_into IS NULL
    GROUP BY g.id, g.name, g.normalized_key, mapped.genre
    ORDER BY g.name ASC
  `);

  return res.rows.map((row: any) => ({
    id: String(row.id),
    name: String(row.name),
    normalizedKey: normalizeGenreIdentity(row.name),
    trackCount: Number(row.track_count || 0),
    albumCount: Number(row.album_count || 0),
    taxonomyPath: row.taxonomy_path || null,
    // A MusicBrainz genre of its own (from the shipped snapshot), e.g. a real "A/B" name rather than a compound.
    exactMbPath: row.is_mb_genre ? String(row.name).toLowerCase() : null,
  }));
}

function buildExactCandidates(rows: GenreReviewRow[]): GenreDuplicateCandidate[] {
  const groups = new Map<string, GenreReviewRow[]>();
  for (const row of rows) {
    if (row.normalizedKey.length < 3 || row.normalizedKey === 'unknown genre') continue;
    const group = groups.get(row.normalizedKey) || [];
    group.push(row);
    groups.set(row.normalizedKey, group);
  }

  const candidates: GenreDuplicateCandidate[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2 || group.some(row => isSlashCompoundGenre(row.name) && !row.exactMbPath)) continue;
    const taxonomyConflict = hasTaxonomyConflict(group);
    candidates.push({
      candidateKey: `genre-normalized:${key}`,
      signature: candidateSignature(group),
      score: taxonomyConflict ? 80 : 100,
      reasons: taxonomyConflict
        ? ['same normalized wording', 'different taxonomy roots']
        : ['same normalized wording'],
      taxonomyConflict,
      genres: sortGenreRows(group),
    });
  }
  return candidates;
}

function buildFuzzyCandidates(rows: GenreReviewRow[], exactCandidates: GenreDuplicateCandidate[]): GenreDuplicateCandidate[] {
  const exactPairs = new Set<string>();
  for (const candidate of exactCandidates) {
    const ids = candidate.genres.map(genre => genre.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) exactPairs.add(`${ids[i]}:${ids[j]}`);
    }
  }

  const candidates: GenreDuplicateCandidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    const left = rows[i];
    if (isSlashCompoundGenre(left.name) && !left.exactMbPath) continue;
    if (left.normalizedKey.length < 3 || left.normalizedKey === 'unknown genre') continue;
    for (let j = i + 1; j < rows.length; j++) {
      const right = rows[j];
      if (isSlashCompoundGenre(right.name) && !right.exactMbPath) continue;
      const pairKey = [left.id, right.id].sort().join(':');
      if (exactPairs.has(pairKey)) continue;

      const evidence: GenreSimilarityEvidence = scoreGenreSimilarity(left.name, right.name);
      if (evidence.score < 55) continue;
      const rootsConflict = hasTaxonomyConflict([left, right]);
      const samePath = Boolean(left.taxonomyPath && right.taxonomyPath
        && left.taxonomyPath.toLowerCase() === right.taxonomyPath.toLowerCase());
      const score = Math.max(0, Math.min(99, evidence.score - (rootsConflict ? 20 : 0)));
      if (score < MIN_CANDIDATE_SCORE) continue;
      const reasons = [...evidence.reasons];
      if (samePath) reasons.push('same taxonomy path');
      if (rootsConflict) reasons.push('different taxonomy roots');
      candidates.push({
        candidateKey: `genre-similar:${pairKey}`,
        signature: candidateSignature([left, right]),
        score,
        reasons,
        taxonomyConflict: rootsConflict,
        genres: sortGenreRows([left, right]),
      });
    }
  }
  return candidates;
}

async function fetchLatestReviewedSignatures(): Promise<Set<string>> {
  const db = await initDB();
  const res = await db.query(`
    SELECT DISTINCT ON (candidate_key, signature) candidate_key, signature
    FROM genre_duplicate_reviews
    ORDER BY candidate_key, signature, created_at DESC
  `);
  return new Set(res.rows.map((row: any) => `${row.candidate_key}\n${row.signature}`));
}

async function fetchActiveGroups(rows: GenreReviewRow[]): Promise<ActiveGenreGroup[]> {
  const db = await initDB();
  const res = await db.query(`
    SELECT alias.id AS alias_id, alias.name AS alias_name, alias.normalized_key AS alias_normalized_key,
           canonical.id AS canonical_id, canonical.name AS canonical_name,
           COUNT(DISTINCT tt.track_id)::int AS track_count,
           COUNT(DISTINCT t.album_id)::int AS album_count
    FROM genres alias
    JOIN genres canonical ON canonical.id = alias.merged_into
    LEFT JOIN track_tags tt ON lower(tt.tag) = lower(canonical.name)
    LEFT JOIN tracks t ON t.id = tt.track_id
    GROUP BY alias.id, alias.name, alias.normalized_key, canonical.id, canonical.name
    ORDER BY canonical.name, alias.name
  `);
  const activeById = new Map(rows.map(row => [row.id, row]));
  const groups = new Map<string, ActiveGenreGroup>();
  for (const row of res.rows) {
    const canonical = activeById.get(String(row.canonical_id)) || {
      id: String(row.canonical_id),
      name: String(row.canonical_name),
      normalizedKey: normalizeGenreIdentity(row.canonical_name),
      trackCount: Number(row.track_count || 0),
      albumCount: Number(row.album_count || 0),
      taxonomyPath: null,
      exactMbPath: null,
    };
    const group = groups.get(canonical.id) || { canonical, aliases: [] };
    group.aliases.push({
      id: String(row.alias_id),
      name: String(row.alias_name),
      normalizedKey: normalizeGenreIdentity(row.alias_name),
      trackCount: 0,
      albumCount: 0,
      taxonomyPath: null,
      exactMbPath: null,
    });
    groups.set(canonical.id, group);
  }
  return [...groups.values()];
}

export async function getGenreReviewState(): Promise<{
  candidates: GenreDuplicateCandidate[];
  compounds: GenreCompoundCandidate[];
  groups: ActiveGenreGroup[];
}> {
  const rows = await fetchGenreReviewRows();
  const exact = buildExactCandidates(rows);
  const allCandidates = [...exact, ...buildFuzzyCandidates(rows, exact)];
  const reviewed = await fetchLatestReviewedSignatures();
  const candidates = allCandidates
    .filter(candidate => !reviewed.has(`${candidate.candidateKey}\n${candidate.signature}`))
    .sort((a, b) => b.score - a.score
      || b.genres.reduce((sum, genre) => sum + genre.trackCount, 0)
        - a.genres.reduce((sum, genre) => sum + genre.trackCount, 0));
  const compounds = rows
    .filter(row => isSlashCompoundGenre(row.name) && !row.exactMbPath)
    .map(row => ({
      candidateKey: `genre-compound:${row.id}`,
      signature: candidateSignature([row]),
      genre: row,
      reason: 'compound-tag' as const,
    }))
    .filter(candidate => !reviewed.has(`${candidate.candidateKey}\n${candidate.signature}`));
  const groups = await fetchActiveGroups(rows);
  return { candidates, compounds, groups };
}

async function recordReview(client: PoolClient, opts: {
  candidateKey: string;
  signature: string;
  decision: 'dismissed' | 'grouped' | 'restored';
  canonicalGenreId?: string | null;
  genreIds: string[];
  scoreEvidence?: unknown;
  userId?: string | null;
}) {
  await client.query(`
    INSERT INTO genre_duplicate_reviews
      (candidate_key, signature, decision, canonical_genre_id, genre_ids, score_evidence, decided_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
  `, [
    opts.candidateKey,
    opts.signature,
    opts.decision,
    opts.canonicalGenreId || null,
    JSON.stringify(opts.genreIds),
    JSON.stringify(opts.scoreEvidence ?? null),
    opts.userId || null,
  ]);
}

export async function dismissGenreCandidate(opts: {
  candidateKey: string;
  signature: string;
  genreIds: string[];
  userId?: string | null;
}) {
  const db = await initDB();
  const client = await db.connect();
  try {
    await recordReview(client, { ...opts, decision: 'dismissed' });
  } finally {
    client.release();
  }
}

async function selectedGenreRows(client: PoolClient, ids: string[]): Promise<GenreReviewRow[]> {
  const allRows = await fetchGenreReviewRows(client);
  const byId = new Map(allRows.map(row => [row.id, row]));
  return ids.map(id => byId.get(id)).filter((row): row is GenreReviewRow => Boolean(row));
}

async function markGenreConsumersStale() {
  await setSystemSetting('systemPlaylistConfigUpdatedAt', Date.now());
}

export async function groupGenres(opts: {
  canonicalGenreId: string;
  aliasGenreIds: string[];
  candidateKey?: string;
  signature?: string;
  scoreEvidence?: unknown;
  acknowledgeTaxonomyConflict?: boolean;
  userId?: string | null;
}) {
  const aliasIds = Array.from(new Set(opts.aliasGenreIds.filter(id => id && id !== opts.canonicalGenreId)));
  const ids = [opts.canonicalGenreId, ...aliasIds];
  if (aliasIds.length === 0) throw new Error('At least one alias genre is required');

  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rows = await selectedGenreRows(client, ids);
    if (rows.length !== ids.length) throw new Error('One or more selected genres are missing or already grouped');
    if (rows.some(row => row.normalizedKey === 'unknown genre')) throw new Error('Unknown Genre cannot be grouped');
    if (hasTaxonomyConflict(rows) && !opts.acknowledgeTaxonomyConflict) {
      const error = new Error('Selected genres resolve to different taxonomy roots');
      (error as Error & { code?: string }).code = 'GENRE_TAXONOMY_CONFLICT';
      throw error;
    }

    // Grouping only says the spellings are one tag: the tag mapping reads
    // it (merged_into), and track genres follow from fusion.
    await client.query('UPDATE genres SET merged_into = $1 WHERE id = ANY($2::uuid[])', [opts.canonicalGenreId, aliasIds]);

    const candidateKey = opts.candidateKey || `genre-manual:${opts.canonicalGenreId}`;
    const signature = opts.signature || candidateSignature(rows);
    await recordReview(client, {
      candidateKey,
      signature,
      decision: 'grouped',
      canonicalGenreId: opts.canonicalGenreId,
      genreIds: ids,
      scoreEvidence: opts.scoreEvidence,
      userId: opts.userId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  invalidateGenreEntityCache();
  await markGenreConsumersStale();
}

export async function restoreGenreAlias(opts: { aliasGenreId: string; userId?: string | null }) {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const aliasRes = await client.query(`
      SELECT alias.id, alias.name, alias.merged_into, canonical.name AS canonical_name
      FROM genres alias
      LEFT JOIN genres canonical ON canonical.id = alias.merged_into
      WHERE alias.id = $1
      FOR UPDATE OF alias
    `, [opts.aliasGenreId]);
    const alias = aliasRes.rows[0];
    if (!alias) throw new Error('Genre alias not found');
    if (!alias.merged_into) throw new Error('Genre is not currently grouped');

    await client.query('UPDATE genres SET merged_into = NULL WHERE id = $1', [alias.id]);

    await recordReview(client, {
      candidateKey: `genre-restore:${alias.id}`,
      signature: `${alias.id}:${alias.merged_into}`,
      decision: 'restored',
      canonicalGenreId: alias.merged_into,
      genreIds: [alias.id, alias.merged_into],
      userId: opts.userId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  invalidateGenreEntityCache();
  await markGenreConsumersStale();
}
