import { useEffect, useRef, useState } from 'react';
import { money } from '../format.js';

const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 48 };

/** Clean tick step: 1, 2 or 5 times a power of ten. */
function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw);
}
const compactRand = (cents) => {
  const r = cents / 100;
  return r >= 1000 ? `R${(r / 1000).toFixed(r % 1000 ? 1 : 0)}K` : `R${r}`;
};
const dayLabel = (date, opts = { day: 'numeric', month: 'short' }) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, opts);

/** Column chart of daily earnings: one series, so no legend; hover or focus a day for its numbers. */
export default function EarningsChart({ daily }) {
  const wrap = useRef(null);
  const [width, setWidth] = useState(600);
  const [active, setActive] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxCents = Math.max(...daily.map((d) => d.earningsCents), 0);
  const step = maxCents ? niceStep(maxCents) : 50000;
  const top = Math.max(step, Math.ceil(maxCents / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / daily.length;
  const barW = Math.max(2, Math.min(24, band - 2)); // capped at 24px, 2px surface gap between neighbours
  const y = (cents) => PAD.top + plotH - (cents / top) * plotH;
  const labelEvery = Math.ceil(daily.length / Math.max(2, Math.floor(plotW / 70)));
  const total = daily.reduce((s, d) => s + d.earningsCents, 0);

  const bar = (d, i) => {
    if (!d.earningsCents) return null;
    const x = PAD.left + i * band + (band - barW) / 2;
    const yTop = y(d.earningsCents);
    const h = PAD.top + plotH - yTop;
    const r = Math.min(4, barW / 2, h);
    // Rounded at the data end, square on the baseline.
    return (
      <path
        key={d.date}
        className={`bar ${active !== null && active !== i ? 'dim' : ''}`}
        d={`M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`}
      />
    );
  };

  const tip = active !== null ? daily[active] : null;
  const tipX = active !== null ? Math.min(Math.max(PAD.left + (active + 0.5) * band, 70), width - 70) : 0;

  return (
    <section className="card chart-card">
      <div className="row">
        <div className="grow">
          <h3>Daily earnings</h3>
          <p className="muted small">Last 30 days · {money(total)} in total</p>
        </div>
        <button className="link small" onClick={() => setShowTable((v) => !v)}>{showTable ? 'Show chart' : 'Show as table'}</button>
      </div>

      {showTable ? (
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>Day</th><th className="num">Jobs</th><th className="num">Earned</th></tr></thead>
            <tbody>
              {[...daily].reverse().map((d) => (
                <tr key={d.date}><td>{dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td><td className="num">{d.jobs}</td><td className="num">{money(d.earningsCents)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={wrap} onMouseLeave={() => setActive(null)}>
          <svg width={width} height={HEIGHT} role="img" aria-label={`Daily earnings for the last 30 days, ${money(total)} in total`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{compactRand(t)}</text>
              </g>
            ))}
            {daily.map(bar)}
            {daily.map((d, i) => ((daily.length - 1 - i) % labelEvery === 0 ? (
              <text key={d.date} className="axis" x={PAD.left + (i + 0.5) * band} y={HEIGHT - 8} textAnchor="middle">
                {i === daily.length - 1 ? 'Today' : dayLabel(d.date)}
              </text>
            ) : null))}
            {/* Hit targets: the whole column height, wider than the bar. */}
            {daily.map((d, i) => (
              <rect
                key={d.date}
                className="hit"
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                tabIndex={0}
                aria-label={`${dayLabel(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${money(d.earningsCents)}, ${d.jobs} jobs`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            ))}
          </svg>
          {tip && (
            <div className="chart-tip" style={{ left: tipX }}>
              <span className="muted small">{dayLabel(tip.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              <strong>{money(tip.earningsCents)}</strong>
              <span className="muted small">{tip.jobs} {tip.jobs === 1 ? 'job' : 'jobs'}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
