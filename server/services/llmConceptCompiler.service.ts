/**
 * The AI's concept made concrete for this library: its genres and styles as
 * taxonomy paths (less any the concept itself bans), the banned paths, and
 * its 8-number target adapted to the library's range. Everything else is
 * the score's (aiPlaylistScore.service): neighbouring styles come from
 * centroids there, and how strictly to keep to the styles from Genre
 * Cohesion and support. The pool-era parts (primary, adjacent and root
 * paths, genre health, bridge vector, modes) went with the pools.
 */
import { initDB } from '../database';
import { pathUnder, resolveBannedPaths, resolveGenrePaths } from './genreTaxonomy/paths';
import { adaptVectorToLibrary, LibraryProfile } from './libraryProfile.service';

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
  /** The AI's 8 numbers, moved into the library's own range. */
  adaptedTargetVector: number[];
  /** The concept's genres and styles as paths ("electronic", "electronic.house"), in the AI's order. */
  corePaths: string[];
  /** Banned genre paths (resolved from the concept's banned_genres), a hard veto. */
  bannedGenres: string[];
  /** The banned names as the AI wrote them. */
  bannedNames: string[];
  diagnostics: {
    notes: string[];
    targetGenres: string[];
    /** The concept named only whole genres ("rock", "pop"): too broad to build on, ask again. */
    shouldRegenerate: boolean;
    regenerateReason: string | null;
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

/** A whole genre ("rock") rather than one of its styles ("rock.punk"). */
function isBroadRootPath(path: string): boolean {
  const clean = String(path || '').toLowerCase().trim();
  return Boolean(clean) && !clean.includes('.');
}

function isPathBlockedByBannedGenre(path: string, bannedPaths: string[]): boolean {
  const cleanPath = String(path || '').toLowerCase().trim();
  return Boolean(cleanPath) && bannedPaths.some((banned) => pathUnder(cleanPath, banned));
}

export async function compileConceptToLibrary(concept: RawLlmConcept, profile: LibraryProfile): Promise<CompiledLlmConcept> {
  const targetGenres = uniqueNonEmpty((concept.target_genres || []).map((genre) => String(genre).toLowerCase()));
  const bannedNames = uniqueNonEmpty((concept.banned_genres || []).map((genre) => String(genre).toLowerCase()));
  const notes: string[] = [];
  const db = await initDB();
  const bannedGenres = await resolveBannedPaths(db, bannedNames);

  const resolved = uniqueNonEmpty((await Promise.all(targetGenres.map((genre) => resolveGenrePaths(db, genre)))).flat());
  const corePaths = resolved.filter((path) => !isPathBlockedByBannedGenre(path, bannedGenres));
  const conflicting = resolved.length - corePaths.length;
  if (conflicting > 0) notes.push(`Removed ${conflicting} target path(s) that conflict with banned genres.`);
  if (targetGenres.length > 0 && corePaths.length === 0) {
    notes.push('No target genres matched a genre or style; the sound alone leads.');
  }

  const shouldRegenerate = corePaths.length > 0 && corePaths.every(isBroadRootPath);
  const regenerateReason = shouldRegenerate ? 'Concept resolved only to whole genres, without a style to build on.' : null;
  if (regenerateReason) notes.push(regenerateReason);

  return {
    title: concept.title || concept.section,
    description: concept.description,
    adaptedTargetVector: adaptVectorToLibrary(concept.target_vector, profile).map(clamp01),
    corePaths,
    bannedGenres,
    bannedNames,
    diagnostics: { notes, targetGenres, shouldRegenerate, regenerateReason },
  };
}
