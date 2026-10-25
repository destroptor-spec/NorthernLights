// The artist review queue in Settings → Library entities, shared by the server
// (server/database/artistReviews.ts) and the client. Each entry is one question
// the scanner can't answer by rule, with the outcomes to choose from; a preview
// shows how each outcome changes the artist pages involved.

export type ArtistReviewKind =
  /** Name variants with one identity key ("Tiësto" / "Tiesto"). */
  | 'same-identity'
  /** One MusicBrainz artist under different names ("Sabrina" / "Sabrina Salerno"). */
  | 'same-musicbrainz'
  /** A credit row whose first name is an artist of its own ("Sia & At home with the kids"). */
  | 'compound-credit'
  /** A joined name leading tracks of its own whose names are all library artists:
   * one act, or a collaboration of two (Grandmaster Flash & The Furious Five). */
  | 'joined-credit';

export type ArtistReviewOutcomeKind = 'merge' | 'keep-apart' | 'keep-together' | 'split';

export interface ArtistReviewOutcome {
  /** `merge:<canonical artist id>`, `keep-apart`, `keep-together` or `split`. */
  id: string;
  kind: ArtistReviewOutcomeKind;
  label: string;
}

export interface ArtistReviewArtist {
  id: string;
  name: string;
  mbid: string | null;
  imageUrl: string | null;
  trackCount: number;
  albumCount: number;
}

export interface ArtistReviewEntry {
  key: string;
  signature: string;
  kind: ArtistReviewKind;
  /** The name the question is about. */
  subject: string;
  artists: ArtistReviewArtist[];
  /** joined-credit: the artists it would split into. */
  splitInto?: string[];
  totalTracks: number;
  outcomes: ArtistReviewOutcome[];
}

export interface ReleasePreview {
  albumId: string | null;
  title: string;
  year: number | null;
  /** Tracks of the release on this artist's page. */
  tracks: number;
  /** Compared with the page today. */
  change: 'added' | 'removed' | null;
}

export interface ArtistPagePreview {
  name: string;
  artistId: string | null;
  imageUrl: string | null;
  status: 'unchanged' | 'changed' | 'removed';
  ownTracks: number;
  ownTracksBefore: number;
  /** The artist's own releases. */
  releases: ReleasePreview[];
  /** "Also appears on". */
  appearances: ReleasePreview[];
}

export interface ArtistReviewPreview {
  key: string;
  outcomes: Array<{ id: string; pages: ArtistPagePreview[] }>;
}

export type ArtistReviewDecisionKind = 'merged' | 'dismissed' | 'kept' | 'split';

export interface ArtistReviewDecision {
  id: string;
  key: string;
  decision: ArtistReviewDecisionKind;
  /** What the decision was about, for the list: names, canonical first for a merge. */
  names: string[];
  decidedAt: string;
  /** A decision can be undone for 30 days. */
  undoableUntil: string;
}

export const ARTIST_REVIEW_UNDO_DAYS = 30;
