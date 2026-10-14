import { useEffect, useRef, useState } from 'react';
import { ago } from '../format.js';
import { useNotifications } from '../notifications.jsx';

export default function Bell() {
  const { items, unread, markRead, open, clearToasts } = useNotifications();
  const [show, setShow] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!show) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setShow(false);
    const esc = (e) => e.key === 'Escape' && setShow(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [show]);

  return (
    <div className="bell" ref={ref}>
      <button
        className="bell-button"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={show}
        onClick={() => {
          clearToasts(); // the panel shows the same things
          setShow((v) => !v);
        }}
      >
        🔔{unread > 0 && <span className="count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {show && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link" onClick={() => markRead('all')}>Mark all as read</button>}
          </div>
          {items.length === 0 && <p className="muted small bell-empty">Nothing yet. Updates about your jobs will show up here.</p>}
          <ul>
            {items.map((n) => (
              <li key={n.id}>
                <button className={n.read ? '' : 'unread'} onClick={() => { setShow(false); open(n); }}>
                  <strong>{n.title}</strong>
                  {n.body && <span>{n.body}</span>}
                  <span className="muted small">{ago(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
