import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, ChevronDown, X, ArrowDownAZ, ArrowUp, Search, Check } from 'lucide-react';
import {
  ContextMenuPortal,
  ContextMenuFrame,
  ContextMenuHeader,
  ContextMenuList,
} from '../ContextMenu';
import {
  FilterState,
  ARTIST_FACETS,
  ALBUM_FACETS,
} from '../../utils/filterState';
import { useFilterActions } from '../../hooks/useFilterActions';
import { useGenreTaxonomy } from '../../hooks/useGenreTaxonomy';
import { GenreFacetMenu } from './GenreFacetMenu';
import type { SortOption } from '../../store/index';

interface FilterBarProps {
  view: 'artists' | 'albums';
  filterState: FilterState;
  onFilterChange: (state: FilterState) => void;
  onOpenQueryBuilder: () => void;
  facetValues: { value: string; count: number }[][];
  isMobile?: boolean;
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recentlyAdded', label: 'Recently added' },
  { value: 'year', label: 'Year' },
];

export const FilterBar: React.FC<FilterBarProps> = ({
  view,
  filterState,
  onFilterChange,
  onOpenQueryBuilder,
  facetValues,
  isMobile,
}) => {
  const [openFacet, setOpenFacet] = useState<string | null>(null);
  const facetRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLButtonElement>(null);
  const [tooltip, setTooltip] = useState<{ key: string; label: string; sub?: string; rect: DOMRect } | null>(null);

  const facets = view === 'artists' ? ARTIST_FACETS : ALBUM_FACETS;

  // MBDB-derived genre hierarchy (optional import). When unavailable, the genre
  // facet falls back to the flat list. Session-cached, so calling it here is cheap.
  const genreTaxonomy = useGenreTaxonomy();

  const {
    handleFacetToggle,
    handleSortChange: _handleSortChange,
    handleToggleSortDirection,
    handleRemoveChip,
    handleClearAll,
    totalActiveChips,
    hasFilters,
    queryActive,
    activeChips,
  } = useFilterActions(filterState, onFilterChange);

  const handleSortChange = (sort: SortOption) => {
    _handleSortChange(sort);
    setSortOpen(false);
  };

  const showTip = (key: string, label: string, sub: string | undefined, el: HTMLElement | null) => {
    if (!el) return;
    if (openFacet || sortOpen) return; // suppress tooltip when a popover is open
    setTooltip({ key, label, sub, rect: el.getBoundingClientRect() });
  };
  const hideTip = (key: string) => {
    setTooltip(t => (t && t.key === key ? null : t));
  };

  if (isMobile) {
    const isActive = totalActiveChips > 0 || queryActive;
    return (
      <div className="filter-zone filter-zone--mobile">
        <button
          onClick={onOpenQueryBuilder}
          className={`filter-icon-btn ${isActive ? 'filter-icon-btn--active' : ''} min-h-[44px] min-w-[44px]`}
          style={{ width: 44, height: 44, borderRadius: 14 }}
          aria-label={isActive ? `Filters (${totalActiveChips} active)` : 'Filters'}
        >
          <SlidersHorizontal size={18} strokeWidth={1.75} />
        </button>
      </div>
    );
  }

  const currentSort = SORT_OPTIONS.find(o => o.value === filterState.sort);

  return (
    <div className="filter-zone">
      <div className="filter-rack" role="toolbar" aria-label={`Filter ${view}`}>
        {facets.map((facet, idx) => {
          const values = facetValues[idx] || [];
          const selected = filterState.facets[facet.key] || [];
          const isActive = selected.length > 0;
          const isOpen = openFacet === facet.key;

          return (
            <div key={facet.key} className="relative">
              <button
                ref={el => { facetRefs.current[facet.key] = el; }}
                onClick={() => { setOpenFacet(isOpen ? null : facet.key); setTooltip(null); }}
                onMouseEnter={e => showTip(facet.key, facet.label, isActive ? `${selected.length} selected` : undefined, e.currentTarget)}
                onMouseLeave={() => hideTip(facet.key)}
                onFocus={e => showTip(facet.key, facet.label, isActive ? `${selected.length} selected` : undefined, e.currentTarget)}
                onBlur={() => hideTip(facet.key)}
                className={`filter-icon-btn ${isActive ? 'filter-icon-btn--active' : ''}`}
                aria-expanded={isOpen}
                aria-haspopup="listbox"
                aria-label={`${facet.label}${isActive ? `, ${selected.length} selected` : ''}`}
              >
                <facet.icon size={16} strokeWidth={1.75} />
                <span className="filter-icon-btn__label">{facet.label}</span>
                {isActive && (
                  <span key={selected.length} className="filter-icon-btn__pulse" aria-hidden />
                )}
              </button>
              <ContextMenuPortal
                open={isOpen}
                onClose={() => setOpenFacet(null)}
                anchorRef={{ current: facetRefs.current[facet.key] || null }}
                desktopWidth={288}
                desktopHeight={360}
                menuAlign="left"
              >
                {({ isMobile }) => (
                  facet.key === 'genre' && genreTaxonomy.available ? (
                    <GenreFacetMenu
                      isMobile={isMobile}
                      facetLabel={facet.label}
                      values={values}
                      selected={selected}
                      paths={genreTaxonomy.paths}
                      onToggle={(v) => handleFacetToggle(facet.key, v)}
                    />
                  ) : (
                    <FacetMenuContent
                      isMobile={isMobile}
                      facetLabel={facet.label}
                      values={values}
                      selected={selected}
                      onToggle={(v) => handleFacetToggle(facet.key, v)}
                    />
                  )
                )}
              </ContextMenuPortal>
            </div>
          );
        })}

        <div className="filter-rack__breath" aria-hidden />

        <button
          onClick={handleToggleSortDirection}
          onMouseEnter={e => showTip('direction', filterState.sortDirection === 'asc' ? 'ascending' : 'descending', undefined, e.currentTarget)}
          onMouseLeave={() => hideTip('direction')}
          onFocus={e => showTip('direction', filterState.sortDirection === 'asc' ? 'ascending' : 'descending', undefined, e.currentTarget)}
          onBlur={() => hideTip('direction')}
          className="filter-icon-btn"
          aria-label={`Sort direction: ${filterState.sortDirection === 'asc' ? 'ascending' : 'descending'}, click to flip`}
        >
          <span
            className={`filter-direction-arrow ${filterState.sortDirection === 'desc' ? 'filter-direction-arrow--desc' : ''}`}
          >
            <ArrowUp size={15} strokeWidth={1.75} />
          </span>
          <span className="filter-icon-btn__label">
            {filterState.sortDirection === 'asc' ? 'asc' : 'desc'}
          </span>
        </button>

        <div className="relative">
          <button
            ref={sortRef}
            onClick={() => { setSortOpen(!sortOpen); setTooltip(null); }}
            onMouseEnter={e => showTip('sort', 'Sort by', currentSort?.label, e.currentTarget)}
            onMouseLeave={() => hideTip('sort')}
            onFocus={e => showTip('sort', 'Sort by', currentSort?.label, e.currentTarget)}
            onBlur={() => hideTip('sort')}
            className="filter-sort-btn"
            aria-expanded={sortOpen}
            aria-haspopup="listbox"
            aria-label={`Sort by ${currentSort?.label}`}
          >
            <ArrowDownAZ size={15} strokeWidth={1.75} />
            <span key={currentSort?.value} className="filter-sort-value">{currentSort?.label.toLowerCase()}</span>
            <ChevronDown
              size={11}
              strokeWidth={2}
              style={{ opacity: 0.6, transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)', transform: sortOpen ? 'rotate(180deg)' : 'none' }}
            />
          </button>
          <ContextMenuPortal
            open={sortOpen}
            onClose={() => setSortOpen(false)}
            anchorRef={sortRef}
            desktopWidth={200}
            desktopHeight={200}
            menuAlign="right"
          >
            {({ isMobile }) => (
              <SortMenuContent
                isMobile={isMobile}
                selected={filterState.sort}
                onSelect={handleSortChange}
              />
            )}
          </ContextMenuPortal>
        </div>

        <button
          onClick={onOpenQueryBuilder}
          onMouseEnter={e => showTip('query', 'Advanced query', queryActive ? 'active' : undefined, e.currentTarget)}
          onMouseLeave={() => hideTip('query')}
          onFocus={e => showTip('query', 'Advanced query', queryActive ? 'active' : undefined, e.currentTarget)}
          onBlur={() => hideTip('query')}
          className={`filter-icon-btn ${queryActive ? 'filter-icon-btn--active' : ''}`}
          aria-label={queryActive ? 'Edit advanced query' : 'Build advanced query'}
          aria-pressed={queryActive}
        >
          <SlidersHorizontal size={16} strokeWidth={1.75} />
          <span className="filter-icon-btn__label">Query</span>
        </button>
      </div>

      {(activeChips.length > 0 || hasFilters) && (
        <div className="filter-strip" role="region" aria-label="Active filters">
          {activeChips.length > 0 && (
            <span className="filter-strip__lede">listening with</span>
          )}
          {activeChips.map(({ facetKey, value }, i) => (
            <span
              key={`${facetKey}-${value}`}
              className="filter-strip__item"
              style={{ ['--stagger' as any]: i }}
            >
              <span>{value}</span>
              <button
                onClick={() => handleRemoveChip(facetKey, value)}
                className="filter-strip__remove"
                aria-label={`Remove ${value} filter`}
                type="button"
              >
                <X size={11} strokeWidth={2.25} />
              </button>
            </span>
          ))}
          {hasFilters && (
            <button
              onClick={handleClearAll}
              className="filter-strip__clear"
              type="button"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {tooltip && <FilterTip key={tooltip.key} label={tooltip.label} sub={tooltip.sub} rect={tooltip.rect} />}
    </div>
  );
};

const FilterTip: React.FC<{ label: string; sub?: string; rect: DOMRect }> = ({ label, sub, rect }) => {
  const [pos, setPos] = useState<{ top: number; left: number; w: number }>({ top: 0, left: 0, w: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const tipW = ref.current.offsetWidth;
    const top = rect.bottom + 8;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tipW / 2, window.innerWidth - tipW - 8));
    setPos({ top, left, w: tipW });
  }, [rect]);

  return createPortal(
    <div ref={ref} className="filter-tip" style={{ top: pos.top, left: pos.left }} role="tooltip">
      <span>{label}</span>
      {sub && <span className="filter-tip__sub">{sub}</span>}
    </div>,
    document.body
  );
};

// Facet dropdown body, rendered inside ContextMenuPortal (desktop popover /
// mobile bottom-sheet). Multi-select with counts, a find box for long lists,
// and a clear-all footer.
// A single selectable facet value row. `indent` steps it right one level per
// taxonomy depth in the hierarchical genre view.
const FacetOptionRow: React.FC<{
  value: string;
  count: number;
  selected: boolean;
  onToggle: (value: string) => void;
  indent?: number;
}> = ({ value, count, selected, onToggle, indent = 0 }) => (
  <button
    role="option"
    aria-selected={selected}
    onClick={() => onToggle(value)}
    className={`w-full flex items-center gap-3 pr-4 py-2.5 text-sm text-left transition-colors hover:bg-white/5 active:bg-white/10 ${
      selected ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]'
    }`}
    style={{ paddingLeft: 16 + indent * 16 }}
  >
    <span
      className={`w-4 h-4 rounded-md border flex items-center justify-center flex-shrink-0 transition-colors ${
        selected
          ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white'
          : 'border-[var(--glass-border)]'
      }`}
    >
      {selected && <Check size={10} strokeWidth={3} />}
    </span>
    <span className="truncate flex-1" style={{ fontStyle: selected ? 'italic' : 'normal' }}>
      {value}
    </span>
    <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums" style={{ opacity: 0.7 }}>
      {count}
    </span>
  </button>
);

const FacetMenuContent: React.FC<{
  isMobile: boolean;
  facetLabel: string;
  values: { value: string; count: number }[];
  selected: string[];
  onToggle: (value: string) => void;
}> = ({ isMobile, facetLabel, values, selected, onToggle }) => {
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isMobile) searchRef.current?.focus();
  }, [isMobile]);

  const filtered = search
    ? values.filter(v => v.value.toLowerCase().includes(search.toLowerCase()))
    : values;

  return (
    <ContextMenuFrame isMobile={isMobile} widthClassName="w-72">
      <ContextMenuHeader
        title={facetLabel}
        subtitle={selected.length > 0 ? `${selected.length} selected` : undefined}
      />
      {values.length > 5 && (
        <div className="px-2 pt-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Find in ${facetLabel.toLowerCase()}`}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
              style={{ fontStyle: search ? 'normal' : 'italic' }}
            />
          </div>
        </div>
      )}
      <ContextMenuList className="overflow-y-auto max-h-[min(50vh,288px)]">
        {filtered.length === 0 && (
          <div className="px-4 py-5 text-center text-sm italic text-[var(--color-text-muted)]">nothing here</div>
        )}
        {filtered.map(v => (
          <FacetOptionRow
            key={v.value}
            value={v.value}
            count={v.count}
            selected={selected.includes(v.value)}
            onToggle={onToggle}
          />
        ))}
      </ContextMenuList>
      {selected.length > 0 && (
        <div className="px-2 py-1.5 border-t border-[var(--glass-border)]">
          <button
            onClick={() => { selected.forEach(s => onToggle(s)); }}
            className="w-full py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)] transition-colors hover:text-[var(--aurora-pink)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Clear {selected.length}
          </button>
        </div>
      )}
    </ContextMenuFrame>
  );
};

// Sort dropdown body, rendered inside ContextMenuPortal.
const SortMenuContent: React.FC<{
  isMobile: boolean;
  selected: SortOption;
  onSelect: (s: SortOption) => void;
}> = ({ isMobile, selected, onSelect }) => (
  <ContextMenuFrame isMobile={isMobile} widthClassName="w-48">
    <ContextMenuHeader title="Sort by" />
    <ContextMenuList>
      {SORT_OPTIONS.map(opt => (
        <button
          key={opt.value}
          role="option"
          aria-selected={opt.value === selected}
          onClick={() => onSelect(opt.value)}
          className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center justify-between hover:bg-white/5 active:bg-white/10 ${
            opt.value === selected ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]'
          }`}
        >
          <span style={{ fontFamily: 'var(--font-display)', fontStyle: opt.value === selected ? 'italic' : 'normal' }}>
            {opt.label.toLowerCase()}
          </span>
          {opt.value === selected && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--color-primary)',
                boxShadow: '0 0 8px rgba(34, 201, 131, 0.6)',
              }}
            />
          )}
        </button>
      ))}
    </ContextMenuList>
  </ContextMenuFrame>
);
