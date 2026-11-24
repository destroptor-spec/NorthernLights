// The release as a file tags it, for the album page: record label, release
// date, original release date, medium, catalog number, barcode, release
// status and ℗ line; and per track its disc's subtitle and whether it's
// explicit. Shared by the scanner and the background re-read
// (trackOrigin.service), so both read them alike.

interface CommonTags {
  label?: string[] | string;
  date?: string;
  originaldate?: string;
  media?: string;
  catalognumber?: string[] | string;
  barcode?: string;
  releasestatus?: string;
  copyright?: string;
  discsubtitle?: string[] | string;
}

type NativeTags = Record<string, Array<{ id: string; value: unknown }>>;

export interface ReleaseTags {
  label: string | null;
  releaseDate: string | null;
  originalDate: string | null;
  media: string | null;
  catalogNumber: string | null;
  barcode: string | null;
  /** MusicBrainz's release status, lowercase: official, promotion, bootleg, pseudo-release … */
  releaseStatus: string | null;
  /** The ℗ / © line. */
  copyright: string | null;
  discSubtitle: string | null;
  /** True explicit, false clean (edited), null when not tagged. */
  explicit: boolean | null;
}

// MusicBrainz's placeholders for "no label", and the blanks taggers write.
const NO_LABEL = new Set(['[no label]', '[none]', 'none', 'n/a', '-', 'unknown']);

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\x00/g, '').trim();
  return text ? text : null;
};

/** "2011-04-12", "2011-04" or "2011" from a tag ("2011-04-12T00:00:00", "2011/04/12"); null otherwise. */
export function tagDate(value: unknown): string | null {
  const text = clean(value);
  const match = text?.replace(/\//g, '-').match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(year) < 1000) return null;
  if (month && (Number(month) < 1 || Number(month) > 12)) return year;
  if (day && (Number(day) < 1 || Number(day) > 31)) return `${year}-${month}`;
  return [year, month, day].filter(Boolean).join('-');
}

/**
 * The first real value of a tag. music-metadata types label, catalog number
 * and disc subtitle as lists, but some formats give a plain string (a FLAC's
 * DISCSUBTITLE): take either.
 */
const firstReal = (values: unknown) =>
  (Array.isArray(values) ? values : [values]).map(clean)
    .find((value): value is string => !!value && !NO_LABEL.has(value.toLowerCase())) ?? null;

/** A UPC or EAN: 8 to 14 digits once spaces are gone; anything else is not one. */
function barcode(value: unknown): string | null {
  const digits = clean(value)?.replace(/[\s-]/g, '');
  return digits && /^\d{8,14}$/.test(digits) ? digits : null;
}

/**
 * A ℗ / © line, not the rip group or site some files carry there ("PMEDIA").
 * Store downloads often tag "℗ 2024 Mine Recordings © 2024 Mine Recordings"
 * and something on the way drops the symbols, leaving the same line twice
 * ("2024 Mine Recordings 2024 Mine Recordings", 182 of 2,199 on dev): it's
 * said once. Which symbol it was isn't known, so none is added.
 */
function copyright(value: unknown): string | null {
  let text = clean(value);
  if (!text || !/℗|©|\((?:p|c)\)|\b(?:1[89]|20)\d{2}\b/i.test(text)) return null;
  const doubled = text.match(/^(.+?)\s+\1$/);
  if (doubled) text = doubled[1];
  return text;
}

/**
 * Explicit or clean, as iTunes tags it: ITUNESADVISORY (Vorbis, ID3 TXXX)
 * 1 explicit, 2 clean; MP4 rtng 1 or 4 explicit, 2 clean; 0 means not rated.
 */
function explicit(native: NativeTags | undefined): boolean | null {
  for (const tags of Object.values(native || {})) {
    for (const tag of tags) {
      const id = String(tag.id).toUpperCase();
      let raw: unknown = tag.value;
      if (id === 'TXXX' && raw && typeof raw === 'object') {
        const frame = raw as { description?: string; text?: unknown };
        if (String(frame.description).toUpperCase() !== 'ITUNESADVISORY') continue;
        raw = Array.isArray(frame.text) ? frame.text[0] : frame.text;
      } else if (id !== 'ITUNESADVISORY' && id !== 'RTNG' && !id.endsWith(':ITUNESADVISORY')) {
        continue;
      }
      const value = Number(raw);
      if (value === 1 || value === 4) return true;
      if (value === 2) return false;
    }
  }
  return null;
}

export function releaseTags(metadata: { common: CommonTags; native?: NativeTags }): ReleaseTags {
  const common = metadata.common || {};
  const status = clean(common.releasestatus)?.toLowerCase() ?? null;
  return {
    label: firstReal(common.label),
    releaseDate: tagDate(common.date),
    originalDate: tagDate(common.originaldate),
    media: clean(common.media),
    catalogNumber: firstReal(common.catalognumber),
    barcode: barcode(common.barcode),
    releaseStatus: status,
    copyright: copyright(common.copyright),
    discSubtitle: firstReal(common.discsubtitle),
    explicit: explicit(metadata.native),
  };
}
