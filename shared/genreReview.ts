// The genre review queue in Settings → Library entities → Genres, shared by the
// server (server/services/genreTaxonomy/review.ts) and the client. Each entry
// is one question about an original genre tag (or two spellings of a genre)
// that the mapping can't settle on its own: which of Aurora's genres and
// styles it belongs to. Phase 1 of docs/Aurora genre and style redesign.md.

export type GenreReviewKind =
  /** No genre or style found for the tag. */
  | 'unmapped'
  /** The tag is a style name found under two genres (Trip Hop: Electronic or Hip Hop). */
  | 'two-genres'
  /** Mapped through a MusicBrainz parent genre (Groove Metal → Heavy Metal). */
  | 'guessed'
  /** Several genres in one tag ("Hard Rock/Heavy Metal"). */
  | 'compound'
  /** Two spellings of one genre in the library's genre list ("Hip-Hop" / "Hip Hop"). */
  | 'spelling'
  /** Matched by name; accepted in bulk, or opened from "Find a tag". */
  | 'exact'
  /** Already reviewed, or a hand choice; opened from "Find a tag". */
  | 'reviewed'
  /** Marked as not a genre; opened from "Find a tag". */
  | 'ignored';

export interface GenreTarget {
  genre: string;
  /** null: the genre itself, no style. */
  styleId: number | null;
  style: string | null;
}

export type GenreReviewOutcomeKind = 'accept' | 'only' | 'pick' | 'ignore' | 'restore' | 'merge' | 'keep-apart';

export interface GenreReviewOutcome {
  /** accept, only:<index>, pick, ignore, restore, merge:<genre id>, keep-apart */
  id: string;
  kind: GenreReviewOutcomeKind;
  label: string;
  /** What the tag maps to with this outcome; pick takes the chosen targets. */
  targets?: GenreTarget[];
}

export interface GenreSpelling { id: string; name: string; trackCount: number }

export interface GenreReviewEntry {
  key: string;
  signature: string;
  kind: GenreReviewKind;
  /** The tag as written in the files (most common spelling), or the spellings joined. */
  subject: string;
  /** Normalised tag key; absent for spellings. */
  tagKey?: string;
  totalTracks: number;
  /** What the tag maps to now. */
  current: GenreTarget[];
  /** Why it maps there, in words: "MusicBrainz lists it under Metal". */
  note?: string;
  /** spelling: the genres involved, most tracks first. */
  spellings?: GenreSpelling[];
  /** spelling: the spellings sit in different parts of the old genre tree. */
  taxonomyConflict?: boolean;
  outcomes: GenreReviewOutcome[];
}

export interface GenreReviewEvidence {
  key: string;
  /** Artists with the most tracks carrying this tag. */
  artists: Array<{ name: string; imageUrl: string | null; tracks: number }>;
  albums: string[];
  /**
   * Where Last.fm and MusicBrainz artist tags put these artists, when any are
   * known: the leading genre, and how many of the artists with mapped tags
   * lean that way. Optional evidence; absent without provider data.
   */
  lean: { genre: string; artists: number; of: number } | null;
  /**
   * With a single artist (the lean needs two): that artist's strongest tags on
   * Last.fm and MusicBrainz together, as written, strongest first. Absent
   * without provider data.
   */
  artistTags: string[] | null;
  /** What the audio model says about these tracks; null when none are analysed. */
  audio: GenreAudioEvidence | null;
  /** A starting answer, when the evidence agrees; the admin still applies it. */
  suggestion: GenreSuggestion | null;
  /** Tracks each outcome target holds today from other tags, keyed by targetKey(). */
  targetTracks: Record<string, number>;
}

export interface GenreAudioEvidence {
  /** Tracks counted (analysed, not simulated; at most a sample of 1,000). */
  analysed: number;
  sampled: boolean;
  /** Each track counts once, for the genre of its top style; most tracks first. */
  genres: Array<{ genre: string; tracks: number }>;
  /** Each track counts once, for its top style; most tracks first. */
  styles: Array<GenreTarget & { tracks: number }>;
}

export interface GenreSuggestion {
  targets: GenreTarget[];
  /** both: audio and artist tags agree; audio or artists: the only source there is. */
  basis: 'both' | 'audio' | 'artists';
  /** No style suggested because the tracks' top styles are spread out. */
  stylesVary: boolean;
}

export interface GenreExactMatch {
  key: string;
  signature: string;
  subject: string;
  targets: GenreTarget[];
  tracks: number;
}

/** byHand: marked in the review; otherwise from the built-in list (Other, None, …). */
export interface GenreIgnoredTag { key: string; signature: string; subject: string; tracks: number; byHand: boolean }

export interface GenreGroup { canonical: GenreSpelling; aliases: GenreSpelling[] }

export interface GenreReviewState {
  entries: GenreReviewEntry[];
  /** Name matches waiting for a bulk accept. */
  exact: GenreExactMatch[];
  ignored: GenreIgnoredTag[];
  /** Spellings kept as one genre (old genre list), restorable. */
  groups: GenreGroup[];
  coverage: { tagged: number; mapped: number; ratio: number; target: number };
}

export type GenreReviewDecisionKind = 'accepted' | 'mapped' | 'ignored' | 'restored' | 'grouped' | 'kept-apart' | 'accepted-exact';

export interface GenreReviewDecision {
  id: string;
  key: string;
  decision: GenreReviewDecisionKind;
  /** The decision in words, for the Decided list and the toast. */
  summary: string;
  decidedAt: string;
  undoableUntil: string;
}

export const GENRE_REVIEW_UNDO_DAYS = 30;

/** "Electronic › Trip Hop", or the genre alone. */
export const targetLabel = (target: Pick<GenreTarget, 'genre' | 'style'>) =>
  target.style ? `${target.genre} › ${target.style}` : target.genre;

export const targetKey = (target: Pick<GenreTarget, 'genre' | 'styleId'>) => `${target.genre}|${target.styleId ?? ''}`;

export const listJoin = (items: string[]) => items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
