import { useEffect, useState } from 'react';
import { apiBlob } from '../api.js';

/** Shows a verification document fetched with the user's token: images inline, PDFs as a button. */
export default function DocumentPreview({ doc, label, large = false }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  const isPdf = doc.mime === 'application/pdf';

  useEffect(() => {
    if (isPdf) return undefined;
    let objectUrl;
    let cancelled = false;
    apiBlob(`/documents/${doc.id}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, isPdf]);

  async function openPdf() {
    try {
      const blob = await apiBlob(`/documents/${doc.id}`);
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className={`doc-preview ${large ? 'large' : ''}`}>
      {isPdf ? (
        <button type="button" className="doc-pdf" onClick={openPdf}>📄<span>Open PDF</span></button>
      ) : url ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open full size"><img src={url} alt={label} /></a>
      ) : (
        <div className="doc-loading">{error || 'Loading…'}</div>
      )}
    </div>
  );
}
