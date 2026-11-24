import { albumSummary, discKind, type AlbumSummaryFacts } from './albumSummary';

const facts = (patch: Partial<AlbumSummaryFacts>): AlbumSummaryFacts => ({ title: 'Wasting Light', artist: 'Foo Fighters', releaseType: 'Album', ...patch });

describe('albumSummary', () => {
  it('says where it was recorded, a city once', () => {
    const place = (name: string, area: string | null) => ({ name, area });
    expect(albumSummary(facts({ recordedAt: [place('Geejam Studios', 'Port Antonio'), place('The Village', 'Los Angeles')] })))
      .toEqual(['It was recorded at Geejam Studios in Port Antonio and The Village in Los Angeles.']);
    expect(albumSummary(facts({ recordedAt: [place('Abbey Road Studios', null)] }))).toEqual(['It was recorded at Abbey Road Studios.']);
    expect(albumSummary(facts({ recordedAt: [place('Electric Lady Studios New York', 'New York')] }))).toEqual(['It was recorded at Electric Lady Studios New York.']);
    expect(albumSummary(facts({ recordedAt: ['A', 'B', 'C', 'D'].map(n => place(n, null)) })))
      .toEqual(['It was recorded at A, B and C, among other places.']);
  });

  it('adds an unusual status and, for collectors, the catalog number and barcode', () => {
    expect(albumSummary(facts({ media: 'CD', releaseStatus: 'Promotion', catalogNumber: 'BBK002CD', barcode: '0190295076108' }))).toEqual([
      'Your copy is the CD release.',
      'This is a promotional release.',
      'Its catalog number is BBK002CD and its barcode 0190295076108.',
    ]);
    expect(albumSummary(facts({ releaseStatus: 'official', catalogNumber: 'BBK002CD' }))).toEqual(['Its catalog number is BBK002CD.']);
    expect(albumSummary(facts({ releaseStatus: 'pseudo-release', barcode: '0190295076108' }))).toEqual(['Its barcode is 0190295076108.']);
  });

  it('writes when and by whom it was released, then which release the files are', () => {
    expect(albumSummary(facts({ label: 'RCA Records', releaseDate: '2011-04-12', originalDate: '2011-04-12', media: 'CD' }))).toEqual([
      'Wasting Light is an album by Foo Fighters, released on 12 April 2011 by RCA Records.',
      'Your copy is the CD release.',
    ]);
  });

  it('says as much of the date as is tagged', () => {
    expect(albumSummary(facts({ releaseDate: '2011-04' }))[0]).toBe('Wasting Light is an album by Foo Fighters, released in April 2011.');
    expect(albumSummary(facts({ releaseDate: '2011' }))[0]).toBe('Wasting Light is an album by Foo Fighters, released in 2011.');
    expect(albumSummary(facts({ label: 'RCA Records' }))[0]).toBe('Wasting Light is an album by Foo Fighters, released by RCA Records.');
  });

  it('says when a reissue first came out', () => {
    expect(albumSummary(facts({ title: 'Cultösaurus Erectus', artist: 'Blue Öyster Cult', releaseDate: '2008-02-12', originalDate: '1980-06' }))).toEqual([
      'Cultösaurus Erectus is an album by Blue Öyster Cult, released on 12 February 2008.',
      'It first came out in 1980.',
    ]);
    expect(albumSummary(facts({ originalDate: '1980' }))).toEqual(['It first came out in 1980.']);
  });

  it('names the medium in words', () => {
    expect(albumSummary(facts({ media: '12" Vinyl' }))).toEqual(['Your copy is the 12″ vinyl release.']);
    expect(albumSummary(facts({ media: 'Digital Media' }))).toEqual(['Your copy is the digital release.']);
    expect(albumSummary(facts({ releaseType: 'EP', releaseDate: '2020' }))[0]).toBe('Wasting Light is an EP by Foo Fighters, released in 2020.');
  });

  it('says nothing without release facts', () => {
    expect(albumSummary(facts({}))).toEqual([]);
  });
});

it('tells a CD from a record', () => {
  expect(discKind('CD')).toBe('cd');
  expect(discKind('Enhanced CD')).toBe('cd');
  expect(discKind('SACD')).toBe('cd');
  expect(discKind('12" Vinyl')).toBe('vinyl');
  expect(discKind('Digital Media')).toBeNull();
  expect(discKind(null)).toBeNull();
});
