import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProviderOrderEditor } from './ProviderOrderEditor';
import { DEFAULT_METADATA_PROVIDER_PRIORITY, type MetadataProviderPriority } from '../../../shared/metadataProviders';

const allConnected = { lastfm: true, genius: true, musicbrainz: true, theaudiodb: true, fanarttv: true };

function setup(priority: MetadataProviderPriority, connected = allConnected) {
  const onChange = jest.fn();
  render(<ProviderOrderEditor priority={priority} connected={connected} onChange={onChange} />);
  return onChange;
}

const list = (label: string) => screen.getByRole('list', { name: `${label}: providers in order` });

it('lists each item’s providers in order', () => {
  setup(DEFAULT_METADATA_PROVIDER_PRIORITY);

  const rows = within(list('Album art')).getAllByRole('listitem').map((li) => li.textContent);
  expect(rows).toEqual(['1MusicBrainz', '2Last.fm', '3Genius']);
});

it('stops asking a provider with ×, leaving the other items alone', () => {
  const onChange = setup(DEFAULT_METADATA_PROVIDER_PRIORITY);

  fireEvent.click(within(list('Artist bios')).getByRole('button', { name: 'Stop asking Last.fm' }));

  expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_METADATA_PROVIDER_PRIORITY, artistBio: ['genius'] });
});

it('offers only set-up providers the list lacks, and adds one at the end', () => {
  const onChange = setup({ ...DEFAULT_METADATA_PROVIDER_PRIORITY, albumArt: ['lastfm'] }, { ...allConnected, genius: false, theaudiodb: false, fanarttv: false });

  const add = screen.getByRole('combobox', { name: 'Add a provider for album art' });
  expect(within(add).getAllByRole('option').map((o) => o.textContent)).toEqual(['Add provider…', 'MusicBrainz']);
  expect(screen.getAllByText('Set up Genius or TheAudioDB or fanart.tv to add them here.').length).toBeGreaterThan(0);

  fireEvent.change(add, { target: { value: 'musicbrainz' } });

  expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_METADATA_PROVIDER_PRIORITY, albumArt: ['lastfm', 'musicbrainz'] });
});

it('says an empty item is not looked up, and marks a listed provider that is not set up', () => {
  setup({ ...DEFAULT_METADATA_PROVIDER_PRIORITY, artistBanner: [] }, { ...allConnected, lastfm: false });

  expect(screen.getByText('Not looked up.')).toBeTruthy();
  expect(within(list('Artist images')).getByText('Not set up, skipped')).toBeTruthy();
});
