import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { MemoryRouter } from 'react-router-dom';
import { PlaylistItem } from './PlaylistItem';

jest.mock('./LoveButton', () => ({ LoveButton: () => null }));
jest.mock('./AlbumArt', () => ({ AlbumArt: () => null }));

const renderRow = (isActive: boolean, handlers: Partial<{ onPlay: jest.Mock; onContextMenu: jest.Mock }> = {}) => render(
  <MemoryRouter>
    <DndContext>
      <SortableContext items={['row-1']}>
        <ul>
          <PlaylistItem
            id="row-1" index={1} isActive={isActive} isSidebarCollapsed={false}
            track={{ id: 't1', path: 'p1', title: 'Enigma', artist: 'A' }}
            onPlay={handlers.onPlay ?? jest.fn()} onContextMenu={handlers.onContextMenu ?? jest.fn()}
            getArtistLink={() => null} parseArtists={(artists) => [artists]}
          />
        </ul>
      </SortableContext>
    </DndContext>
  </MemoryRouter>,
);

test('desktop rows: ⋯ opens the menu (Remove and Love are in it), the cover holds the drag handle', () => {
  const onContextMenu = jest.fn();
  const onPlay = jest.fn();
  renderRow(false, { onContextMenu, onPlay });
  expect(screen.queryByRole('button', { name: 'Remove track Enigma' })).toBeNull();
  screen.getByRole('button', { name: 'More options for Enigma' }).click();
  expect(onContextMenu).toHaveBeenCalled();
  expect(onPlay).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Reorder Enigma').closest('.queue-row-art')).toBeTruthy();
});

test('marks the playing track as current', () => {
  renderRow(true);
  const row = document.querySelector('.queue-row')!;
  expect(row.className).toContain('is-current');
  expect(row.getAttribute('aria-current')).toBe('true');
});

test('during a gig, shows who queued the track', () => {
  render(
    <MemoryRouter>
      <DndContext>
        <SortableContext items={['row-1']}>
          <ul>
            <PlaylistItem
              id="row-1" index={1} isActive={false} isSidebarCollapsed={false}
              track={{ id: 't1', path: 'p1', title: 'Enigma', artist: 'A', queued: true, queuedBy: 'u2' }}
              queuedBy={{ avatar: { userId: 'u2', initial: 'T', pictureUrl: null }, name: 'Tove' }}
              onPlay={jest.fn()} onContextMenu={jest.fn()} getArtistLink={() => null} parseArtists={(a) => [a]}
            />
          </ul>
        </SortableContext>
      </DndContext>
    </MemoryRouter>,
  );
  expect(screen.getByTitle('Queued by Tove')).toBeTruthy();
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
                id="row-1" index={1} isActive={false} isSidebarCollapsed={false} touch
                track={{ id: 't1', path: 'p1', title: 'Enigma', artist: 'A feat. B', duration: 221 }}
                onPlay={onPlay} onContextMenu={onContextMenu}
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
