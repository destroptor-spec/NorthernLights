import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { MemoryRouter } from 'react-router-dom';
import { PlaylistItem } from './PlaylistItem';

jest.mock('./LoveButton', () => ({ LoveButton: () => null }));
jest.mock('./AlbumArt', () => ({ AlbumArt: () => null }));

const renderRow = (isActive: boolean) => render(
  <MemoryRouter>
    <DndContext>
      <SortableContext items={['row-1']}>
        <ul>
          <PlaylistItem
            id="row-1" index={1} isActive={isActive} isSidebarCollapsed={false} totalTracks={3}
            track={{ id: 't1', path: 'p1', title: 'Enigma', artist: 'A' }}
            onPlay={jest.fn()} onRemove={jest.fn()} onMove={jest.fn()} onContextMenu={jest.fn()}
            getArtistLink={() => null} parseArtists={(artists) => [artists]}
          />
        </ul>
      </SortableContext>
    </DndContext>
  </MemoryRouter>,
);

test('offers Remove for a queued track', () => {
  renderRow(false);
  expect(screen.getByRole('button', { name: 'Remove track Enigma' })).toBeTruthy();
});

test('has no Remove on the playing track (Skip moves past it)', () => {
  renderRow(true);
  expect(screen.queryByRole('button', { name: 'Remove track Enigma' })).toBeNull();
});
