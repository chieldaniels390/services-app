import { Suspense, lazy } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { useSession, useSocketEvent } from './session.jsx';
import Landing from './pages/Landing.jsx';
import AuthPage from './pages/AuthPage.jsx';
import CustomerHome from './pages/CustomerHome.jsx';
import ProviderHome from './pages/ProviderHome.jsx';
import JobPage from './pages/JobPage.jsx';
import History from './pages/History.jsx';
import Payouts from './pages/Payouts.jsx';
import Earnings from './pages/Earnings.jsx';
import WorkSettings from './pages/WorkSettings.jsx';
import Verification from './pages/Verification.jsx';
import Settings from './pages/Settings.jsx';
import Bell from './components/Bell.jsx';


export const APP_NAME = 'ProNow';

// Only admins need the admin panel, so it loads as a separate chunk.
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout.jsx'));

function Shell({ children }) {
  const { user, setUser, signOut, config } = useSession();
  // An admin decision changes what a pro can do, so refresh their profile wherever they are.
  useSocketEvent('verification:updated', () => api('/me').then(setUser).catch(() => {}));
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="logo">🔧</span> {APP_NAME}
          {user?.role === 'provider' && <span className="badge">Pro</span>}
          {user?.role === 'admin' && <span className="badge admin">Admin</span>}
          {config.payments.testMode && <span className="badge test" title="Paystack test mode: no real money moves">Test</span>}
        </Link>
        {user && user.role !== 'admin' && (
          <nav>
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/history">{user.role === 'provider' ? 'Jobs' : 'My bookings'}</NavLink>
            {user.role === 'provider' && <NavLink to="/earnings">Earnings</NavLink>}
            <Bell />
            <NavLink to="/settings" className="icon-link" aria-label="Settings" title="Settings">⚙️</NavLink>
          </nav>
        )}
        {user?.role === 'admin' && (
          <nav>
            <button className="link" onClick={signOut}>Sign out</button>
          </nav>
        )}
      </header>
      <main>{children}</main>
    </div>
  );
}

function RequireUser({ children }) {
  const { user } = useSession();
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const { user, ready, config } = useSession();
  if (!ready || !config) return <div className="splash"><span className="logo">🔧</span></div>;

  if (user?.role === 'admin') {
    return (
      <Shell>
        <Routes>
          <Route path="/admin/*" element={<Suspense fallback={<p className="muted">Loading…</p>}><AdminLayout /></Suspense>} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Shell>
    );
  }

  const home = !user ? <Landing /> : user.role === 'provider' ? <ProviderHome /> : <CustomerHome />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <AuthPage mode="login" />} />
        <Route path="/register" element={user ? <Navigate to="/" replace /> : <AuthPage mode="register" />} />
        <Route path="/jobs/:id" element={<RequireUser><JobPage /></RequireUser>} />
        <Route path="/history" element={<RequireUser><History /></RequireUser>} />
        <Route path="/payouts" element={user?.role === 'provider' ? <Payouts /> : <Navigate to="/" replace />} />
        <Route path="/earnings" element={user?.role === 'provider' ? <Earnings /> : <Navigate to="/" replace />} />
        <Route path="/work" element={user?.role === 'provider' ? <WorkSettings /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={<RequireUser><Settings /></RequireUser>} />
        <Route path="/verification" element={user?.role === 'provider' ? <Verification /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
