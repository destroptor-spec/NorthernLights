/**
 * Versioned data files behind the genre & style taxonomy
 * (server/data/genre-taxonomy, see docs/Aurora genre and style redesign.md).
 * Everything is validated on load; a broken file stops seeding instead of
 * writing a half-valid taxonomy.
 */
import fs from 'fs';
import path from 'path';
import { normalizeGenreIdentity } from '../../utils/genreIdentity';

export const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'genre-taxonomy');
export const STYLE_SEPARATOR = '---';
export const EXPECTED_LABELS = 400;
export const EXPECTED_GENRES = 15;
// Non-music: spoken word, field recordings… listed, but hidden from Browse by default.
export const HIDDEN_GENRES = new Set(['Non-Music']);

/**
 * Key used to match tags across files, Picard and artist tags. Falls back to
 * the lowercased original when normalisation leaves nothing (non-Latin tags
 * such as サウンドトラック), so such tags never collide on an empty key.
 */
export function tagKey(tag: string): string {
  const normalized = normalizeGenreIdentity(tag);
  if (normalized) return normalized;
  return String(tag || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface DiscogsLabels {
  taxonomyVersion: number;
  model: string;
  classes: string[];
}

export interface StyleLabel {
  label: string;
  genre: string;
  name: string;
  modelIndex: number;
}

export function parseLabel(label: string): { genre: string; name: string } {
  const parts = label.split(STYLE_SEPARATOR);
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error(`Invalid Discogs label "${label}" (expected "Genre---Style")`);
  }
  return { genre: parts[0], name: parts[1] };
}

export function validateLabels(data: DiscogsLabels): { genres: string[]; styles: StyleLabel[] } {
  if (!Number.isInteger(data?.taxonomyVersion) || data.taxonomyVersion < 1) throw new Error('taxonomyVersion missing');
  if (!Array.isArray(data.classes) || data.classes.length !== EXPECTED_LABELS) {
    throw new Error(`Expected ${EXPECTED_LABELS} labels, got ${data.classes?.length}`);
  }
  if (new Set(data.classes).size !== data.classes.length) throw new Error('Duplicate Discogs labels');
  const styles = data.classes.map((label, modelIndex) => ({ label, modelIndex, ...parseLabel(label) }));
  const genres = Array.from(new Set(styles.map(s => s.genre)));
  if (genres.length !== EXPECTED_GENRES) throw new Error(`Expected ${EXPECTED_GENRES} genres, got ${genres.length}`);
  return { genres, styles };
}

export interface TagAliases {
  aliasVersion: number;
  aliases: Record<string, string>;
  ignored: Record<string, string>;
}

/** Alias targets must name a known genre or full style label. Keys are re-keyed with tagKey. */
export function validateAliases(data: TagAliases, labels: string[]): TagAliases {
  if (!Number.isInteger(data?.aliasVersion) || data.aliasVersion < 1) throw new Error('aliasVersion missing');
  const genres = new Set(labels.map(label => parseLabel(label).genre));
  const known = new Set(labels);
  const aliases: Record<string, string> = {};
  for (const [tag, target] of Object.entries(data.aliases || {})) {
    if (!genres.has(target) && !known.has(target)) throw new Error(`Alias "${tag}" points at unknown "${target}"`);
    aliases[tagKey(tag)] = target;
  }
  const ignored: Record<string, string> = {};
  for (const [tag, reason] of Object.entries(data.ignored || {})) ignored[tagKey(tag)] = reason;
  return { aliasVersion: data.aliasVersion, aliases, ignored };
}

export interface MbGenreSnapshot {
  version: string;
  genres: Array<[number, string, string, string | null]>;
  aliases: Array<[number, number, string, string | null, number | null, boolean]>;
  links: Array<[number, number, number, number]>;
}

export function validateMbSnapshot(data: MbGenreSnapshot): MbGenreSnapshot {
  if (!/^mb-\d{8}-\d{6}$/.test(String(data?.version))) throw new Error(`Bad snapshot version ${data?.version}`);
  if (!Array.isArray(data.genres) || data.genres.length < 1000) throw new Error('Snapshot has too few genres');
  const ids = new Set(data.genres.map(g => g[0]));
  if (data.aliases.some(a => !ids.has(a[1]))) throw new Error('Snapshot alias points at a missing genre');
  if (data.links.some(l => !ids.has(l[2]) || !ids.has(l[3]))) throw new Error('Snapshot link points at a missing genre');
  return data;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) as T;
}

export function loadDiscogsLabels() {
  const raw = readJson<DiscogsLabels>('discogs400-labels.json');
  return { raw, ...validateLabels(raw) };
}

export function loadTagAliases(labels: string[]) {
  return validateAliases(readJson<TagAliases>('tag-aliases.json'), labels);
}

export function loadMbSnapshot() {
  return validateMbSnapshot(readJson<MbGenreSnapshot>('musicbrainz-genres.json'));
}
