// The Release card on "Aurora rays from {title}": the release the track's file
// is tagged with, as short facts. Deterministic, only what the tags say; a
// missing tag leaves its fact out.
import type { TrackRays } from '../../shared/api/v1';
import { mediumName, taggedDate, yearOf } from './albumSummary';
import { getLinkLabel, isArtistLevelUrl } from './linkLabels';

export interface ReleaseFact {
  key: string;
  label: string;
  value: string;
  /** A second, quieter line: the catalog number, the disc, "First released 1997". */
  detail?: string;
  /** Codes (ISRC, barcode) read better in tabular figures. */
  code?: boolean;
}

// Said only when it isn't the usual official release (as the album's At a glance).
const STATUS: Record<string, string> = {
  promotion: 'Promotional release',
  bootleg: 'Bootleg',
  withdrawn: 'Withdrawn',
};

type Release = TrackRays['release'];
type Track = Pick<TrackRays['track'], 'discNumber' | 'trackNumber'>;

export function trackReleaseFacts(release: Release, track: Track): ReleaseFact[] {
  const facts: ReleaseFact[] = [];

  const released = release.releaseDate ? taggedDate(release.releaseDate) : null;
  const first = yearOf(release.originalDate);
  const thisOne = yearOf(release.releaseDate);
  if (released) {
    facts.push({
      key: 'released', label: 'Released', value: released,
      detail: first && thisOne && first < thisOne ? `First released ${first}` : undefined,
    });
  } else if (release.originalDate && taggedDate(release.originalDate)) {
    facts.push({ key: 'released', label: 'Released', value: taggedDate(release.originalDate)! });
  }

  if (release.label) {
    facts.push({ key: 'label', label: 'Label', value: release.label, detail: release.catalogNumber ?? undefined });
  } else if (release.catalogNumber) {
    facts.push({ key: 'catalog', label: 'Catalog number', value: release.catalogNumber, code: true });
  }

  const disc = [
    track.discNumber && (track.discNumber > 1 || release.discSubtitle) ? `Disc ${track.discNumber}` : null,
    release.discSubtitle,
  ].filter(Boolean).join(' · ');
  if (release.media) facts.push({ key: 'media', label: 'Medium', value: mediumName(release.media), detail: disc || undefined });
  else if (disc) facts.push({ key: 'media', label: 'Disc', value: disc });

  const status = release.releaseStatus ? STATUS[release.releaseStatus] : undefined;
  if (status) facts.push({ key: 'status', label: 'Status', value: status });

  if (release.isrc) facts.push({ key: 'isrc', label: 'ISRC', value: release.isrc, code: true });
  if (release.barcode) facts.push({ key: 'barcode', label: 'Barcode', value: release.barcode, code: true });
  return facts;
}

/**
 * Links about this recording or its release: MusicBrainz's recording page,
 * then the file's links that point at a release or a track (a Discogs
 * release, an AllMusic song, a Spotify album …). Artist and label homepages
 * belong on the artist page and are left out here. One link per site (a
 * Discogs release and its master would be two chips both saying Discogs):
 * the first, so MusicBrainz's recording beats a release page there.
 */
export function trackReleaseLinks(release: Release, recordingId: string | null | undefined): Array<{ url: string; type: string }> {
  const links: Array<{ url: string; type: string }> = [];
  const seen = new Set<string>();
  const add = (url: string, type: string) => {
    const site = getLinkLabel(url, type);
    if (seen.has(site)) return;
    seen.add(site);
    links.push({ url, type });
  };
  if (recordingId) add(`https://musicbrainz.org/recording/${encodeURIComponent(recordingId)}`, 'musicbrainz');
  for (const link of release.links) {
    if (!isArtistLevelUrl(link.url)) add(link.url, link.type);
  }
  return links;
}
