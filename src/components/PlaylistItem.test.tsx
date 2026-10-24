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

describe('touch rows (mobile Now Playing queue)', () => {
  const renderTouchRow = (handlers: Partial<{ onPlay: jest.Mock; onContextMenu: jest.Mock }> = {}) => {
    const onPlay = handlers.onPlay ?? jest.fn();
    const onContextMenu = handlers.onContextMenu ?? jest.fn();
    render(
      <MemoryRouter>
        <DndContext>
          <SortableContext items={['row-1']}>
            <ul>
              <PlaylistItem
                id="row-1" index={1} isActive={false} isSidebarCollapsed={false} totalTracks={3} touch
                track={{ id: 't1', path: 'p1', title: 'Enigma', artist: 'A feat. B', duration: 221 }}
                onPlay={onPlay} onRemove={jest.fn()} onMove={jest.fn()} onContextMenu={onContextMenu}
                getArtistLink={() => '/library/artist/a'} parseArtists={() => ['A', 'B']}
              />
            </ul>
          </SortableContext>
        </DndContext>
      </MemoryRouter>,
    );
    return { onPlay, onContextMenu };
  };

  test('artists are plain text: a tap anywhere on the row plays it', () => {
    const { onPlay } = renderTouchRow();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText(/A, B/)).toBeTruthy();
    screen.getByText(/A, B/).click();
    expect(onPlay).toHaveBeenCalledWith(1);
  });

  test('a visible menu button and a drag handle, and nothing that only shows on hover', () => {
    const { onPlay, onContextMenu } = renderTouchRow();
    screen.getByRole('button', { name: 'More options for Enigma' }).click();
    expect(onContextMenu).toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Reorder Enigma').className).toContain('queue-row-drag-handle');
    expect(screen.queryByRole('button', { name: 'Remove track Enigma' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(document.querySelector('.group-hover\\:opacity-100')).toBeNull();
  });

  test('a long press opens the menu', () => {
    const { onContextMenu } = renderTouchRow();
    const row = screen.getByText('Enigma').closest('li')!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 10, 20);
  });
});
