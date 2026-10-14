import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { disablePush, enablePush, isPushOn, needsHomeScreenInstall, pushPermission } from '../push.js';
import { useSession } from '../session.jsx';

function PushSetting() {
  const { config } = useSession();
  const [on, setOn] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const permission = pushPermission();

  useEffect(() => { isPushOn().then(setOn).catch(() => setOn(false)); }, []);

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      if (on) await disablePush();
      else await enablePush(config.push.publicKey);
      setOn(!on);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  let note = 'Get alerts on this device even when ProNow is closed.';
  if (permission === 'unsupported') note = needsHomeScreenInstall()
    ? 'On iPhone, first add ProNow to your home screen (Share → Add to Home Screen), then open it from there.'
    : "This browser doesn't support notifications.";
  else if (needsHomeScreenInstall()) note = 'On iPhone, add ProNow to your home screen (Share → Add to Home Screen) and open it from there to turn these on.';
  else if (permission === 'denied') note = 'Notifications are blocked for this site. Allow them in your browser settings, then come back.';

  const disabled = busy || on === null || permission === 'unsupported' || permission === 'denied' || needsHomeScreenInstall();
  return (
    <div className="setting">
      <div className="grow">
        <strong>Notifications on this device</strong>
        <p className="muted small">{note}</p>
        {error && <p className="error small">{error}</p>}
      </div>
      <button className={`toggle ${on ? 'on' : ''}`} aria-pressed={!!on} aria-label="Notifications on this device" disabled={disabled} onClick={toggle}>
        <span />
      </button>
    </div>
  );
}

export default function Settings() {
  const { user, setUser, signOut, config } = useSession();
  const [phone, setPhone] = useState(user.phone ?? '');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  async function update(body, message) {
    setError('');
    setSaved('');
    try {
      setUser(await api('/me', { method: 'PATCH', body }));
      setSaved(message);
    } catch (e) {
      setError(e.message);
    }
  }

  const isCustomer = user.role === 'customer';
  return (
    <div className="settings">
      <h2>Settings</h2>
      <section className="card">
        <h3>Notifications</h3>
        <p className="muted small">Job updates always appear in the app under 🔔.</p>
        <PushSetting />
        {isCustomer && config.sms.enabled && (
          <div className="setting">
            <div className="grow">
              <strong>Text messages</strong>
              <p className="muted small">
                An SMS when a pro accepts your job, is on the way, and when the job is done.
                {!user.phone && ' Add your mobile number below to get these.'}
              </p>
            </div>
            <button
              className={`toggle ${user.smsEnabled ? 'on' : ''}`}
              aria-pressed={user.smsEnabled}
              aria-label="Text messages"
              onClick={() => update({ smsEnabled: !user.smsEnabled }, user.smsEnabled ? 'Text messages turned off' : 'Text messages turned on')}
            >
              <span />
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Mobile number</h3>
        <p className="muted small">{isCustomer ? 'Used for text updates and so your pro can call you.' : 'Customers can call you on this number during a job.'}</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); update({ phone }, 'Number saved'); }}>
          <input type="tel" autoComplete="tel" placeholder="082 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn primary" disabled={phone === (user.phone ?? '')}>Save</button>
        </form>
      </section>

      {saved && <p className="notice">{saved}</p>}
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h3>Account</h3>
        <p className="muted small">Signed in as {user.email}</p>
        <button className="btn danger" onClick={signOut}>Sign out</button>
      </section>
    </div>
  );
}
