import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './session.jsx';
import Landing from './pages/Landing.jsx';
import AuthPage from './pages/AuthPage.jsx';
import CustomerHome from './pages/CustomerHome.jsx';
import ProviderHome from './pages/ProviderHome.jsx';
import JobPage from './pages/JobPage.jsx';
import History from './pages/History.jsx';
import Payouts from './pages/Payouts.jsx';

export const APP_NAME = 'ProNow';

function Shell({ children }) {
  const { user, signOut, config } = useSession();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="logo">🔧</span> {APP_NAME}
          {user?.role === 'provider' && <span className="badge">Pro</span>}
          {config.payments.testMode && <span className="badge test" title="Paystack test mode: no real money moves">Test</span>}
        </Link>
        {user && (
          <nav>
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/history">{user.role === 'provider' ? 'Jobs' : 'My bookings'}</NavLink>
            {user.role === 'provider' && <NavLink to="/payouts">Payouts</NavLink>}
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
