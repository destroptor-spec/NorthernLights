/**
 * Mapping coverage and the phase-1 gate (docs/Aurora genre and style
 * redesign.md): at least 95 % of tagged tracks have a mapping, and every
 * mapping used by a track tag has been reviewed. Tracks whose only tags are
 * ignored placeholders ("Other", "None") count as untagged, not unmapped.
 */
import type { Pool } from 'pg';

export const COVERAGE_TARGET = 0.95;

export interface UnmappedTag { tagKey: string; example: string; tracks: number }

export interface MappingCoverage {
  tracks: { total: number; tagged: number; ignoredOnly: number; mapped: number; coverage: number };
  tags: { keys: number; mapped: number; ignored: number; unmapped: number };
  mappings: { rows: number; reviewed: number; unreviewed: number; lowReliability: number; byMethod: Record<string, number> };
  artistTags: { artists: number; withMappedTag: number; keys: number; mappedKeys: number };
  unmapped: UnmappedTag[];
  gate: { coverageMet: boolean; allReviewed: boolean; passed: boolean };
}

export async function getMappingCoverage(db: Pool, unmappedLimit = 100): Promise<MappingCoverage> {
  const t = (await db.query(`
    WITH per_track AS (
      SELECT tt.track_id,
             bool_or(m.tag IS NOT NULL) AS mapped,
             bool_and(i.tag IS NOT NULL) AS all_ignored
      FROM track_tags tt
      LEFT JOIN (SELECT DISTINCT tag FROM tag_map) m ON m.tag = tt.tag_key
      LEFT JOIN tag_ignored i ON i.tag = tt.tag_key
      GROUP BY tt.track_id
    )
    SELECT (SELECT COUNT(*) FROM tracks)::int AS total,
           COUNT(*)::int AS tagged,
           COUNT(*) FILTER (WHERE all_ignored)::int AS ignored_only,
           COUNT(*) FILTER (WHERE mapped)::int AS mapped
    FROM per_track`)).rows[0];
  const effective = t.tagged - t.ignored_only;

  const k = (await db.query(`
    SELECT COUNT(*)::int AS keys,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM tag_map m WHERE m.tag = k.tag_key))::int AS mapped,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM tag_ignored i WHERE i.tag = k.tag_key))::int AS ignored
    FROM (SELECT DISTINCT tag_key FROM track_tags) k`)).rows[0];

  // Mappings that matter for the gate: those used by at least one track tag.
  const used = `EXISTS (SELECT 1 FROM track_tags tt WHERE tt.tag_key = m.tag)`;
  const m = (await db.query(`
    SELECT COUNT(*)::int AS rows,
           COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL OR method = 'manual')::int AS reviewed,
           COUNT(*) FILTER (WHERE reliability < 0.8)::int AS low
    FROM tag_map m WHERE ${used}`)).rows[0];
  const byMethod = Object.fromEntries((await db.query(
    `SELECT method, COUNT(*)::int AS n FROM tag_map m WHERE ${used} GROUP BY method ORDER BY method`)).rows
    .map((r: any) => [r.method, r.n]));

  const a = (await db.query(`
    SELECT COUNT(DISTINCT artist_id)::int AS artists,
           COUNT(DISTINCT artist_id) FILTER (WHERE weight >= 0.3 AND EXISTS (SELECT 1 FROM tag_map m WHERE m.tag = at.tag_key))::int AS with_mapped,
           COUNT(DISTINCT tag_key)::int AS keys,
           COUNT(DISTINCT tag_key) FILTER (WHERE EXISTS (SELECT 1 FROM tag_map m WHERE m.tag = at.tag_key))::int AS mapped_keys
    FROM artist_tags at`)).rows[0];

  const unmapped = (await db.query(`
    SELECT tt.tag_key, MIN(tt.tag) AS example, COUNT(DISTINCT tt.track_id)::int AS tracks
    FROM track_tags tt
    WHERE NOT EXISTS (SELECT 1 FROM tag_map m WHERE m.tag = tt.tag_key)
      AND NOT EXISTS (SELECT 1 FROM tag_ignored i WHERE i.tag = tt.tag_key)
    GROUP BY tt.tag_key ORDER BY tracks DESC, tt.tag_key LIMIT $1`, [unmappedLimit])).rows
    .map((r: any) => ({ tagKey: r.tag_key, example: r.example, tracks: r.tracks }));

  const coverage = effective > 0 ? t.mapped / effective : 1;
  const unreviewed = m.rows - m.reviewed;
  return {
    tracks: { total: t.total, tagged: t.tagged, ignoredOnly: t.ignored_only, mapped: t.mapped, coverage },
    tags: { keys: k.keys, mapped: k.mapped, ignored: k.ignored, unmapped: k.keys - k.mapped - k.ignored },
    mappings: { rows: m.rows, reviewed: m.reviewed, unreviewed, lowReliability: m.low, byMethod },
    artistTags: { artists: a.artists, withMappedTag: a.with_mapped, keys: a.keys, mappedKeys: a.mapped_keys },
    unmapped,
    gate: { coverageMet: coverage >= COVERAGE_TARGET, allReviewed: unreviewed === 0, passed: coverage >= COVERAGE_TARGET && unreviewed === 0 },
  };
}
