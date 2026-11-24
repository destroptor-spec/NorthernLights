/**
 * @jest-environment node
 */
import { releaseTags, tagDate } from './releaseTags';

it('reads the label, dates and medium as tagged', () => {
  expect(releaseTags({ common: { label: ['RCA Records'], date: '2011-04-12', originaldate: '2011', media: 'CD' } }))
    .toMatchObject({ label: 'RCA Records', releaseDate: '2011-04-12', originalDate: '2011', media: 'CD' });
});

it('skips MusicBrainz’s "no label" and blanks, and keeps the first real label', () => {
  expect(releaseTags({ common: { label: ['[no label]', ' ', 'Breakbeat Kaos'] } }).label).toBe('Breakbeat Kaos');
  expect(releaseTags({ common: { label: ['[none]'] } }).label).toBeNull();
  expect(releaseTags({ common: {} })).toEqual({
    label: null, releaseDate: null, originalDate: null, media: null, catalogNumber: null, barcode: null,
    releaseStatus: null, copyright: null, discSubtitle: null, explicit: null,
  });
});

it('keeps as much of a date as is tagged, and nothing that is not one', () => {
  expect(tagDate('2011-04-12T00:00:00')).toBe('2011-04-12');
  expect(tagDate('2011/04')).toBe('2011-04');
  expect(tagDate('1994')).toBe('1994');
  expect(tagDate('2011-13-01')).toBe('2011');
  expect(tagDate('0000')).toBeNull();
  expect(tagDate('soon')).toBeNull();
});

it('reads the catalog number, barcode, status, ℗ line and disc subtitle, and drops what isn’t one', () => {
  expect(releaseTags({ common: {
    catalognumber: ['[none]', 'BBK002CD'], barcode: '0190 2950 76108', releasestatus: 'Promotion',
    copyright: '℗ 2014 Copenhagen Records / Universal Music', discsubtitle: ['B-Sides & Bonus Tracks'],
  } })).toMatchObject({
    catalogNumber: 'BBK002CD', barcode: '0190295076108', releaseStatus: 'promotion',
    copyright: '℗ 2014 Copenhagen Records / Universal Music', discSubtitle: 'B-Sides & Bonus Tracks',
  });
  expect(releaseTags({ common: { copyright: 'PMEDIA', barcode: 'none' } })).toMatchObject({ copyright: null, barcode: null });
  expect(releaseTags({ common: { copyright: '(P) 2023 Viking Wizard Eyes, LLC' } }).copyright).toBe('(P) 2023 Viking Wizard Eyes, LLC');
});

it('reads explicit and clean as iTunes tags them, in every format', () => {
  const advisory = (value: string) => releaseTags({ common: {}, native: { vorbis: [{ id: 'ITUNESADVISORY', value }] } }).explicit;
  expect(advisory('1')).toBe(true);
  expect(advisory('2')).toBe(false);
  expect(advisory('0')).toBeNull();
  expect(releaseTags({ common: {}, native: { iTunes: [{ id: 'rtng', value: 4 }] } }).explicit).toBe(true);
  expect(releaseTags({ common: {}, native: { 'ID3v2.4': [{ id: 'TXXX', value: { description: 'ITUNESADVISORY', text: ['1'] } }] } }).explicit).toBe(true);
  expect(releaseTags({ common: {}, native: { 'ID3v2.4': [{ id: 'TXXX', value: { description: 'MOOD', text: ['1'] } }] } }).explicit).toBeNull();
});

it('takes a tag as a plain string where music-metadata gives one instead of a list', () => {
  // A FLAC's DISCSUBTITLE arrives as a string; a list was assumed and the whole file failed to read.
  const tags = releaseTags({ common: { discsubtitle: 'Bonus EP' as never, label: 'Warner Records' as never, catalognumber: 'BBK002CD' as never } });
  expect(tags).toMatchObject({ discSubtitle: 'Bonus EP', label: 'Warner Records', catalogNumber: 'BBK002CD' });
});

it('says a ℗ line once when the file has it twice with its symbols lost', () => {
  const line = (copyright: string) => releaseTags({ common: { copyright } }).copyright;
  expect(line('2024 Mine Recordings 2024 Mine Recordings')).toBe('2024 Mine Recordings');
  expect(line('2011 Yellow Productions, under exclusive distribution & representation by Balagan Music / Wagram Music 2011 Yellow Productions, under exclusive distribution & representation by Balagan Music / Wagram Music'))
    .toBe('2011 Yellow Productions, under exclusive distribution & representation by Balagan Music / Wagram Music');
  // Real pairs and single lines stay as they are.
  expect(line('℗ & © 2008 Anjunabeats')).toBe('℗ & © 2008 Anjunabeats');
  expect(line('℗ 2024 Mine Recordings © 2024 Mine Recordings')).toBe('℗ 2024 Mine Recordings © 2024 Mine Recordings');
  expect(line('2017 Liquicity Records')).toBe('2017 Liquicity Records');
});
