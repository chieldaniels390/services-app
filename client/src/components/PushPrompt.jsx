import { useEffect, useState } from 'react';
import { enablePush, isPushOn, needsHomeScreenInstall, pushPermission } from '../push.js';
import { useSession } from '../session.jsx';

const DISMISS_KEY = 'pronow.pushPromptDismissed';

/** A one-line nudge to turn on push where it matters most (live jobs, pros waiting for requests). */
export default function PushPrompt({ message }) {
  const { config } = useSession();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      // ignore
    }
    if (dismissed || pushPermission() === 'unsupported' || pushPermission() === 'denied' || needsHomeScreenInstall()) return;
    isPushOn().then((on) => setVisible(!on)).catch(() => {});
  }, []);

  if (!visible) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
    setVisible(false);
  };
  return (
    <div className="push-prompt">
      <span className="icon">🔔</span>
      <span className="grow">{message}{error && <span className="error small"> {error}</span>}</span>
      <button className="btn primary" onClick={() => enablePush(config.push.publicKey).then(() => setVisible(false)).catch((e) => setError(e.message))}>
        Turn on
      </button>
      <button className="link" aria-label="Not now" onClick={dismiss}>✕</button>
    </div>
  );
}
