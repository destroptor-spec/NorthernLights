import { initDB } from '../database';
import { queryWithRetry } from '../utils/db';
import { pathUnder, resolveBannedPaths, resolveGenrePaths } from './genreTaxonomy/paths';
import { adaptGenreBlendForHealth, adaptVectorToLibrary, GenreHealth, getGenreHealthForPrefix, LibraryProfile } from './libraryProfile.service';

export interface RawLlmConcept {
  section: string;
  title?: string;
  description: string;
  target_vector: number[];
  target_genres?: string[];
  banned_genres?: string[];
}

export interface CompiledLlmConcept {
  title: string;
  description: string;
  adaptedTargetVector: number[];
  bridgeVector: number[];
  libraryMainstreamVector: number[];
  corePaths: string[];
  adjacentPaths: string[];
  rootPaths: string[];
  primaryPath: string;
  primaryHealth: GenreHealth | null;
  effectiveGenreBlend: number;
  /** Banned genre paths (resolved from the concept's banned_genres), a hard veto. */
  bannedGenres: string[];
  /** The banned names as the AI wrote them. */
  bannedNames: string[];
  mode: 'genre-anchored' | 'hybrid' | 'acoustic-only';
  diagnostics: {
    notes: string[];
    matchedGenres: string[];
    targetGenres: string[];
    adjacentCandidateCount: number;
    conflictingTargetCount: number;
    conflictingAdjacentCount: number;
    qualityScore: number;
    shouldRegenerate: boolean;
    regenerateReason: string | null;
  };
}

interface CompileOptions {
  requestedGenreBlend: number;
  tracksPerPlaylist: number;
  adjacentReach: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

/**
 * The styles whose centroids sit nearest a style path ("electronic.house"),
 * from any genre: the concept's neighbours beyond its own genre.
 */
async function nearStylePaths(path: string): Promise<Set<string>> {
  if (!path.includes('.')) return new Set();
  const res = await queryWithRetry(
    `SELECT lower(replace(n.genre, '.', ' ')) || '.' || lower(replace(n.name, '.', ' ')) AS path
     FROM style s
     JOIN style_centroids me ON me.style_id = s.id
     JOIN style_centroids c ON c.style_id <> me.style_id
     JOIN style n ON n.id = c.style_id
     WHERE lower(replace(s.genre, '.', ' ')) || '.' || lower(replace(s.name, '.', ' ')) = $1
     ORDER BY c.centroid <=> me.centroid
     LIMIT 6`,
    [path]
  ).catch(() => null);
  return new Set((res?.rows ?? []).map((row: any) => String(row.path)));
}

/** A whole genre ("rock") rather than one of its styles ("rock.punk"). */
function isBroadRootPath(path: string): boolean {
  const clean = String(path || '').toLowerCase().trim();
  return Boolean(clean) && !clean.includes('.');
}

function getPathSpecificityScore(path: string): number {
  const depth = String(path || '').split('.').filter(Boolean).length;
  if (depth <= 1) return 0;
  return Math.min(0.75, (depth - 1) * 0.28);
}

function pickPrimaryPath(paths: string[], profile: LibraryProfile): { path: string; health: GenreHealth | null } {
  if (paths.length === 0) {
    return { path: '', health: null };
  }

  let bestPath = paths[0];
  let bestHealth = getGenreHealthForPrefix(profile, bestPath);
  let bestScore = -Infinity;

  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    const health = getGenreHealthForPrefix(profile, path);
    const specificityScore = getPathSpecificityScore(path);
    const orderBonus = Math.max(0, (paths.length - index - 1) * 0.16);
    const broadRootPenalty = isBroadRootPath(path) ? 0.55 : 0;
    const score =
      (Math.min(1, health.health) * 0.55) +
      specificityScore +
      orderBonus -
      broadRootPenalty;

    if (score > bestScore) {
      bestPath = path;
      bestHealth = health;
      bestScore = score;
    }
  }

  return { path: bestPath, health: bestHealth };
}

/** One path is the other or below it ("rock" and "rock.punk"), never "electronic.tech" and "electronic.tech house". */
function overlapsPrefix(a: string, b: string): boolean {
  return pathUnder(a, b) || pathUnder(b, a);
}

function pathDistance(pathA: string, pathB: string): number {
  const a = String(pathA || '').toLowerCase().trim();
  const b = String(pathB || '').toLowerCase().trim();
  if (!a || !b) return 2.0;
  if (a === b) return 0.0;

  const partsA = a.split('.');
  const partsB = b.split('.');
  let commonLevels = 0;

  for (let index = 0; index < Math.min(partsA.length, partsB.length); index++) {
    if (partsA[index] === partsB[index]) {
      commonLevels++;
    } else {
      break;
    }
  }

  if (commonLevels >= 3) return 0.05;
  if (commonLevels === 2) return 0.20;
  if (commonLevels === 1) return 0.50;
  return 2.0;
}

function isPathBlockedByBannedGenre(path: string, bannedPaths: string[]): boolean {
  const cleanPath = String(path || '').toLowerCase().trim();
  return Boolean(cleanPath) && bannedPaths.some((banned) => pathUnder(cleanPath, banned));
}

// Adjacent paths: other styles of the primary's genre, and the styles that
// sound closest to it (centroids), from any genre.
function pickAdjacentPaths(primaryPath: string, profile: LibraryProfile, tracksPerPlaylist: number, adjacentReach: number, nearPaths: Set<string> = new Set()): string[] {
  if (!primaryPath) return [];

  const candidates: Array<{ path: string; score: number }> = [];
  const minTrackCount = Math.max(3, Math.ceil(tracksPerPlaylist / 3));
  const reach = clamp01(adjacentReach);
  const maxDistance = reach < 0.35 ? 0.20 : 0.50;
  const sameRootBonus = 0.20 + ((1 - reach) * 0.25);
  const maxAdjacentPaths = Math.max(2, Math.round(2 + (reach * 5)));

  for (const health of profile.genreHealth.values()) {
    if (!health.path || overlapsPrefix(health.path, primaryPath)) continue;
    if (health.trackCount < minTrackCount || health.artistCount < 2) continue;

    const near = nearPaths.has(health.path);
    const distance = near ? 0.20 : pathDistance(primaryPath, health.path);
    const sharesRoot = health.root === primaryPath.split('.')[0];
    if (distance > maxDistance && !sharesRoot) continue;

    const score =
      (sharesRoot ? sameRootBonus : 0) +
      ((0.65 - Math.min(distance, 0.65)) * 1.6) +
      (health.health * 0.9) +
      Math.min(0.25, health.artistCount / 30) +
      Math.min(0.15, health.trackCount / 120);

    candidates.push({ path: health.path, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxAdjacentPaths) break;
    if (selected.some((path) => overlapsPrefix(path, candidate.path))) continue;
    selected.push(candidate.path);
  }

  return selected;
}

function assessConceptQuality(
  resolvedPaths: string[],
  adjacentPaths: string[],
  primaryPath: string,
  primaryHealth: GenreHealth | null
): { qualityScore: number; shouldRegenerate: boolean; regenerateReason: string | null } {
  if (resolvedPaths.length === 0) {
    return {
      qualityScore: 0.55,
      shouldRegenerate: false,
      regenerateReason: null,
    };
  }

  const specificCount = resolvedPaths.filter((path) => path.includes('.')).length;
  const broadCount = resolvedPaths.filter((path) => isBroadRootPath(path)).length;
  const uniqueRoots = new Set(resolvedPaths.map((path) => path.split('.')[0] || path)).size;
  const specificityRatio = specificCount / resolvedPaths.length;
  const broadRatio = broadCount / resolvedPaths.length;
  const adjacentSupport = adjacentPaths.length > 0 ? 0.10 : 0;
  const healthScore = Math.min(1, primaryHealth?.health ?? 0.55);
  const rootVarietyScore = Math.min(1, uniqueRoots / 3);
  const qualityScore = Math.max(0, Math.min(1,
    (specificityRatio * 0.45) +
    ((1 - broadRatio) * 0.20) +
    (healthScore * 0.20) +
    (rootVarietyScore * 0.05) +
    adjacentSupport
  ));

  const broadOnlyGeneric = specificCount === 0 && broadCount === resolvedPaths.length;
  const weakBroadPrimary = Boolean(primaryPath) && isBroadRootPath(primaryPath) && specificityRatio < 0.34 && adjacentPaths.length === 0;
  if (broadOnlyGeneric || (weakBroadPrimary && qualityScore < 0.45)) {
    return {
      qualityScore,
      shouldRegenerate: true,
      regenerateReason: 'Concept resolved only to broad generic genre roots without enough local specificity.',
    };
  }

  return {
    qualityScore,
    shouldRegenerate: false,
    regenerateReason: null,
  };
}

export async function compileConceptToLibrary(
  concept: RawLlmConcept,
  profile: LibraryProfile,
  options: CompileOptions
): Promise<CompiledLlmConcept> {
  const targetGenres = uniqueNonEmpty((concept.target_genres || []).map((genre) => String(genre).toLowerCase()));
  const bannedNames = uniqueNonEmpty((concept.banned_genres || []).map((genre) => String(genre).toLowerCase()));
  const notes: string[] = [];
  const db = await initDB();
  const bannedGenres = await resolveBannedPaths(db, bannedNames);

  const initiallyResolvedPaths = uniqueNonEmpty(
    (await Promise.all(targetGenres.map((genre) => resolveGenrePaths(db, genre)))).flat()
  );

  const resolvedPaths = initiallyResolvedPaths.filter((path) => !isPathBlockedByBannedGenre(path, bannedGenres));

  const conflictingPaths = initiallyResolvedPaths.filter((path) => isPathBlockedByBannedGenre(path, bannedGenres));
  if (conflictingPaths.length > 0) {
    notes.push(`Removed ${conflictingPaths.length} target path(s) that conflict with banned genres.`);
  }

  if (targetGenres.length > 0 && resolvedPaths.length === 0) {
    notes.push('No target genres matched a genre or style; falling back to acoustic-only compilation.');
  }

  const { path: primaryPath, health: primaryHealth } = pickPrimaryPath(resolvedPaths, profile);
  const rawAdjacentPaths = pickAdjacentPaths(primaryPath, profile, options.tracksPerPlaylist, options.adjacentReach, await nearStylePaths(primaryPath));
  const adjacentPaths = rawAdjacentPaths.filter((path) => !isPathBlockedByBannedGenre(path, bannedGenres));
  const conflictingAdjacentPaths = rawAdjacentPaths.filter((path) => isPathBlockedByBannedGenre(path, bannedGenres));
  const rootPaths = uniqueNonEmpty(resolvedPaths.map((path) => path.split('.')[0] || path))
    .filter((path) => !isPathBlockedByBannedGenre(path, bannedGenres));
  const conceptQuality = assessConceptQuality(resolvedPaths, adjacentPaths, primaryPath, primaryHealth);
  const adaptedTargetVector = adaptVectorToLibrary(concept.target_vector, profile).map(clamp01);
  const libraryMainstreamVector = profile.vector.map((dimension) => clamp01(dimension.p50));
  const bridgeVector = adaptedTargetVector.map((value, index) => clamp01((value + (libraryMainstreamVector[index] ?? value)) / 2));
  const effectiveGenreBlend = primaryPath
    ? adaptGenreBlendForHealth(options.requestedGenreBlend, primaryHealth)
    : Math.min(options.requestedGenreBlend, 0.20);

  let mode: CompiledLlmConcept['mode'] = 'genre-anchored';
  if (!primaryPath) {
    mode = 'acoustic-only';
  } else if ((primaryHealth?.health ?? 0) < 0.55 || adjacentPaths.length > 0) {
    mode = 'hybrid';
  }

  if (primaryPath && primaryHealth && primaryHealth.health < 0.30) {
    notes.push(
      `Primary genre "${primaryPath}" is locally weak (${primaryHealth.trackCount} tracks, ${primaryHealth.artistCount} artists).`
    );
  }
  if (adjacentPaths.length > 0) {
    notes.push(`Expanded concept into ${adjacentPaths.length} adjacent library-supported genre path(s).`);
  }
  if (conflictingAdjacentPaths.length > 0) {
    notes.push(`Removed ${conflictingAdjacentPaths.length} adjacent path(s) that conflict with banned genres.`);
  }
  if (resolvedPaths.length === 0 && adjacentPaths.length === 0 && rootPaths.length === 0) {
    notes.push('Concept sanitized down to acoustic-only recovery.');
  }
  if (conceptQuality.shouldRegenerate && conceptQuality.regenerateReason) {
    notes.push(conceptQuality.regenerateReason);
  }

  return {
    title: concept.title || concept.section,
    description: concept.description,
    adaptedTargetVector,
    bridgeVector,
    libraryMainstreamVector,
    corePaths: resolvedPaths,
    adjacentPaths,
    rootPaths,
    primaryPath,
    primaryHealth,
    effectiveGenreBlend,
    bannedGenres,
    bannedNames,
    mode,
    diagnostics: {
      notes,
      matchedGenres: resolvedPaths,
      targetGenres,
      adjacentCandidateCount: adjacentPaths.length,
      conflictingTargetCount: conflictingPaths.length,
      conflictingAdjacentCount: conflictingAdjacentPaths.length,
      qualityScore: conceptQuality.qualityScore,
      shouldRegenerate: conceptQuality.shouldRegenerate,
      regenerateReason: conceptQuality.regenerateReason,
    },
  };
}
