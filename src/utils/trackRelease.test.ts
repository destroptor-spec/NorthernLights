import { trackReleaseFacts, trackReleaseLinks } from './trackRelease';
import type { TrackRays } from '../../shared/api/v1';

const empty: TrackRays['release'] = {
  label: null, releaseDate: null, originalDate: null, media: null, catalogNumber: null, barcode: null,
  releaseStatus: null, copyright: null, discSubtitle: null, isrc: null, links: [],
};
const track = { discNumber: 1, trackNumber: 3 };

test('leaves out every fact the file has no tag for', () => {
  expect(trackReleaseFacts(empty, track)).toEqual([]);
  expect(trackReleaseLinks(empty, null)).toEqual([]);
});

test('says the date in words, and the first release only for a reissue', () => {
  expect(trackReleaseFacts({ ...empty, releaseDate: '2011-04', originalDate: '2011' }, track))
    .toEqual([{ key: 'released', label: 'Released', value: 'April 2011', detail: undefined }]);
  expect(trackReleaseFacts({ ...empty, releaseDate: '2014-03-04', originalDate: '1997-01-01' }, track)[0])
    .toMatchObject({ value: '4 March 2014', detail: 'First released 1997' });
  // Only the original date: that is when it came out.
  expect(trackReleaseFacts({ ...empty, originalDate: '1997' }, track)[0]).toMatchObject({ value: '1997' });
});

test('puts the catalog number under the label, and names the medium and the disc', () => {
  const facts = trackReleaseFacts({ ...empty, label: 'Warp', catalogNumber: 'WARPCD92', media: '12" Vinyl', discSubtitle: 'B-Sides' }, { discNumber: 2, trackNumber: 1 });
  expect(facts).toEqual([
    { key: 'label', label: 'Label', value: 'Warp', detail: 'WARPCD92' },
    { key: 'media', label: 'Medium', value: '12″ vinyl', detail: 'Disc 2 · B-Sides' },
  ]);
  // Disc 1 of a plain release says nothing about the disc.
  expect(trackReleaseFacts({ ...empty, media: 'CD' }, track)).toEqual([{ key: 'media', label: 'Medium', value: 'CD', detail: undefined }]);
  // A catalog number without a label stands alone, as a code.
  expect(trackReleaseFacts({ ...empty, catalogNumber: 'ABC-1' }, track)).toEqual([{ key: 'catalog', label: 'Catalog number', value: 'ABC-1', code: true }]);
});

test('says the status only when it is not the usual official release', () => {
  expect(trackReleaseFacts({ ...empty, releaseStatus: 'official' }, track)).toEqual([]);
  expect(trackReleaseFacts({ ...empty, releaseStatus: 'pseudo-release' }, track)).toEqual([]);
  expect(trackReleaseFacts({ ...empty, releaseStatus: 'promotion' }, track)).toEqual([{ key: 'status', label: 'Status', value: 'Promotional release' }]);
});

test('links the MusicBrainz recording and the file\'s release links, never an artist\'s or label\'s page', () => {
  const links = trackReleaseLinks({ ...empty, links: [
    { url: 'https://www.discogs.com/artist/1-Someone', type: 'discogs' },
    { url: 'https://www.discogs.com/master/2-Album', type: 'discogs' },
    { url: 'https://www.discogs.com/master/2-Album', type: 'discogs' },
    { url: 'https://www.discogs.com/release/3-Album', type: 'discogs' },
    { url: 'https://www.allmusic.com/song/mt0001', type: 'other' },
    { url: 'https://musicbrainz.org/release/abc', type: 'musicbrainz' },
    { url: 'https://open.spotify.com/artist/abc', type: 'streaming' },
  ] }, 'rec-1');
  // One chip per site: the first link there.
  expect(links.map(l => l.url)).toEqual([
    'https://musicbrainz.org/recording/rec-1',
    'https://www.discogs.com/master/2-Album',
    'https://www.allmusic.com/song/mt0001',
  ]);
});
