import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useSession } from '../session.jsx';

export default function AuthPage({ mode }) {
  const { signIn, categories } = useSession();
  const [params] = useSearchParams();
  const [role, setRole] = useState(params.get('role') === 'provider' ? 'provider' : 'customer');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', bio: '' });
  const [services, setServices] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  const toggleService = (id) => setServices((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = isRegister ? { ...form, role, categories: services } : { email: form.email, password: form.password };
      signIn(await api(isRegister ? '/auth/register' : '/auth/login', { method: 'POST', body }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2>

        {isRegister && (
          <div className="segmented">
            <button type="button" className={role === 'customer' ? 'on' : ''} onClick={() => setRole('customer')}>I need a pro</button>
            <button type="button" className={role === 'provider' ? 'on' : ''} onClick={() => setRole('provider')}>I'm a pro</button>
          </div>
        )}

        {isRegister && <label>Full name<input required autoComplete="name" {...field('name')} /></label>}
        <label>Email<input required type="email" autoComplete="email" {...field('email')} /></label>
        {isRegister && <label>Phone<input type="tel" autoComplete="tel" {...field('phone')} /></label>}
        <label>Password<input required type="password" minLength={isRegister ? 8 : undefined} autoComplete={isRegister ? 'new-password' : 'current-password'} {...field('password')} /></label>

        {isRegister && role === 'provider' && (
          <>
            <fieldset>
              <legend>Services you offer</legend>
              <div className="chips">
                {categories.map((c) => (
                  <button type="button" key={c.id} className={`chip ${services.includes(c.id) ? 'on' : ''}`} onClick={() => toggleService(c.id)}>
                    {c.icon} {c.name}
                  </button>
                ))}
              </div>
            </fieldset>
            <label>Short bio<textarea rows={2} maxLength={500} placeholder="Experience, certifications…" {...field('bio')} /></label>
          </>
        )}

        {error && <p className="error">{error}</p>}
        <button className="btn primary lg block" disabled={busy}>{isRegister ? 'Create account' : 'Sign in'}</button>
        <p className="muted small center">
          {isRegister ? <>Have an account? <Link to="/login">Sign in</Link></> : <>New here? <Link to="/register">Create an account</Link></>}
        </p>
        {!isRegister && <p className="muted small center">Demo: customer@demo.com / plumber@demo.com — password123</p>}
      </form>
    </div>
  );
}
