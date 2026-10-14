import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { timeOnly } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

export default function Chat({ jobId, readOnly }) {
  const { user } = useSession();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    api(`/jobs/${jobId}/messages`).then(setMessages).catch((e) => setError(e.message));
  }, [jobId]);

  useSocketEvent('message:new', (m) => {
    if (m.jobId !== jobId) return;
    setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      const m = await api(`/jobs/${jobId}/messages`, { method: 'POST', body: { body: text } });
      setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
      setText('');
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card chat">
      <h3>Messages</h3>
      <div className="messages" ref={listRef}>
        {messages.length === 0 && <p className="muted small">No messages yet. Share gate codes, parking tips or photos of the issue.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.senderId === user.id ? 'mine' : ''}`}>
            <p>{m.body}</p>
            <span className="time">{timeOnly(m.createdAt)}</span>
          </div>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
      {!readOnly && (
        <form onSubmit={send} className="chat-form">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" maxLength={1000} />
          <button className="btn primary" disabled={!text.trim()}>Send</button>
        </form>
      )}
    </section>
  );
}
