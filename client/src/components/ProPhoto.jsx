import { useEffect, useState } from 'react';
import { apiBlob } from '../api.js';

/** A pro's profile photo (fetched with the user's token), falling back to their initial. */
export default function ProPhoto({ userId, hasPhoto, name, src, size = 44 }) {
  const [url, setUrl] = useState(src ?? null);
  useEffect(() => {
    if (src || !hasPhoto || !userId) return undefined;
    let objectUrl;
    let cancelled = false;
    apiBlob(`/users/${userId}/photo`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [userId, hasPhoto, src]);

  const style = { width: size, height: size, fontSize: size * 0.42 };
  return url
    ? <img className="avatar photo" src={url} alt={name} style={style} />
    : <div className="avatar" style={style} aria-hidden="true">{name?.[0]}</div>;
}

// The plate never breaks across lines (non-breaking spaces and hyphens), so it can be read at a glance.
const unbreakable = (plate) => plate && plate.replace(/ /g, '\u00a0').replace(/-/g, '\u2011');
export const vehicleText = (v) => (v ? [[v.colour, v.make, v.model].filter(Boolean).join(' '), unbreakable(v.plate)].filter(Boolean).join(' · ') : '');
