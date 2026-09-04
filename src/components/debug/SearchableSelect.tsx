import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import './DebugPanel.css';

export interface SearchableSelectOption {
  id: string;
  name: string;
}

export interface SearchableSelectProps {
  /** Selected option id, or '' for "None". */
  value: string;
  /** undefined means "still loading" - renders disabled with a loading placeholder. */
  options: SearchableSelectOption[] | undefined;
  onChange: (id: string) => void;
}

/** Cap how many matches actually render - a slot like gauntlet has ~2,500 eligible items, and rendering all of them into the list on every keystroke is wasted work once a search has already narrowed things down. */
const MAX_VISIBLE_RESULTS = 50;

/**
 * A single-slot searchable dropdown: an ordinary text input that, while
 * focused, shows a filtered list of matching item names below it - typing
 * narrows the list in place, click (or Enter) picks one. Replaces a plain
 * `<select>` specifically because native selects have no in-place search,
 * which is unusable once a slot has hundreds/thousands of options.
 */
export default function SearchableSelect({ value, options, onChange }: SearchableSelectProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options?.find((o) => o.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    if (!options) return [];
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const visible = filtered.slice(0, MAX_VISIBLE_RESULTS);
  const hiddenCount = filtered.length - visible.length;

  const pick = (id: string) => {
    onChange(id);
    setQuery('');
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQuery('');
      setOpen(false);
      return;
    }
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((h) => Math.min(h + 1, visible.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visible[highlighted];
      if (option) pick(option.id);
    }
  };

  return (
    <div className="debug-panel-searchable-select" ref={rootRef}>
      <input
        type="text"
        value={open ? query : (selected?.name ?? '')}
        placeholder={options ? 'None' : 'Loading…'}
        disabled={!options}
        onFocus={() => {
          setQuery('');
          setHighlighted(0);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlighted(0);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && options && (
        <ul className="debug-panel-searchable-select-list">
          <li
            className={value === '' ? 'active' : ''}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick('')}
          >
            None
          </li>
          {visible.map((option, i) => (
            <li
              key={option.id}
              className={[option.id === value ? 'active' : '', i === highlighted ? 'highlighted' : ''].filter(Boolean).join(' ')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => pick(option.id)}
            >
              {option.name}
            </li>
          ))}
          {hiddenCount > 0 && <li className="debug-panel-searchable-select-more">+{hiddenCount} more - refine search</li>}
          {filtered.length === 0 && <li className="debug-panel-searchable-select-more">No matches</li>}
        </ul>
      )}
    </div>
  );
}
