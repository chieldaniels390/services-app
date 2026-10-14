import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { ago } from './format.js';
import { useSession, useSocketEvent } from './session.jsx';

const NotificationsContext = createContext(null);
const TOAST_MS = 6000;

/** In-app notifications: the bell's list and unread count, plus toasts for anything new. */
export function NotificationsProvider({ children }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState({ items: [], unread: 0 });
  const [toasts, setToasts] = useState([]);

  const load = useCallback(() => api('/notifications').then(setState).catch(() => {}), []);
  useEffect(() => {
    if (user) load();
    else setState({ items: [], unread: 0 });
  }, [user, load]);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useSocketEvent('notification:new', (n) => {
    setState((s) => ({ items: [n, ...s.items].slice(0, 50), unread: s.unread + 1 }));
    // No toast for the page you're already looking at; it updates itself.
    if (n.url === location.pathname) return;
    setToasts((t) => [...t.slice(-2), n]);
    setTimeout(() => dismiss(n.id), TOAST_MS);
  });

  const markRead = useCallback(async (ids) => {
    setState(await api('/notifications/read', { method: 'POST', body: ids === 'all' ? { all: true } : { ids } }));
  }, []);

  const open = useCallback((n) => {
    dismiss(n.id);
    if (!n.read) markRead([n.id]).catch(() => {});
    navigate(n.url);
  }, [dismiss, markRead, navigate]);

  return (
    <NotificationsContext.Provider value={{ ...state, markRead, open, clearToasts: () => setToasts([]) }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <button key={t.id} className="toast" onClick={() => open(t)}>
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
            <span className="muted small">{ago(t.createdAt)}</span>
          </button>
        ))}
      </div>
    </NotificationsContext.Provider>
  );
}

export const useNotifications = () => useContext(NotificationsContext);
