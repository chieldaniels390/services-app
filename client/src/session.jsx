import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, storeToken } from './api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [token, setToken] = useState(getToken);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());
  const [config, setConfig] = useState(null);
  const [categories, setCategories] = useState([]);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    Promise.all([api('/config'), api('/categories')])
      .then(([cfg, cats]) => {
        setConfig(cfg);
        setCategories(cats);
      })
      .catch(console.error);
  }, []);

  const signOut = useCallback(() => {
    storeToken(null);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    if (!token) return;
    api('/me')
      .then(setUser)
      .catch((err) => err.status === 401 && signOut())
      .finally(() => setReady(true));
  }, [token, signOut]);

  useEffect(() => {
    if (!token) return undefined;
    const s = io({ auth: { token } });
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
    };
  }, [token]);

  const signIn = useCallback(({ token: newToken, user: newUser }) => {
    storeToken(newToken);
    setUser(newUser);
    setToken(newToken);
  }, []);

  const value = { token, user, setUser, ready, config, categories, socket, signIn, signOut };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

/** Subscribes to a socket event for the lifetime of the component, always calling the latest handler. */
export function useSocketEvent(event, handler) {
  const { socket } = useSession();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!socket) return undefined;
    const listener = (payload) => ref.current(payload);
    socket.on(event, listener);
    return () => socket.off(event, listener);
  }, [socket, event]);
}
