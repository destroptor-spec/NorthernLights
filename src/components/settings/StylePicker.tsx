import React, { useId, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { targetKey, targetLabel, type GenreTarget } from '../../../shared/genreReview';

export interface GenreTaxonomy {
  genres: string[];
  styles: Array<{ id: number; genre: string; name: string }>;
}

// What the list shows: a genre alone, or "Disco · Electronic" (16 style names
// exist under two genres, so every style names its genre).
const optionText = (target: GenreTarget) => target.style ? `${target.style} · ${target.genre}` : target.genre;

/**
 * Picks one or more of Aurora's genres and styles. Type to filter the list
 * (the same input + datalist as Manual merge); an exact pick becomes a chip.
 */
export const StylePicker: React.FC<{
  taxonomy: GenreTaxonomy | null;
  value: GenreTarget[];
  onChange: (targets: GenreTarget[]) => void;
  onFocus?: () => void;
  disabled?: boolean;
  label: string;
}> = ({ taxonomy, value, onChange, onFocus, disabled, label }) => {
  const listId = useId();
  const [text, setText] = useState('');

  const options = useMemo(() => {
    if (!taxonomy) return [];
    const targets: GenreTarget[] = [
      ...taxonomy.genres.map(genre => ({ genre, styleId: null, style: null })),
      ...taxonomy.styles.map(s => ({ genre: s.genre, styleId: s.id, style: s.name })),
    ];
    return targets.map(target => ({ target, text: optionText(target) }));
  }, [taxonomy]);
  const byText = useMemo(() => new Map(options.map(o => [o.text.toLowerCase(), o.target])), [options]);

  const add = (raw: string) => {
    const target = byText.get(raw.trim().toLowerCase());
    if (!target) return false;
    if (!value.some(t => targetKey(t) === targetKey(target))) onChange([...value, target]);
    setText('');
    return true;
  };

  const invalid = text.trim() !== '' && !byText.has(text.trim().toLowerCase())
    && !options.some(o => o.text.toLowerCase().includes(text.trim().toLowerCase()));

  return (
    <div className="genre-picker" onClick={event => event.stopPropagation()}>
      {value.length > 0 && (
        <ul className="genre-picker__chips" aria-label="Chosen">
          {value.map(target => (
            <li key={targetKey(target)} className="entity-review-tag genre-picker__chip">
              {targetLabel(target)}
              <button
                type="button"
                className="genre-picker__remove"
                onClick={() => onChange(value.filter(t => targetKey(t) !== targetKey(target)))}
                disabled={disabled}
                aria-label={`Remove ${targetLabel(target)}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="entity-review-input"
        value={text}
        onChange={event => {
          // A pick from the list arrives as a replacement (no inputType in some
          // browsers); typed text waits for Enter, so "Pop" doesn't stop "Pop Rock".
          const inputType = (event.nativeEvent as InputEvent).inputType;
          const fromList = !inputType || inputType === 'insertReplacementText';
          if (!(fromList && add(event.target.value))) setText(event.target.value);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && text.trim()) {
            // Enter picks the only match, or an exact one.
            const q = text.trim().toLowerCase();
            const matches = options.filter(o => o.text.toLowerCase().includes(q));
            if (add(text) || (matches.length === 1 && add(matches[0].text))) event.preventDefault();
            event.stopPropagation();
          }
        }}
        onFocus={onFocus}
        list={listId}
        placeholder={taxonomy ? (value.length ? 'Add another…' : 'Search genres and styles…') : 'Loading genres…'}
        aria-label={label}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled || !taxonomy}
      />
      <datalist id={listId}>
        {options.map(o => <option key={o.text} value={o.text} />)}
      </datalist>
      {invalid && <span className="genre-picker__hint">No genre or style by that name</span>}
    </div>
  );
};
