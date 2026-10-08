import { Link } from 'react-router-dom';
import { useSession } from '../session.jsx';
import { money } from '../format.js';

export default function Landing() {
  const { categories } = useSession();
  return (
    <div className="landing">
      <section className="hero">
        <h1>A trusted pro at your door,<br />in minutes.</h1>
        <p>Plumbers, electricians, cleaners, locksmiths and more. Upfront prices, live tracking, rated pros — like booking a ride, but for your home.</p>
        <div className="actions">
          <Link to="/register?role=customer" className="btn primary lg">Book a pro</Link>
          <Link to="/register?role=provider" className="btn lg">Earn as a pro</Link>
        </div>
        <p className="muted small">Already have an account? <Link to="/login">Sign in</Link></p>
      </section>

      <section className="grid categories">
        {categories.map((c) => (
          <div key={c.id} className="category static">
            <span className="icon">{c.icon}</span>
            <strong>{c.name}</strong>
            <span className="muted small">from {money(c.calloutCents + c.hourlyCents)}</span>
          </div>
        ))}
      </section>

      <section className="steps">
        <div><span>1</span><h3>Tell us what's wrong</h3><p className="muted">Pick a service, drop a pin and get an upfront price.</p></div>
        <div><span>2</span><h3>A nearby pro accepts</h3><p className="muted">Your request goes to available, rated pros close to you.</p></div>
        <div><span>3</span><h3>Track, chat, done</h3><p className="muted">Watch them arrive live, chat in-app, then rate the job.</p></div>
      </section>
    </div>
  );
}
