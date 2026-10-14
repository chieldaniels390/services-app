import { useState } from 'react';
import { api } from '../api.js';

/** Heart toggle for saving a pro. `saved` and `onChange` come from the parent's favourites list. */
export default function FavouriteButton({ pro, saved, onChange, compact = false }) {
  const [busy, setBusy] = useState(false);
  async function toggle(e) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      onChange(await api(`/favourites/${pro.id}`, { method: saved ? 'DELETE' : 'PUT' }));
    } finally {
      setBusy(false);
    }
  }
  const first = pro.name.split(' ')[0];
  return (
    <button
      className={`btn fav ${saved ? 'on' : ''} ${compact ? 'compact' : ''}`}
      aria-pressed={saved}
      aria-label={saved ? `Remove ${first} from favourites` : `Save ${first} as a favourite`}
      disabled={busy}
      onClick={toggle}
    >
      {saved ? '♥' : '♡'}{!compact && (saved ? ' Saved' : ' Save pro')}
    </button>
  );
}
