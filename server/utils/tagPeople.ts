// The people a file credits, read from its per-person tags.
//
// Picard-style tags carry each artist separately: ARTISTS lists the performers
// and MUSICBRAINZ_ARTISTID their ids in the same order; the album artists come
// as MUSICBRAINZ_ALBUMARTISTID, sometimes with an ALBUMARTISTS list or the
// people as extra ALBUMARTIST values after the display credit. ARTIST and
// ALBUMARTIST are display credits ("Tony Bennett & Diana Krall With Bill
// Charlap Trio"), not artists. Reading the people directly means no guessing
// whether "&" joins two artists or belongs to one ("Hall & Oates"), and no
// re-splitting a name that contains a comma ("Tyler, the Creator").
//
// The files are the source of truth: when they don't say who the people are,
// these return null and the caller falls back to splitting the credit string.

import { splitAtFeaturing } from '../../shared/artistCredit';
import { splitTagValues } from './tagValues';

export interface PersonCredit {
  name: string;
  /** The person's MusicBrainz artist id, when the file gives one for them. */
  mbid: string | null;
}

/** The parts of a music-metadata result these helpers read. */
export interface TagSource {
  common: {
    artist?: unknown;
    artists?: unknown;
    musicbrainz_artistid?: unknown;
    albumartist?: unknown;
    musicbrainz_albumartistid?: unknown;
  };
  native?: Record<string, Array<{ id: string; value: unknown }>>;
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ARTISTS / ALBUMARTISTS as Vorbis, ID3 TXXX, MP4 freeform and ASF name them.
const ARTISTS_TAG = /^(ARTISTS|TXXX:ARTISTS|----:com\.apple\.iTunes:ARTISTS|WM\/ARTISTS)$/i;
const ALBUM_ARTISTS_TAG = /^(ALBUMARTISTS|TXXX:ALBUMARTISTS|----:com\.apple\.iTunes:ALBUMARTISTS|WM\/ALBUMARTISTS)$/i;
// The album-artist display tag, which some files repeat with the people after the credit.
const ALBUM_ARTIST_TAG = /^(ALBUMARTIST|TPE2|aART|WM\/AlbumArtist)$/i;

function ids(value: unknown): string[] {
  return splitTagValues(value).map((id) => (MBID.test(id) ? id.toLowerCase() : ''));
}

function nativeValues(source: TagSource, pattern: RegExp): string[] {
  return Object.values(source.native || {})
    .flat()
    .filter((tag) => pattern.test(tag.id))
    .flatMap((tag) => splitTagValues(tag.value));
}

/** Pairs names with ids by position when the lists line up; names only otherwise. */
function zip(names: string[], idList: string[]): PersonCredit[] {
  const paired = idList.length === names.length;
  const seen = new Set<string>();
  const people: PersonCredit[] = [];
  names.forEach((name, i) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ name, mbid: paired ? idList[i] || null : null });
  });
  return people;
}

// Text that lost its characters to a bad encoding ("???? & ????"), not a name.
const MANGLED = /^[?\s&,.\-]*\?[?\s&,.\-]*$/;

/**
 * Some taggers put the display credit first in the people list: ARTISTS =
 * "Dua Lipa & the Blessed Madonna", "Dua Lipa", "The Blessed Madonna". The
 * credit isn't a person, so it goes when it repeats the display credit and
 * either the ids line up with the people after it, or at least two of those
 * people are named in it. A real act that shares the list ("Riggi & Piros",
 * "Dani Poppitt") stays.
 */
function withoutCredit(names: string[], credit: string | undefined, idCount: number): string[] {
  const people = names.filter((name) => !MANGLED.test(name));
  if (people.length < 2) return people;
  const rest = people.slice(1);
  const first = people[0].toLowerCase();
  const named = rest.filter((name) => first.includes(name.toLowerCase())).length;
  const aligned = idCount === rest.length;
  // A first entry that repeats the credit, or names two of the people after it
  // while the ids line up with them ("María De Medeiros and Bruce Willis / the
  // Centurions" before each of the three).
  if (first === credit?.toLowerCase() ? aligned || named >= 2 : aligned && named >= 2) return rest;
  return people;
}

// Joining words left at either end of a credit once names are taken out of it.
const LOOSE_JOINERS = /^(?:[\s&,+×]|\b(?:x|and|with|vs|feat|ft|featuring)\b\.?)+|(?:[\s&,+×]|\b(?:x|and|with|vs|feat|ft|featuring)\b\.?)+$/gi;

/**
 * Some taggers leave the leading act out of ARTISTS but keep its id first:
 * ARTISTS = "Connie Constance", ids = Swedish House Mafia's, Connie Constance's,
 * for "Swedish House Mafia & Connie Constance". With exactly one id more than
 * names, the act is what the credit says before the listed people, and leads
 * the list with that first id. Named from the credit, not the album-artist tag,
 * which can be a credit itself ("Armin van Buuren & Olive Anguz" on a mix album
 * with Armin's id).
 */
function withLeadingAct(names: string[], idList: string[], credit: string | undefined): string[] {
  if (!credit || names.length === 0 || idList.length !== names.length + 1 || !idList[0]) return names;
  let rest = credit;
  for (const name of names) {
    const at = rest.toLowerCase().indexOf(name.toLowerCase());
    if (at < 0) return names;
    rest = `${rest.slice(0, at)}\0${rest.slice(at + name.length)}`;
  }
  // Only text ahead of the first listed person, and a plain name ("Onallee
  // (Need for Mirrors Remix)" leaves nothing usable).
  const act = rest.split('\0')[0].replace(LOOSE_JOINERS, '').replace(/\s+/g, ' ').trim();
  if (!act || /[()[\]{}\0]/.test(act) || !/[\p{L}\p{N}]/u.test(act)) return names;
  return [act, ...names];
}

/**
 * The track's performers from ARTISTS (+ MUSICBRAINZ_ARTISTID), or null when the
 * file has no ARTISTS tag. music-metadata fills `common.artists` from the ARTIST
 * display credit when ARTISTS is missing, so that list is only trusted when the
 * tag itself is there. Some taggers write ARTISTS as a copy of a credit with
 * featured artists ("Timbaland Feat. Drake"); that doesn't name the people
 * either, so the credit is split at the featuring marker, the main act kept
 * whole.
 */
export function trackArtistPeople(source: TagSource): PersonCredit[] | null {
  if (nativeValues(source, ARTISTS_TAG).length === 0) return null;
  const idList = ids(source.common.musicbrainz_artistid);
  const credit = splitTagValues(source.common.artist)[0];
  const names = withLeadingAct(withoutCredit(splitTagValues(source.common.artists), credit, idList.length), idList, credit);
  if (names.length === 0) return null;
  if (names.length === 1 && names[0].toLowerCase() === credit?.toLowerCase()) {
    const featuring = splitAtFeaturing(names[0]);
    if (featuring && featuring.length > 1) return featuring.map((name) => ({ name, mbid: null }));
  }
  const people = zip(names, idList);
  // Ids that don't line up with the names (a band's members listed after it)
  // still name the first person when their first id is the album artist's and
  // they are the album artist.
  const albumIds = ids(source.common.musicbrainz_albumartistid);
  const albumArtist = splitTagValues(source.common.albumartist)[0];
  if (!people[0].mbid && idList[0] && idList[0] === albumIds[0] && albumArtist?.toLowerCase() === people[0].name.toLowerCase()) {
    people[0] = { ...people[0], mbid: idList[0] };
  }
  return people;
}

/**
 * The album artists. Tried in order: an ALBUMARTISTS list; the people repeated
 * after the credit in ALBUMARTIST; each album-artist id matched to a performer
 * of this track with that id; a single id, which names the whole credit as one
 * act ("Above & Beyond", "Various Artists"). Null when none of these say.
 */
export function albumArtistPeople(source: TagSource, trackPeople: PersonCredit[] | null): PersonCredit[] | null {
  const albumIds = ids(source.common.musicbrainz_albumartistid);

  const credit = splitTagValues(source.common.albumartist)[0];
  const listed = withoutCredit(nativeValues(source, ALBUM_ARTISTS_TAG), credit, albumIds.length);
  if (listed.length > 0) return zip(listed, albumIds);

  const repeated = [...new Set([...splitTagValues(source.common.albumartist), ...nativeValues(source, ALBUM_ARTIST_TAG)])];
  if (albumIds.length > 1 && repeated.length === albumIds.length + 1 && repeated[0] === credit) {
    return zip(repeated.slice(1), albumIds);
  }

  if (albumIds.length > 0 && albumIds.every(Boolean)) {
    const byId = new Map((trackPeople || []).filter((p) => p.mbid).map((p) => [p.mbid!, p.name]));
    if (albumIds.every((id) => byId.has(id))) return zip(albumIds.map((id) => byId.get(id)!), albumIds);
    if (albumIds.length === 1 && credit) return [{ name: credit, mbid: albumIds[0] }];
  }
  return null;
}
