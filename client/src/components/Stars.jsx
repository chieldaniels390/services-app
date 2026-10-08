export function Stars({ value, count }) {
  if (value == null) return <span className="muted small">New pro</span>;
  return (
    <span className="stars small">
      ★ {value.toFixed(1)}
      {count != null && <span className="muted"> ({count})</span>}
    </span>
  );
}

export function StarInput({ value, onChange }) {
  return (
    <div className="star-input" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={n <= value ? 'on' : ''}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}
