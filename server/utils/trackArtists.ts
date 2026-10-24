// Which artists a track belongs to. A track belongs to its first listed
// performer (Diana Krall's solo song on a Tony Bennett & Diana Krall album is
// hers); the other performers are credited on it. Each person keeps the
// MusicBrainz id the file gives them.
//
// The people come from the file's per-person tags (see tagPeople.ts). Only when
// a file has none does this split the display credit, as the scanner always
// did; the first artist id is then trusted only when the credit names one artist.

import { splitArtistNames, uniqueArtistNames } from '../../shared/artistCredit';
import type { PersonCredit } from './tagPeople';

export interface TrackArtistsInput {
  /** Per-person credits from the scan worker, or null/absent when the file has no ARTISTS list. */
  artistPeople?: PersonCredit[] | null;
  /** Legacy artist name list (stored rows, older workers). */
  artists?: string[] | string | null;
  /** The ARTIST display credit. */
  artist?: string | null;
  /** The file's first MusicBrainz artist id. */
  mbArtistId?: string | null;
}

export interface TrackArtists {
  /** Everyone credited as a performer, first one first. */
  people: PersonCredit[];
  /** The performer the track belongs to; null when the file names no artist. */
  primary: PersonCredit | null;
}

export function resolveTrackArtists(input: TrackArtistsInput): TrackArtists {
  if (input.artistPeople && input.artistPeople.length > 0) {
    return { people: input.artistPeople, primary: input.artistPeople[0] };
  }

  const raw = Array.isArray(input.artists) ? input.artists
    : input.artists ? [input.artists]
      : input.artist ? [input.artist] : [];
  const names = uniqueArtistNames(raw.flatMap((name) => splitArtistNames(name)));
  const name = names[0] || input.artist?.trim() || null;
  if (!name) return { people: [], primary: null };

  const primary: PersonCredit = { name, mbid: names.length <= 1 ? input.mbArtistId || null : null };
  const people = names.length > 0 ? names.map((n, i) => (i === 0 ? primary : { name: n, mbid: null })) : [primary];
  return { people, primary };
}
