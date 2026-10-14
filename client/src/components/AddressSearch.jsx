import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Address input with type-ahead suggestions. Only searches for text the user typed,
 * so filling the field from a map tap or a chosen suggestion doesn't trigger a new search.
 */
export default function AddressSearch({ value, onChange, onSelect, children }) {
  const listId = useId();
  const typed = useRef('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = value.trim();
    if (value !== typed.current || q.length < 3) {
      setResults([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const found = await api(`/geocode/search?q=${encodeURIComponent(q)}`);
        if (cancelled) return;
        setResults(found);
        setActive(found.length ? 0 : -1);
        setOpen(true);
        setError('');
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  function choose(result) {
    typed.current = '';
    setOpen(false);
    setResults([]);
    onSelect(result);
  }

  function onKeyDown(e) {
    if (!open || !results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + results.length) % results.length);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const showList = open && value === typed.current && value.trim().length >= 3 && !loading;

  return (
    <div className="address-search">
      <div className="row">
        <div className="grow address-input">
          <input
            required
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Search for your street address…"
            value={value}
            onChange={(e) => {
              typed.current = e.target.value;
              onChange(e.target.value);
            }}
            onFocus={() => results.length && setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {loading && <span className="spinner" aria-label="Searching" />}
        </div>
        {children}
      </div>
      {showList && (
        <ul id={listId} role="listbox" className="suggestions">
          {results.length === 0 && <li className="empty">No matching addresses – try adding the suburb, or tap the map.</li>}
          {results.map((r, i) => (
            <li
              key={`${r.lat},${r.lng},${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              // mousedown fires before the input's blur, so the choice registers before the list closes.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              📍 {r.label}
            </li>
          ))}
        </ul>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
