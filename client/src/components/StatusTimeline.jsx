import { timeOnly } from '../format.js';

const STEPS = [
  { status: 'requested', label: 'Requested', at: 'createdAt' },
  { status: 'accepted', label: 'Pro assigned', at: 'acceptedAt' },
  { status: 'en_route', label: 'On the way' },
  { status: 'arrived', label: 'Arrived' },
  { status: 'in_progress', label: 'Work started', at: 'startedAt' },
  { status: 'completed', label: 'Completed', at: 'completedAt' },
];

export default function StatusTimeline({ job }) {
  if (job.status === 'cancelled') return null;
  const current = STEPS.findIndex((s) => s.status === job.status);
  return (
    <ol className="timeline">
      {STEPS.map((step, i) => (
        <li key={step.status} className={i < current ? 'done' : i === current ? 'current' : ''}>
          <span className="dot" />
          <span className="label">{step.label}</span>
          {step.at && job[step.at] && i <= current && <span className="time">{timeOnly(job[step.at])}</span>}
        </li>
      ))}
    </ol>
  );
}
