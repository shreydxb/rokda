import { Axis } from '../charts/Charts';
import { handleKey, pointerHandlers } from '../charts/interaction';
import { niceTicks, yScale } from '../charts/scale';
import { useChartWidth } from '../charts/useChartWidth';
import '../charts/charts.css';
import './charts.css';

// The kit's charts (the revamp, phase 3; design/prototype/js/charts.js),
// drawn at the width they are given and sharing the app's chart interaction:
// hover, touch or the arrow keys pick a point, and the screen shows it in a
// readout of its own (src/charts/Charts.jsx).

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// A bare trend for a hero panel: a line over a faint wash, the latest point
// marked, no axis (the figure above it is the scale). Points it cannot read
// are left out.
export function TrendLine({ points, height = 78, activeIndex = null, onActiveChange = () => {}, ariaLabel }) {
  const [ref, width] = useChartWidth();
  const known = points.filter((p) => finite(p.value));
  if (known.length === 0) return <div ref={ref} className="ds-trend" />;
  const n = known.length;
  const values = known.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = 6;
  const x = (i) => (n === 1 ? width - pad : pad + (i / (n - 1)) * (width - pad * 2));
  const y = (v) => height - pad - ((v - lo) / (hi - lo || 1)) * (height - pad * 2);
  const line = known.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const wash = `${line} L${x(n - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const active = activeIndex !== null && known[activeIndex] ? activeIndex : null;
  return (
    <div
      ref={ref}
      className="ds-trend"
      role="group"
      aria-roledescription="chart"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, activeIndex, n, onActiveChange)}
    >
      <svg width={width} height={height} aria-hidden="true">
        {n > 1 && (
          <>
            <path className="ds-trend-wash" d={wash} />
            <path className="ds-trend-line" d={line} />
          </>
        )}
        {active !== null && active !== n - 1 && <circle className="ds-trend-pick" cx={x(active)} cy={y(known[active].value)} r={4} />}
        <circle className="ds-trend-last" cx={x(n - 1)} cy={y(known[n - 1].value)} r={3.5} />
        <rect className="ch-hit" x={0} y={0} width={width} height={height} {...pointerHandlers(n, onActiveChange)} />
      </svg>
    </div>
  );
}

const AXIS_W = 46;
const PAD_TOP = 10;
const PAD_RIGHT = 6;
const X_AXIS_H = 22;

// Two columns a month (`a` in the neutral context colour, `b` in the accent)
// with a line over them (`line`, in green): income, spending and what was
// saved. A month with no records is a quiet dotted mark, not two empty
// columns; a month that saved less than nothing takes the line below zero.
export function PairedColumns({ groups, height = 150, formatTick = String, activeIndex = null, onActiveChange = () => {}, ariaLabel }) {
  const [ref, width] = useChartWidth();
  const count = groups.length;
  const plotW = Math.max(40, width - AXIS_W - PAD_RIGHT);
  const band = plotW / Math.max(1, count);
  const barW = Math.min(24, Math.max(4, band * 0.26));
  const values = groups.filter((g) => !g.empty).flatMap((g) => [g.a, g.b, g.line]).filter(finite);
  const { min, max, ticks } = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const scale = yScale(min, max, height);
  const y = (v) => PAD_TOP + scale(v);
  const cx = (i) => AXIS_W + band * (i + 0.5);
  const pts = groups.map((g, i) => (!g.empty && finite(g.line) ? [cx(i), y(g.line)] : null)).filter(Boolean);
  const col = (cls, x0, v, faded) => {
    if (!finite(v) || v === 0) return null;
    const top = y(Math.max(0, v));
    const bottom = y(Math.min(0, v));
    return <rect className={cls} x={x0} y={top} width={barW} height={Math.max(1, bottom - top)} rx={2} opacity={faded ? 0.6 : 1} />;
  };
  return (
    <div
      ref={ref}
      className="ch ds-cols"
      role="group"
      aria-roledescription="chart"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, activeIndex, count, onActiveChange)}
    >
      <svg width={width} height={PAD_TOP + height + X_AXIS_H} aria-hidden="true">
        <Axis ticks={ticks} y={y} width={width} formatTick={formatTick} />
        {activeIndex !== null && <rect className="ch-band" x={AXIS_W + band * activeIndex} y={PAD_TOP} width={band} height={height} />}
        {groups.map((g, i) =>
          g.empty ? (
            <line key={g.key} className="ds-col-empty" x1={cx(i) - 10} x2={cx(i) + 10} y1={y(0) - 6} y2={y(0) - 6} />
          ) : (
            <g key={g.key}>
              {col('ds-col-a', cx(i) - barW - 2, g.a, false)}
              {col('ds-col-b', cx(i) + 2, g.b, g.current)}
            </g>
          )
        )}
        {pts.length > 1 && <path className="ds-col-line" d={pts.map(([px, py], k) => `${k === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} />}
        {pts.map(([px, py]) => (
          <circle key={`${px}`} className="ds-col-dot" cx={px} cy={py} r={3} />
        ))}
        {groups.map((g, i) => (
          <text key={g.key} className={`ch-tick ${i === activeIndex || g.current ? 'ch-tick-active' : ''}`} x={cx(i)} y={PAD_TOP + height + 15} textAnchor="middle">
            {g.label}
          </text>
        ))}
        <rect className="ch-hit" x={AXIS_W} y={0} width={plotW} height={PAD_TOP + height + X_AXIS_H} {...pointerHandlers(count, onActiveChange)} />
      </svg>
    </div>
  );
}

// A bar a month (the revamp, phase 5c; design/prototype charts.bars): what
// came in solid, a part presumed paler on top of it, and what is expected
// outlined above that; a line after the month marked `today`. The kit's
// hover, touch and arrow keys pick a month, and the screen reads it out.
export function MonthBars({ months, height = 160, formatTick = String, activeIndex = null, onActiveChange = () => {}, ariaLabel }) {
  const [ref, width] = useChartWidth();
  const count = months.length;
  const plotW = Math.max(40, width - AXIS_W - PAD_RIGHT);
  const band = plotW / Math.max(1, count);
  const barW = Math.min(22, Math.max(3, band * 0.6));
  const part = (v) => (finite(v) && v > 0 ? v : 0);
  const totals = months.map((m) => part(m.solid) + part(m.pale) + part(m.outline));
  const { min, max, ticks } = niceTicks(0, Math.max(0, ...totals));
  const scale = yScale(min, max, height);
  const y = (v) => PAD_TOP + scale(v);
  const left = (i) => AXIS_W + band * i + (band - barW) / 2;
  const seg = (cls, i, from, v) =>
    v > 0 ? <rect className={cls} x={left(i)} y={y(from + v)} width={barW} height={Math.max(1, y(from) - y(from + v))} rx={2} /> : null;
  const todayAt = months.findIndex((m) => m.today);
  return (
    <div
      ref={ref}
      className="ch ds-mbars"
      role="group"
      aria-roledescription="chart"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, activeIndex, count, onActiveChange)}
    >
      <svg width={width} height={PAD_TOP + height + X_AXIS_H} aria-hidden="true">
        <Axis ticks={ticks} y={y} width={width} formatTick={formatTick} />
        {activeIndex !== null && <rect className="ch-band" x={AXIS_W + band * activeIndex} y={PAD_TOP} width={band} height={height} />}
        {todayAt >= 0 && <line className="ds-mb-today" x1={AXIS_W + band * (todayAt + 1)} x2={AXIS_W + band * (todayAt + 1)} y1={PAD_TOP} y2={PAD_TOP + height} />}
        {months.map((m, i) => {
          const solid = part(m.solid);
          const pale = part(m.pale);
          return (
            <g key={m.key}>
              {seg('ds-mb-solid', i, 0, solid)}
              {seg('ds-mb-pale', i, solid, pale)}
              {seg('ds-mb-outline', i, solid + pale, part(m.outline))}
            </g>
          );
        })}
        {months.map((m, i) =>
          m.label ? (
            <text key={m.key} className={`ch-tick ${i === activeIndex || m.today ? 'ch-tick-active' : ''}`} x={AXIS_W + band * (i + 0.5)} y={PAD_TOP + height + 15} textAnchor="middle">
              {m.label}
            </text>
          ) : null,
        )}
        <rect className="ch-hit" x={AXIS_W} y={0} width={plotW} height={PAD_TOP + height + X_AXIS_H} {...pointerHandlers(count, onActiveChange)} />
      </svg>
    </div>
  );
}

// A dated strip from today: one mark per bill or pay day on its day, larger
// for a larger amount, coloured by status (late, not confirmed, income).
// Each mark names itself on hover; the rows under the strip say the same in
// words, so nothing is only on the strip.
export function DatedStrip({ days = 30, marks, ariaLabel, height = 52 }) {
  const [ref, width] = useChartWidth();
  const pad = 12;
  const lineY = 22;
  const x = (d) => pad + (Math.max(0, Math.min(days, d)) / days) * (width - pad * 2);
  const big = Math.max(1, ...marks.map((m) => Math.abs(m.amount)).filter(finite));
  const weeks = [];
  for (let d = 0; d <= days; d += 7) weeks.push(d);
  return (
    <div ref={ref} className="ds-strip">
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <line className="ds-strip-rail" x1={pad} x2={width - pad} y1={lineY} y2={lineY} />
        {weeks.map((d) => (
          <g key={d} aria-hidden="true">
            <line className="ds-strip-tick" x1={x(d)} x2={x(d)} y1={lineY - 4} y2={lineY + 4} />
            <text className={`ds-strip-label${d === 0 ? ' ds-strip-today' : ''}`} x={x(d)} y={height - 4} textAnchor={d === 0 ? 'start' : 'middle'}>
              {d === 0 ? 'today' : `+${d}d`}
            </text>
          </g>
        ))}
        {marks.map((m) => {
          const r = 4 + Math.sqrt(Math.abs(finite(m.amount) ? m.amount : 0) / big) * 7;
          return (
            <circle key={m.key} className={`ds-strip-mark ds-strip-${m.tone || 'plain'}`} cx={x(m.day)} cy={lineY} r={r.toFixed(1)}>
              <title>{m.label}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
