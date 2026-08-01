import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

// Match the breakpoints used by `.album-grid` / `.artist-grid` / `.genre-grid`
// in src/index.css so a virtualized grid looks identical to the static one.
// Keep these in sync if those breakpoints change.
const COLUMN_BREAKPOINTS = [
    { minWidth: 1280, columns: 6 },
    { minWidth: 1024, columns: 5 },
    { minWidth: 768, columns: 4 },
    { minWidth: 640, columns: 4 },
    { minWidth: 0, columns: 3 },
] as const;

const ROW_GAP_BY_WIDTH = (width: number): number => {
    if (width >= 768) return 24; // 1.5rem
    if (width >= 640) return 16; // 1rem
    return 12; // 0.75rem
};

const COLUMN_GAP_BY_WIDTH = ROW_GAP_BY_WIDTH;

type ColumnBreakpoint = { minWidth: number; columns: number };

const columnsForWidth = (width: number, breakpoints: readonly ColumnBreakpoint[]): number => {
    for (const bp of breakpoints) {
        if (width >= bp.minWidth) return bp.columns;
    }
    return breakpoints[breakpoints.length - 1]?.columns ?? 3;
};

interface VirtualizedCardGridProps<T> {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    getKey: (item: T, index: number) => React.Key;
    // Caller supplies the estimated row height (excluding gap) in pixels, as a
    // function of the computed column width, so the virtualizer can place rows
    // without measuring every one.
    estimatedRowHeight: (columnWidth: number) => number;
    // Hint/fallback only. The grid resolves the *actual* scroll viewport from the
    // DOM (nearest scrollable ancestor), because a passed ref can point at an
    // element that has `overflow:auto` but never actually scrolls (e.g. a nested
    // container that just grows to its content). Using such an element makes
    // react-virtual treat every row as visible and mount the whole list.
    scrollParentRef?: React.RefObject<HTMLElement | null>;
    overscan?: number;
    // Layout overrides. Default to the square-thumbnail album/artist grid;
    // callers with a different shape (e.g. the wide playlist cards) pass their
    // own breakpoints/gaps. Must be sorted descending by minWidth.
    columnBreakpoints?: readonly ColumnBreakpoint[];
    rowGapForWidth?: (width: number) => number;
    columnGapForWidth?: (width: number) => number;
}

// Windowed grid that mirrors the static CSS-grid layout but only mounts the
// rows currently in (or near) the viewport. Avoids paying React reconciliation
// + DOM creation cost for hundreds of cards at once — the original killer on
// mobile when navigating into the album or artist library.
//
// IMPORTANT — width is measured from a dedicated zero-height sentinel, NOT from
// the tall spacer that carries `height: totalSize`. Observing the tall element
// created a feedback loop: its height made the page scroll-container overflow,
// the scrollbar shrank clientWidth, the ResizeObserver fired, state changed,
// the height changed again… Switching sections (different row heights/counts)
// destabilised that into a non-converging loop that crashed the tab. The
// sentinel's height is always 0, so observing it only ever reacts to genuine
// width changes (viewport resize, scrollbar toggle) and settles immediately.
export function VirtualizedCardGrid<T>({
    items,
    renderItem,
    getKey,
    estimatedRowHeight,
    scrollParentRef,
    overscan = 4,
    columnBreakpoints = COLUMN_BREAKPOINTS,
    rowGapForWidth = ROW_GAP_BY_WIDTH,
    columnGapForWidth = COLUMN_GAP_BY_WIDTH,
}: VirtualizedCardGridProps<T>) {
    const rootRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

    // Resolve the genuine scroll viewport: the nearest ancestor whose computed
    // overflow-y is auto/scroll. We do NOT just trust scrollParentRef — pointing
    // react-virtual at a non-scrolling element (one that grows to its content)
    // makes getTotalSize ≈ clientHeight, so every row falls inside the visible
    // window and the entire list mounts (the killer style-recalc on big grids).
    useLayoutEffect(() => {
        let el: HTMLElement | null = rootRef.current?.parentElement ?? null;
        while (el) {
            const oy = getComputedStyle(el).overflowY;
            if (oy === 'auto' || oy === 'scroll') break;
            el = el.parentElement;
        }
        setScrollEl(el ?? scrollParentRef?.current ?? null);
    }, [scrollParentRef]);

    useLayoutEffect(() => {
        const el = measureRef.current;
        if (!el) return;
        const update = () => {
            const next = Math.round(el.clientWidth);
            // Bail when the width is unchanged so a scrollbar toggle (or any
            // observer re-fire) can't bounce state back and forth.
            setContainerWidth((prev) => (prev === next ? prev : next));
        };
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const columns = useMemo(
        () => columnsForWidth(containerWidth || (typeof window !== 'undefined' ? window.innerWidth : 1024), columnBreakpoints),
        [containerWidth, columnBreakpoints]
    );
    const columnGap = columnGapForWidth(containerWidth);
    const rowGap = rowGapForWidth(containerWidth);

    const columnWidth = useMemo(() => {
        if (!containerWidth || columns <= 0) return 0;
        const totalGap = columnGap * (columns - 1);
        return Math.max(0, (containerWidth - totalGap) / columns);
    }, [containerWidth, columns, columnGap]);

    const rowCount = Math.ceil(items.length / columns);
    const rowHeight = estimatedRowHeight(columnWidth);

    const virtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => scrollEl,
        estimateSize: () => rowHeight + rowGap,
        overscan,
    });

    // Re-measure when geometry changes (column count, row height, item count) or
    // once the scroll element is resolved. `virtualizer` is a stable instance
    // from @tanstack/react-virtual, so it doesn't retrigger this effect itself.
    useEffect(() => {
        virtualizer.measure();
    }, [columns, rowHeight, rowGap, items.length, scrollEl, virtualizer]);

    // Don't render rows until the container has been measured. Before the
    // first layout pass containerWidth is 0, which forces columnWidth → 0 and a
    // tiny estimated row height; combined with an as-yet-unmeasured scroll
    // element the virtualizer would compute an enormous visible range and mount
    // hundreds of cards at once (each firing an /api/art request), piling up on
    // HTTP/1.1 until the tab OOMs. useLayoutEffect sets the width before paint,
    // so this gate costs no visible frame.
    const measured = containerWidth > 0 && columnWidth > 0 && !!scrollEl;
    const virtualRows = measured ? virtualizer.getVirtualItems() : [];
    const totalSize = measured ? virtualizer.getTotalSize() : 0;

    return (
        <div ref={rootRef} style={{ position: 'relative', width: '100%' }}>
            {/* Width measurement sentinel — height:0 so it never participates in
                the scroll-height feedback that crashed the tab. */}
            <div ref={measureRef} aria-hidden style={{ width: '100%', height: 0 }} />

            {/* Spacer that reserves the full virtual height; rows are absolutely
                positioned within it. */}
            <div style={{ position: 'relative', width: '100%', height: totalSize > 0 ? totalSize : undefined }}>
                {virtualRows.map((virtualRow) => {
                    const rowIndex = virtualRow.index;
                    const startIndex = rowIndex * columns;
                    const rowItems = items.slice(startIndex, startIndex + columns);
                    return (
                        <div
                            key={virtualRow.key}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${virtualRow.start}px)`,
                                display: 'grid',
                                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                                columnGap: `${columnGap}px`,
                                rowGap: `${rowGap}px`,
                            }}
                        >
                            {rowItems.map((item, colIndex) => (
                                <React.Fragment key={getKey(item, startIndex + colIndex)}>
                                    {renderItem(item, startIndex + colIndex)}
                                </React.Fragment>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
