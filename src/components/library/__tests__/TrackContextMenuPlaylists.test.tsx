import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TrackContextMenu } from '../TrackContextMenu';
import { usePlayerStore } from '../../../store';

const track = { id: 't1', title: 'Miles on It', artist: 'Marshmello', album: 'Album', duration: 180, url: '/x', path: 'p' };
const playlist = (id: string, title: string, kind: Record<string, unknown> = {}) =>
  ({ id, title, tracks: [], isOwner: true, pinned: false, isSystem: false, isLlmGenerated: false, generationSource: 'manual', ...kind });

test('Add to Playlist lists only playlists the listener can add tracks to', () => {
  usePlayerStore.setState({
    playlists: [
      playlist('p1', 'My mix'),
      playlist('p2', 'Coding prompt mix', { isLlmGenerated: true, generationSource: 'custom' }),
      playlist('p3', 'Marshmello Radio', { isSystem: true, generationSource: 'artist-radio' }),
      playlist('p4', 'Daylist', { isSystem: true, generationSource: 'daylist' }),
      playlist('p5', 'Trance Horizon', { isLlmGenerated: true, generationSource: 'hub' }),
      playlist('p6', "A friend's list", { isOwner: false }),
    ],
  } as never);
  render(<MemoryRouter><TrackContextMenu /></MemoryRouter>);
  act(() => { usePlayerStore.getState().openContextMenu(track as never, 100, 100); });

  fireEvent.click(screen.getByRole('button', { name: 'Add to Playlist' }));

  for (const title of ['My mix', 'Coding prompt mix']) expect(screen.getByRole('button', { name: title })).toBeTruthy();
  for (const title of ['Marshmello Radio', 'Daylist', 'Trance Horizon', "A friend's list"]) {
    expect(screen.queryByRole('button', { name: title })).toBeNull();
  }
});
