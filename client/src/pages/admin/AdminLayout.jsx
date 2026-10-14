import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../../api.js';
import { useSocketEvent } from '../../session.jsx';
import AdminDisputes from './AdminDisputes.jsx';
import AdminJob from './AdminJob.jsx';
import AdminJobs from './AdminJobs.jsx';
import AdminOverview from './AdminOverview.jsx';
import AdminPro from './AdminPro.jsx';
import AdminPros from './AdminPros.jsx';
import AdminSettings from './AdminSettings.jsx';
import AdminRatings from './AdminRatings.jsx';
import AdminSafety from './AdminSafety.jsx';

export default function AdminLayout() {
  const [overview, setOverview] = useState(null);
  const refresh = useCallback(() => api('/admin/overview').then(setOverview).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);
  // New submissions and disputes arrive live, so the queue counts stay current.
  useSocketEvent('admin:updated', refresh);
  useSocketEvent('admin:emergency', refresh);

  const count = (n) => (n ? <span className="count">{n}</span> : null);
  return (
    <div className="admin">
      {overview?.openEmergencies > 0 && (
        <Link to="/admin/safety" className="emergency-banner" role="alert">
          🆘 {overview.openEmergencies} emergency {overview.openEmergencies > 1 ? 'alerts need' : 'alert needs'} attention <span>View ›</span>
        </Link>
      )}
      <nav className="admin-tabs">
        <NavLink to="/admin" end>Overview</NavLink>
        <NavLink to="/admin/pros">Pros {count(overview?.pendingVerifications)}</NavLink>
        <NavLink to="/admin/jobs">Jobs</NavLink>
        <NavLink to="/admin/disputes">Disputes {count(overview?.openDisputes)}</NavLink>
        <NavLink to="/admin/safety">Safety {count(overview?.openEmergencies)}</NavLink>
        <NavLink to="/admin/ratings">Low ratings {count(overview?.lowRatedUsers)}</NavLink>
        <NavLink to="/admin/settings">Settings</NavLink>
      </nav>
      <Routes>
        <Route index element={<AdminOverview overview={overview} />} />
        <Route path="pros" element={<AdminPros onChange={refresh} />} />
        <Route path="pros/:id" element={<AdminPro onChange={refresh} />} />
        <Route path="jobs" element={<AdminJobs />} />
        <Route path="jobs/:id" element={<AdminJob onChange={refresh} />} />
        <Route path="disputes" element={<AdminDisputes />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="ratings" element={<AdminRatings />} />
        <Route path="safety" element={<AdminSafety onChange={refresh} />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
}
