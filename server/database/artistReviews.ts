// The artist review queue (Settings → Library entities): the questions about
// artist rows the scanner can't answer by rule, a preview of each answer on the
// artist pages involved, the answers, and undoing an answer for 30 days.
//
// Kinds: name variants and spellings of one MusicBrainz artist, and credit rows
// (getArtistDuplicateCandidates), plus joined credits that lead tracks of their
// own: one act or a collaboration (Grandmaster Flash & The Furious Five)? Their
// answers are stored in artist_duplicate_reviews like merges and dismissals, and
// splitJoinedArtistCredits() applies them after every scan.

import type { Pool } from 'pg';
import {
  initDB,
  clearEntityCaches,
  normalizeArtistIdentityKey,
  getArtistDuplicateCandidates,
  getCreditedArtistNames,
  getJoinedCreditDecisions,
  getAlbumCoOwners,
  getTracksByArtist,
  getUncreditedTracksOnOwnedAlbums,
  getArtistAppearsOnTracks,
  mergeArtistDuplicateCandidate,
  dismissArtistDuplicateCandidate,
  purgeOrphanedEntities,
  runArtistCreditSplitInBackground,
  parseJoinedCreditSignature,
  JOINED_CREDIT_KEY_PREFIX,
  type ArtistDuplicateCandidate,
  type JoinedCreditSignature,
} from './index';
import { splitJoinedCredit } from '../../shared/artistCredit';
import {
  ARTIST_REVIEW_UNDO_DAYS,
  type ArtistReviewArtist,
  type ArtistReviewDecision,
  type ArtistReviewEntry,
  type ArtistReviewKind,
  type ArtistReviewPreview,
} from '../../shared/artistReview';
import { applyNameChanges, previewArtistPages, type NameChanges, type PreviewTrack } from '../utils/artistReviewPreview';

const keyOf = (name: string) => normalizeArtistIdentityKey(name) || name.toLowerCase();

const toArtist = (row: any): ArtistReviewArtist => ({
  id: String(row.id),
  name: String(row.name),
  mbid: row.mbid || null,
  imageUrl: row.image_url || null,
  trackCount: Number(row.track_count || 0),
  albumCount: Number(row.album_count || 0),
});

// Joined names without a MusicBrainz id that lead tracks of their own, where
// every name is an artist the library credits on its own. Until answered they
// stay whole (wholeActNames).
async function getJoinedCreditEntries(db: Pool): Promise<ArtistReviewEntry[]> {
  const credited = await getCreditedArtistNames(db);
  const creditedKeys = new Set(credited.map(keyOf));
  const decisions = await getJoinedCreditDecisions(db);
  const rows = (await db.query(`
    SELECT a.id, a.name, a.mbid, a.image_url,
           COUNT(t.id)::int AS track_count, COUNT(DISTINCT t.album_id)::int AS album_count
    FROM artists a JOIN tracks t ON t.artist_id = a.id
    WHERE a.merged_into IS NULL AND a.mbid IS NULL
      AND a.name ~* '\\s(&|\\+|and)\\s'
      AND NOT EXISTS (SELECT 1 FROM artists r WHERE r.merged_into = a.id)
    GROUP BY a.id
  `)).rows;

  const proposals = rows.flatMap((row: any) => {
    const key = keyOf(row.name);
    if (decisions.has(key)) return [];
    const names = splitJoinedCredit(row.name, half => keyOf(half) !== key && creditedKeys.has(keyOf(half)));
    return names ? [{ row, names }] : [];
  });
  if (proposals.length === 0) return [];

  const halfRows = (await db.query(`
    SELECT a.id, a.name, a.mbid, a.image_url, a.normalized_key,
           COUNT(t.id)::int AS track_count, COUNT(DISTINCT t.album_id)::int AS album_count
    FROM artists a LEFT JOIN tracks t ON t.artist_id = a.id
    WHERE a.merged_into IS NULL AND a.normalized_key = ANY($1::text[])
    GROUP BY a.id
    ORDER BY COUNT(t.id) DESC
  `, [[...new Set(proposals.flatMap(p => p.names.map(keyOf)))]])).rows;
  const halfByKey = new Map<string, any>();
  for (const row of halfRows) if (!halfByKey.has(row.normalized_key)) halfByKey.set(row.normalized_key, row);

  return proposals.map(({ row, names }) => {
    const signature: JoinedCreditSignature = { subject: row.name, names };
    return {
      key: `${JOINED_CREDIT_KEY_PREFIX}${keyOf(row.name)}`,
      signature: JSON.stringify(signature),
      kind: 'joined-credit' as const,
      subject: row.name,
      artists: [toArtist(row), ...names.map(name => halfByKey.get(keyOf(name))).filter(Boolean).map(toArtist)],
      splitInto: names,
      totalTracks: Number(row.track_count || 0),
      outcomes: [
        { id: 'keep-together', kind: 'keep-together' as const, label: 'Keep together' },
        { id: 'split', kind: 'split' as const, label: `Split into ${names.join(' and ')}` },
      ],
    };
  });
}

function duplicateKind(candidate: ArtistDuplicateCandidate): ArtistReviewKind {
  if (candidate.candidateKey.startsWith('artist-amp-compound:')) return 'compound-credit';
  if (candidate.candidateKey.startsWith('artist-mbid:')) return 'same-musicbrainz';
  return 'same-identity';
}

function duplicateEntry(candidate: ArtistDuplicateCandidate): ArtistReviewEntry {
  const kind = duplicateKind(candidate);
  const artists = candidate.artists.map(artist => ({
    id: artist.id,
    name: artist.name,
    mbid: artist.mbid,
    imageUrl: artist.imageUrl || null,
    trackCount: artist.trackCount,
    albumCount: artist.albumCount,
  }));
  return {
    key: candidate.candidateKey,
    signature: candidate.signature,
    kind,
    // A credit row is listed after the artist it would fold into.
    subject: (kind === 'compound-credit' ? artists[1] : artists[0])?.name || candidate.normalizedKey,
    artists,
    totalTracks: candidate.totalTracks,
    outcomes: [
      ...artists.map(artist => ({ id: `merge:${artist.id}`, kind: 'merge' as const, label: `Keep "${artist.name}"` })),
      { id: 'keep-apart', kind: 'keep-apart' as const, label: 'Keep apart' },
    ],
  };
}

export async function getArtistReviewEntries(): Promise<ArtistReviewEntry[]> {
  const db = await initDB();
  const [duplicates, joined] = await Promise.all([getArtistDuplicateCandidates(), getJoinedCreditEntries(db)]);
  // A joined credit is asked about once, as a joined credit.
  const joinedIds = new Set(joined.map(entry => entry.artists[0].id));
  const others = duplicates
    .filter(candidate => !(duplicateKind(candidate) === 'compound-credit' && candidate.artists.some(a => joinedIds.has(a.id))))
    .map(duplicateEntry);
  return [...joined, ...others].sort((a, b) => b.totalTracks - a.totalTracks || a.subject.localeCompare(b.subject));
}

function nameChangesFor(entry: ArtistReviewEntry, outcomeId: string): NameChanges {
  if (outcomeId === 'split' && entry.splitInto) return new Map([[keyOf(entry.subject), entry.splitInto]]);
  if (outcomeId.startsWith('merge:')) {
    const canonical = entry.artists.find(artist => `merge:${artist.id}` === outcomeId);
    if (!canonical) return new Map();
    return new Map(entry.artists.filter(a => a.id !== canonical.id).map(a => [keyOf(a.name), [canonical.name]]));
  }
  return new Map();
}

// Each outcome's artist pages, from the tracks on the involved pages today.
export async function getArtistReviewPreview(key: string): Promise<ArtistReviewPreview | null> {
  const entry = (await getArtistReviewEntries()).find(candidate => candidate.key === key);
  if (!entry) return null;
  const db = await initDB();

  const lists = await Promise.all(entry.artists.flatMap(artist => [
    getTracksByArtist(artist.id),
    getUncreditedTracksOnOwnedAlbums(artist.id, artist.name),
    getArtistAppearsOnTracks(artist.id, artist.name),
  ]));
  const tracks = [...new Map(lists.flat().map((track: any) => [track.id, track])).values()];

  const ownerIds = [...new Set(tracks.map((t: any) => t.artistId).filter(Boolean))];
  const ownerNames = new Map<string, string>((await db.query(
    'SELECT id, name FROM artists WHERE id = ANY($1::uuid[])', [ownerIds],
  )).rows.map((row: any) => [String(row.id), String(row.name)]));
  const albumIds = [...new Set(tracks.map((t: any) => t.albumId).filter(Boolean))];
  const albumCredits = new Map<string, string>((await db.query(
    'SELECT id, artist_name FROM albums WHERE id = ANY($1::uuid[])', [albumIds],
  )).rows.map((row: any) => [String(row.id), String(row.artist_name || '')]));
  const coOwners = await getAlbumCoOwners(db, [...new Set(albumCredits.values())].filter(Boolean));

  const before: PreviewTrack[] = tracks.map((t: any) => {
    const artists: string[] = Array.isArray(t.artists) ? t.artists : [];
    const owner = ownerNames.get(t.artistId) || artists[0] || t.artist || '';
    const credit = albumCredits.get(t.albumId) || t.albumArtist || owner;
    return {
      id: t.id,
      albumId: t.albumId || null,
      albumTitle: t.album || '',
      year: t.year ?? null,
      isCompilation: !!t.isCompilation || /compilation/i.test(t.releaseType || ''),
      owner,
      credited: artists.filter(name => keyOf(name) !== keyOf(owner)),
      albumOwners: coOwners.get(credit.toLowerCase()) || [credit],
    };
  });

  const pages = entry.artists.map(artist => ({ name: artist.name, artistId: artist.id, imageUrl: artist.imageUrl }));
  return {
    key,
    outcomes: entry.outcomes.map(outcome => ({
      id: outcome.id,
      pages: previewArtistPages(pages, before, applyNameChanges(before, nameChangesFor(entry, outcome.id), keyOf), keyOf),
    })),
  };
}

export async function decideArtistReview(opts: {
  key: string;
  signature: string;
  outcomeId: string;
  userId?: string | null;
}): Promise<void> {
  const entry = (await getArtistReviewEntries()).find(candidate => candidate.key === opts.key);
  if (!entry || entry.signature !== opts.signature) throw new Error('This entry has changed since it was loaded');
  if (!entry.outcomes.some(outcome => outcome.id === opts.outcomeId)) throw new Error('Unknown outcome');
  const db = await initDB();

  if (entry.kind === 'joined-credit') {
    await db.query('DELETE FROM artist_duplicate_reviews WHERE candidate_key = $1', [entry.key]);
    await db.query(`
      INSERT INTO artist_duplicate_reviews (candidate_key, signature, decision, artist_ids, decided_by)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `, [entry.key, entry.signature, opts.outcomeId === 'split' ? 'split' : 'kept', JSON.stringify([entry.artists[0].id]), opts.userId || null]);
  } else if (opts.outcomeId === 'keep-apart') {
    await dismissArtistDuplicateCandidate({
      candidateKey: entry.key, signature: entry.signature, artistIds: entry.artists.map(a => a.id), userId: opts.userId,
    });
  } else {
    const canonicalArtistId = opts.outcomeId.slice('merge:'.length);
    await mergeArtistDuplicateCandidate({
      candidateKey: entry.key,
      signature: entry.signature,
      canonicalArtistId,
      duplicateArtistIds: entry.artists.map(a => a.id).filter(id => id !== canonicalArtistId),
      userId: opts.userId,
    });
    await purgeOrphanedEntities();
  }
  await runArtistCreditSplitInBackground();
}

const undoableUntil = (decidedAt: Date) => new Date(decidedAt.getTime() + ARTIST_REVIEW_UNDO_DAYS * 86_400_000);

export async function getRecentArtistReviewDecisions(): Promise<ArtistReviewDecision[]> {
  const db = await initDB();
  const rows = (await db.query(`
    SELECT id, candidate_key, decision, signature, canonical_artist_id, artist_ids, created_at
    FROM artist_duplicate_reviews
    WHERE created_at > NOW() - make_interval(days => $1)
    ORDER BY created_at DESC
  `, [ARTIST_REVIEW_UNDO_DAYS])).rows;
  const ids = [...new Set(rows.flatMap((row: any) => [row.canonical_artist_id, ...(row.artist_ids || [])]).filter(Boolean))];
  const names = new Map<string, string>((await db.query(
    'SELECT id, name FROM artists WHERE id = ANY($1::uuid[])', [ids],
  )).rows.map((row: any) => [String(row.id), String(row.name)]));

  return rows.map((row: any) => {
    const joined = String(row.candidate_key).startsWith(JOINED_CREDIT_KEY_PREFIX);
    const signature = joined ? parseJoinedCreditSignature(row.signature) : null;
    const artistIds: string[] = (row.artist_ids || []).map(String);
    const ordered = row.canonical_artist_id
      ? [String(row.canonical_artist_id), ...artistIds.filter(id => id !== String(row.canonical_artist_id))]
      : artistIds;
    const decidedAt = new Date(row.created_at);
    return {
      id: String(row.id),
      key: String(row.candidate_key),
      decision: row.decision,
      names: signature ? [signature.subject, ...signature.names] : ordered.map(id => names.get(id) || '').filter(Boolean),
      decidedAt: decidedAt.toISOString(),
      undoableUntil: undoableUntil(decidedAt).toISOString(),
    };
  });
}

// Takes a decision back. Keeping apart or together only drops the answer, so
// the entry is asked again. A merge or a split also changed which artist the
// tracks belong to; the caller re-reads the files of the returned tracks so the
// files decide again, without the answer.
export async function undoArtistReviewDecision(decisionId: string): Promise<{ trackIdsToReread: string[] }> {
  const db = await initDB();
  const row = (await db.query('SELECT * FROM artist_duplicate_reviews WHERE id = $1', [decisionId])).rows[0];
  if (!row) throw new Error('Decision not found');
  if (undoableUntil(new Date(row.created_at)) < new Date()) {
    throw new Error(`Decisions can be undone for ${ARTIST_REVIEW_UNDO_DAYS} days`);
  }

  let trackIdsToReread: string[] = [];
  if (row.decision === 'split') {
    const { subject } = parseJoinedCreditSignature(row.signature);
    trackIdsToReread = (await db.query(`
      SELECT id FROM tracks
      WHERE strpos(lower(artist), lower($1)) > 0 OR strpos(lower(COALESCE(album_artist, '')), lower($1)) > 0
    `, [subject])).rows.map((r: any) => String(r.id));
  } else if (row.decision === 'merged' && row.canonical_artist_id) {
    const canonicalId = String(row.canonical_artist_id);
    const folded = (row.artist_ids || []).map(String).filter((id: string) => id !== canonicalId);
    const unmerged = (await db.query(
      'UPDATE artists SET merged_into = NULL WHERE id = ANY($1::uuid[]) AND merged_into = $2 RETURNING name',
      [folded, canonicalId],
    )).rows.map((r: any) => String(r.name));
    trackIdsToReread = (await db.query(`
      SELECT t.id FROM tracks t
      LEFT JOIN albums al ON al.id = t.album_id
      WHERE t.artist_id = $1
         OR lower(al.artist_name) = (SELECT lower(name) FROM artists WHERE id = $1)
         OR t.artists ILIKE ANY($2::text[])
    `, [canonicalId, unmerged.map(name => `%${JSON.stringify(name)}%`)])).rows.map((r: any) => String(r.id));
    clearEntityCaches();
  }
  await db.query('DELETE FROM artist_duplicate_reviews WHERE id = $1', [decisionId]);
  return { trackIdsToReread };
}
