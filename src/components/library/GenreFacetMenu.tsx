import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, Minus, ArrowRight, ChevronLeft, X } from 'lucide-react';
import { ContextMenuFrame } from '../ContextMenu';

// ─── Genre taxonomy tree ──────────────────────────────────────────────────────
// Built from the flat facet values + the MBDB dot-path taxonomy. Each node is a
// path segment; a node is *selectable* when it maps to a real library genre
// value, and may have children regardless. Mirrors the genres view: root =
// first segment, depth = segment count.

interface GenreNode {
  key: string;        // lowercased full path, unique
  name: string;       // segment label (lowercased, from the path)
  value?: string;     // real facet value (original casing) when selectable
  count?: number;
  children: GenreNode[];
}

const displayName = (n: GenreNode) => n.value ?? n.name;

function buildTree(
  values: { value: string; count: number }[],
  paths: Record<string, string>,
): { roots: GenreNode[]; loose: GenreNode[] } {
  const index = new Map<string, GenreNode>();
  const rootMap = new Map<string, GenreNode>();
  const loose: GenreNode[] = [];

  const ensurePath = (segments: string[]): GenreNode => {
    let parent: GenreNode | null = null;
    let keyAcc = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      keyAcc = i === 0 ? seg : `${keyAcc}.${seg}`;
      let node = index.get(keyAcc);
      if (!node) {
        node = { key: keyAcc, name: seg, children: [] };
        index.set(keyAcc, node);
        if (parent) parent.children.push(node);
        else rootMap.set(keyAcc, node);
      }
      parent = node;
    }
    return parent as GenreNode;
  };

  for (const v of values) {
    const path = paths[v.value.toLowerCase()];
    if (!path) {
      loose.push({ key: `__loose__${v.value.toLowerCase()}`, name: v.value, value: v.value, count: v.count, children: [] });
      continue;
    }
    const leaf = ensurePath(path.split('.'));
    leaf.value = v.value;
    leaf.count = v.count;
  }

  const sortRec = (nodes: GenreNode[]) => {
    nodes.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    nodes.forEach(n => sortRec(n.children));
  };
  const roots = [...rootMap.values()];
  sortRec(roots);
  loose.sort((a, b) => a.name.localeCompare(b.name));
  return { roots, loose };
}

// ─── Row ──────────────────────────────────────────────────────────────────────
// Split tap targets: the left zone (checkbox + label) toggles selection; the
// right zone (chevron, divided by a border) drills into sub-genres. Non-
// selectable navigation nodes have no checkbox and drill from anywhere.

const SelectBox: React.FC<{ state: 'on' | 'partial' | 'off' }> = ({ state }) => (
  <span
    className={`w-4 h-4 rounded-md border flex items-center justify-center flex-shrink-0 transition-colors ${
      state === 'on'
        ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white'
        : state === 'partial'
          ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
          : 'border-[var(--glass-border)]'
    }`}
  >
    {state === 'on' && <Check size={10} strokeWidth={3} />}
    {state === 'partial' && <Minus size={10} strokeWidth={3} />}
  </span>
);

const GenreRow: React.FC<{
  node: GenreNode;
  state: 'on' | 'partial' | 'off';
  onToggle: (value: string) => void;
  onDrill: (node: GenreNode) => void;
}> = ({ node, state, onToggle, onDrill }) => {
  const hasChildren = node.children.length > 0;
  const selectable = !!node.value;

  return (
    <div className="flex items-stretch">
      <button
        onClick={() => (selectable ? onToggle(node.value!) : onDrill(node))}
        aria-pressed={selectable ? state === 'on' : undefined}
        className={`flex items-center gap-3 flex-1 min-w-0 pl-4 pr-2 py-2.5 text-sm text-left transition-colors hover:bg-white/5 active:bg-white/10 ${
          state === 'on' ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]'
        }`}
      >
        {selectable
          ? <SelectBox state={state} />
          : <span className="w-4 h-4 flex-shrink-0" aria-hidden />}
        <span className="truncate flex-1" style={{ fontStyle: state === 'on' ? 'italic' : 'normal' }}>
          {displayName(node)}
        </span>
        {selectable && node.count != null && (
          <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums" style={{ opacity: 0.7 }}>
            {node.count}
          </span>
        )}
      </button>
      {hasChildren && (
        <button
          onClick={() => onDrill(node)}
          aria-label={`Open ${displayName(node)} sub-genres`}
          className="my-1.5 mr-1.5 flex items-center px-2.5 rounded-lg bg-white/10 text-[var(--color-text-secondary)] transition-colors hover:bg-white/20 hover:text-[var(--color-text-primary)] active:bg-white/25"
        >
          <ArrowRight size={16} />
        </button>
      )}
    </div>
  );
};

// ─── Menu ───────────────────────────────────────────────────────────────────

export const GenreFacetMenu: React.FC<{
  isMobile: boolean;
  facetLabel: string;
  values: { value: string; count: number }[];
  selected: string[];
  paths: Record<string, string>;
  onToggle: (value: string) => void;
}> = ({ isMobile, facetLabel, values, selected, paths, onToggle }) => {
  const { roots, loose } = useMemo(() => buildTree(values, paths), [values, paths]);
  const rootLevel = useMemo(
    () => [...roots, ...loose].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [roots, loose],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const anyDescendantSelected = useMemo(() => {
    const fn = (n: GenreNode): boolean =>
      n.children.some(c => (c.value ? selectedSet.has(c.value) : false) || fn(c));
    return fn;
  }, [selectedSet]);

  const [stack, setStack] = useState<GenreNode[]>([]);
  const [dir, setDir] = useState<'forward' | 'back'>('forward');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const parent = stack[stack.length - 1] ?? null;
  const level = parent ? parent.children : rootLevel;
  const searching = !parent && search.trim() !== '';

  useEffect(() => {
    if (!isMobile && !parent) searchRef.current?.focus();
  }, [isMobile, parent]);

  const drill = (node: GenreNode) => {
    if (node.children.length === 0) return;
    setDir('forward');
    setStack(s => [...s, node]);
  };
  const back = () => {
    setDir('back');
    setStack(s => s.slice(0, -1));
  };

  const stateFor = (n: GenreNode): 'on' | 'partial' | 'off' => {
    if (n.value && selectedSet.has(n.value)) return 'on';
    return anyDescendantSelected(n) ? 'partial' : 'off';
  };

  const searchResults = searching
    ? values
        .filter(v => v.value.toLowerCase().includes(search.toLowerCase().trim()))
        .sort((a, b) => a.value.localeCompare(b.value))
    : [];

  return (
    <ContextMenuFrame isMobile={isMobile} widthClassName="w-72">
      {/* Header — back button + parent name when drilled in, else the facet label. */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--glass-border)] flex-shrink-0">
        {parent && (
          <button
            onClick={back}
            aria-label="Back"
            className="p-1 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors active:scale-90"
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <span className="text-sm font-semibold text-[var(--color-text-primary)] flex-1 truncate">
          {parent ? displayName(parent) : facetLabel}
        </span>
        {selected.length > 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">{selected.length} selected</span>
        )}
      </div>

      {/* Search — root level only; searching flattens to matches across the tree. */}
      {!parent && values.length > 5 && (
        <div className="px-2 pt-2 flex-shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Find in ${facetLabel.toLowerCase()}`}
              className="w-full pl-8 pr-8 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
              style={{ fontStyle: search ? 'normal' : 'italic' }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] active:scale-90"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="overflow-y-auto max-h-[min(50vh,288px)]">
        {searching ? (
          searchResults.length === 0 ? (
            <div className="px-4 py-5 text-center text-sm italic text-[var(--color-text-muted)]">nothing here</div>
          ) : (
            searchResults.map(v => (
              <GenreRow
                key={v.value}
                node={{ key: v.value, name: v.value, value: v.value, count: v.count, children: [] }}
                state={selectedSet.has(v.value) ? 'on' : 'off'}
                onToggle={onToggle}
                onDrill={drill}
              />
            ))
          )
        ) : (
          <div key={stack.map(n => n.key).join('>') || '__root__'} className="genre-level" data-dir={dir}>
            {level.map(node => (
              <GenreRow key={node.key} node={node} state={stateFor(node)} onToggle={onToggle} onDrill={drill} />
            ))}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="px-2 py-1.5 border-t border-[var(--glass-border)] flex-shrink-0">
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
