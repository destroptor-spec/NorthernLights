import React, { useCallback, useId } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X } from 'lucide-react';
import {
  METADATA_ITEMS,
  METADATA_PROVIDER_NAMES,
  type MetadataItemInfo,
  type MetadataProvider,
  type MetadataProviderPriority,
} from '../../../shared/metadataProviders';

interface Props {
  priority: MetadataProviderPriority;
  /** Providers that are set up (a key, or MusicBrainz switched on). */
  connected: Record<MetadataProvider, boolean>;
  onChange: (priority: MetadataProviderPriority) => void;
}

/**
 * Settings → Metadata → Overview: for each item, the providers Aurora asks, in
 * order. Drag to reorder, × to stop asking one, "Add provider" for a set-up
 * provider the list lacks. The server keeps the first one that has it.
 */
export const ProviderOrderEditor: React.FC<Props> = ({ priority, connected, onChange }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
    {METADATA_ITEMS.map((item) => (
      <ProviderList
        key={item.id}
        item={item}
        providers={priority[item.id]}
        connected={connected}
        onChange={(providers) => onChange({ ...priority, [item.id]: providers })}
      />
    ))}
  </div>
);

const ProviderList: React.FC<{
  item: MetadataItemInfo;
  providers: MetadataProvider[];
  connected: Record<MetadataProvider, boolean>;
  onChange: (providers: MetadataProvider[]) => void;
}> = ({ item, providers, connected, onChange }) => {
  const headingId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = providers.indexOf(active.id as MetadataProvider);
    const to = providers.indexOf(over.id as MetadataProvider);
    if (from !== -1 && to !== -1) onChange(arrayMove(providers, from, to));
  }, [providers, onChange]);

  const addable = item.providers.filter((p) => connected[p] && !providers.includes(p));
  const notSetUp = item.providers.filter((p) => !connected[p] && !providers.includes(p));

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-[var(--glass-border)] p-4 flex flex-col gap-3"
    >
      <div>
        <h5 id={headingId} className="text-sm font-semibold text-[var(--color-text-primary)]">{item.label}</h5>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{item.description}</p>
      </div>

      {providers.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={providers} strategy={verticalListSortingStrategy}>
            <ol className="list-none p-0 m-0 flex flex-col gap-1.5" aria-label={`${item.label}: providers in order`}>
              {providers.map((provider, index) => (
                <ProviderRow
                  key={provider}
                  provider={provider}
                  rank={index + 1}
                  connected={connected[provider]}
                  onRemove={() => onChange(providers.filter((p) => p !== provider))}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">Not looked up.</p>
      )}

      {addable.length > 0 && (
        <select
          aria-label={`Add a provider for ${item.label.toLowerCase()}`}
          value=""
          onChange={(e) => {
            const provider = e.target.value as MetadataProvider;
            if (provider) onChange([...providers, provider]);
          }}
          className="w-full p-2 rounded-lg border border-dashed border-[var(--glass-border)] bg-background text-[var(--color-text-secondary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors"
        >
          <option value="">Add provider…</option>
          {addable.map((p) => <option key={p} value={p}>{METADATA_PROVIDER_NAMES[p]}</option>)}
        </select>
      )}
      {notSetUp.length > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Set up {notSetUp.map((p) => METADATA_PROVIDER_NAMES[p]).join(' or ')} to add {notSetUp.length > 1 ? 'them' : 'it'} here.
        </p>
      )}
    </section>
  );
};

const ProviderRow: React.FC<{
  provider: MetadataProvider;
  rank: number;
  connected: boolean;
  onRemove: () => void;
}> = ({ provider, rank, connected, onRemove }) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: provider });
  const name = METADATA_PROVIDER_NAMES[provider];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={`flex items-center gap-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] pl-1 pr-1 py-1 ${isDragging ? 'shadow-lg' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${name}`}
        className="btn-icon touch-none cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <span className="w-5 text-xs tabular-nums text-[var(--color-text-muted)]" aria-hidden="true">{rank}</span>
      <span className={`flex-1 min-w-0 text-sm leading-tight ${connected ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>
        {name}
        {!connected && <span className="block text-xs">Not set up, skipped</span>}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Stop asking ${name}`}
        title={`Stop asking ${name}`}
        className="btn-icon"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
};
