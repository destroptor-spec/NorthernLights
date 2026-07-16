interface FocusableAlbumRow {
  type: string;
  track?: { id: string };
}

interface ScrollAlbumTrackTargetOptions {
  rows: FocusableAlbumRow[];
  targetTrackId: string;
  container: HTMLElement | null;
  virtualized: boolean;
  behavior: ScrollBehavior;
  scrollToIndex: (index: number, options: { align: 'center'; behavior: ScrollBehavior }) => void;
}

export function scrollToAlbumTrackTarget({
  rows,
  targetTrackId,
  container,
  virtualized,
  behavior,
  scrollToIndex,
}: ScrollAlbumTrackTargetOptions): boolean {
  const targetRowIndex = rows.findIndex(row => row.type === 'track' && row.track?.id === targetTrackId);
  if (targetRowIndex < 0) return false;

  if (virtualized) {
    scrollToIndex(targetRowIndex, { align: 'center', behavior });
    return true;
  }

  const targetRow = Array.from(container?.querySelectorAll<HTMLElement>('[data-track-id]') || [])
    .find(row => row.dataset.trackId === targetTrackId);
  if (!targetRow) return false;
  targetRow.scrollIntoView({ block: 'center', behavior });
  return true;
}
