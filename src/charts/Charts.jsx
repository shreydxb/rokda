import { nearestIndex, niceTicks, stackSegments, yScale } from './scale';
import { useChartWidth } from './useChartWidth';
import './charts.css';

// Two chart forms, sharing one geometry and one interaction model:
//
// - hover (or touch, or the arrow keys once the chart has focus) picks a
//   column/point and reports it through onActiveChange;
// - the screen that owns the chart renders the detail for that pick in its
//   own readout row, the same pattern Overview's cash-flow chart set, so a
//   value is never only reachable by hovering;
// - every chart on a screen also offers its numbers as a table.

const AXIS_W = 46; // left gutter for tick labels
const PAD_TOP = 10;
const PAD_RIGHT = 6;
const X_AXIS_H = 22;
const MAX_BAR = 24;

function colorOf(series, value) {
  return typeof series.color === 'function' ? series.color(value) : series.color;
}

function handleKey(e, activeIndex, count, onActiveChange) {
  const current = activeIndex ?? count - 1;
  let next = null;
  if (e.key === 'ArrowLeft') next = Math.max(0, current - 1);
  else if (e.key === 'ArrowRight') next = Math.min(count - 1, current + 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = count - 1;
  if (next !== null) {
    e.preventDefault();
    onActiveChange(next);
  }
}

function pointerHandlers(count, onActiveChange) {
  const pick = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = nearestIndex(e.clientX - box.left, box.width, count);
    if (i !== null) onActiveChange(i);
  };
  return {
    onPointerMove: pick,
    onPointerDown: pick,
    // A mouse leaving the plot hands the pick back to the screen's default;
    // a finger lifting does not, or the readout would vanish mid-read.
    onPointerLeave: (e) => {
      if (e.pointerType === 'mouse') onActiveChange(null);
    },
  };
}

// X-axis labels: every `labelEvery`th, plus the active one, and never two
// close enough to overlap (the regular labels next to an active one give way).
function xLabels(count, band, labelEvery, activeIndex) {
  const clearance = Math.max(1, Math.ceil(34 / band));
  const shown = [];
  for (let i = 0; i < count; i++) {
    const regular = i % labelEvery === 0;
    if (i === activeIndex) shown.push(i);
    else if (regular && (activeIndex === null || Math.abs(i - activeIndex) >= clearance)) shown.push(i);
  }
  return shown;
}

function Axis({ ticks, y, width, formatTick }) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line className={t === 0 ? 'ch-zero' : 'ch-grid'} x1={AXIS_W} x2={width - PAD_RIGHT} y1={y(t)} y2={y(t)} />
          <text className="ch-tick" x={AXIS_W - 8} y={y(t)} dy="0.32em" textAnchor="end">
            {formatTick(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

// Columns, optionally stacked. Each column carries one value per series, in
// series order; positives stack up from zero and negatives down, so a year
// of dissaving or a negative starting net worth is drawn below the line
// rather than as if it were money held. `reference` is an optional per-column
// value drawn as a step line (a target, say).
export function ColumnChart({
  columns,
  series,
  reference = null,
  height = 200,
  formatTick = String,
  labelEvery = 1,
  activeIndex = null,
  onActiveChange = () => {},
  ariaLabel,
}) {
  const [ref, width] = useChartWidth();
  const count = columns.length;
  const plotW = Math.max(40, width - AXIS_W - PAD_RIGHT);
  const band = plotW / Math.max(1, count);
  const barW = Math.min(MAX_BAR, Math.max(3, band * 0.64));

  const stacks = columns.map((c) => stackSegments(c.values));
  const refValues = reference?.values ?? [];
  const lows = stacks.flatMap((s) => s.map(([from]) => from));
  const highs = stacks.flatMap((s) => s.map(([, to]) => to));
  const { min, max, ticks } = niceTicks(Math.min(...lows, ...refValues.filter(Number.isFinite)), Math.max(...highs, ...refValues.filter(Number.isFinite)));
  const scale = yScale(min, max, height);
  const y = (v) => PAD_TOP + scale(v);
  const bandX = (i) => AXIS_W + band * i;

  const refPath =
    reference && refValues.length === count
      ? refValues.map((v, i) => `${i === 0 ? 'M' : 'L'}${bandX(i)},${y(v)} L${bandX(i) + band},${y(v)}`).join(' ')
      : null;

  return (
    <div
      ref={ref}
      className="ch"
      role="group"
      aria-roledescription="chart"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, activeIndex, count, onActiveChange)}
    >
      <svg width={width} height={PAD_TOP + height + X_AXIS_H} aria-hidden="true">
        <Axis ticks={ticks} y={y} width={width} formatTick={formatTick} />
        {activeIndex !== null && <rect className="ch-band" x={bandX(activeIndex)} y={PAD_TOP} width={band} height={height} />}
        {columns.map((c, i) => (
          <g key={c.key} opacity={c.muted ? 0.45 : 1}>
            {stacks[i].map(([from, to], s) => {
              const top = y(to);
              const h = y(from) - top;
              if (h <= 0) return null;
              return (
                <rect
                  key={series[s].key}
                  className="ch-seg"
                  x={bandX(i) + (band - barW) / 2}
                  y={top}
                  width={barW}
                  height={h}
                  fill={colorOf(series[s], c.values[s])}
                  // The 2px surface-coloured gap between touching segments.
                  stroke="var(--canvas)"
                  strokeWidth={series.length > 1 ? 2 : 0}
                />
              );
            })}
          </g>
        ))}
        {refPath && (
          <>
            <path className="ch-reference" d={refPath} />
            {reference.label && (
              // At the left end, where a growing series is still short, with a
              // surface-coloured halo for when it is not.
              <text className="ch-reference-label" x={AXIS_W + 4} y={y(refValues[0]) - 6} textAnchor="start">
                {reference.label}
              </text>
            )}
          </>
        )}
        {xLabels(count, band, labelEvery, activeIndex).map((i) => (
          <text
            key={columns[i].key}
            className={`ch-tick ${i === activeIndex ? 'ch-tick-active' : ''}`}
            x={bandX(i) + band / 2}
            y={PAD_TOP + height + 15}
            textAnchor="middle"
          >
            {columns[i].label}
          </text>
        ))}
        <rect className="ch-hit" x={AXIS_W} y={0} width={plotW} height={PAD_TOP + height + X_AXIS_H} {...pointerHandlers(count, onActiveChange)} />
      </svg>
    </div>
  );
}

// One series as a 2px line over a 10% wash down to zero. A null value is a
// gap in the line (a month not reached yet), not a zero.
export function LineChart({
  points,
  color = 'var(--accent)',
  area = true,
  height = 180,
  formatTick = String,
  labelEvery = 1,
  activeIndex = null,
  onActiveChange = () => {},
  ariaLabel,
}) {
  const [ref, width] = useChartWidth();
  const count = points.length;
  const plotW = Math.max(40, width - AXIS_W - PAD_RIGHT);
  const band = plotW / Math.max(1, count);
  const values = points.map((p) => p.value).filter((v) => v !== null && Number.isFinite(v));
  const { min, max, ticks } = niceTicks(Math.min(...values), Math.max(...values));
  const scale = yScale(min, max, height);
  const y = (v) => PAD_TOP + scale(v);
  const x = (i) => AXIS_W + band * (i + 0.5);

  // Contiguous runs of known values, each drawn as its own line and wash.
  const runs = [];
  let run = [];
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length) runs.push(run);

  const active = activeIndex !== null ? points[activeIndex] : null;

  return (
    <div
      ref={ref}
      className="ch"
      role="group"
      aria-roledescription="chart"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, activeIndex, count, onActiveChange)}
    >
      <svg width={width} height={PAD_TOP + height + X_AXIS_H} aria-hidden="true">
        <Axis ticks={ticks} y={y} width={width} formatTick={formatTick} />
        {runs.map((r) => {
          const line = r.map((i, k) => `${k === 0 ? 'M' : 'L'}${x(i)},${y(points[i].value)}`).join(' ');
          const wash = `${line} L${x(r[r.length - 1])},${y(0)} L${x(r[0])},${y(0)} Z`;
          return (
            <g key={r[0]}>
              {area && <path d={wash} fill={color} opacity={0.1} />}
              {r.length > 1 ? (
                <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ) : (
                <circle cx={x(r[0])} cy={y(points[r[0]].value)} r={3} fill={color} />
              )}
            </g>
          );
        })}
        {active && (
          <>
            <line className="ch-crosshair" x1={x(activeIndex)} x2={x(activeIndex)} y1={PAD_TOP} y2={PAD_TOP + height} />
            {active.value !== null && Number.isFinite(active.value) && (
              <circle cx={x(activeIndex)} cy={y(active.value)} r={4.5} fill={color} stroke="var(--canvas)" strokeWidth={2} />
            )}
          </>
        )}
        {xLabels(count, band, labelEvery, activeIndex).map((i) => (
          <text
            key={points[i].key}
            className={`ch-tick ${i === activeIndex ? 'ch-tick-active' : ''}`}
            x={x(i)}
            y={PAD_TOP + height + 15}
            textAnchor="middle"
          >
            {points[i].label}
          </text>
        ))}
        <rect className="ch-hit" x={AXIS_W} y={0} width={plotW} height={PAD_TOP + height + X_AXIS_H} {...pointerHandlers(count, onActiveChange)} />
      </svg>
    </div>
  );
}

// A range of outcomes: a band between a low and a high series, with lines
// drawn over it. For series that are ordered and never cross -- a pessimistic,
// central and optimistic projection -- so the band's edges are told apart by
// position and their end labels, not by colour, and colour is kept for the
// one or two lines that matter. `lines`: [{ key, label, values, color }].
// `edgeLabels`: optional { low, high } text at the band's right-hand ends.
export function RangeChart({
  labels,
  low,
  high,
  lines = [],
  reference = null,
  edgeLabels = null,
  height = 220,
  formatTick = String,
  labelEvery = 1,
  activeIndex = null,
  onActiveChange = () => {},
  ariaLabel,
}) {
  const [ref, width] = useChartWidth();
  const count = labels.length;
  const plotW = Math.max(40, width - AXIS_W - PAD_RIGHT - 84);
  const band = plotW / Math.max(1, count);
  const all = [...low, ...high, ...lines.flatMap((l) => l.values), ...(reference?.values ?? [])].filter(Number.isFinite);
  const { min, max, ticks } = niceTicks(Math.min(...all), Math.max(...all));
  const scale = yScale(min, max, height);
  const y = (v) => PAD_TOP + scale(v);
  const x = (i) => AXIS_W + band * (i + 0.5);
  const path = (values) => values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const bandPath = `${path(high)} ${[...low].reverse().map((v, k) => `L${x(count - 1 - k)},${y(v)}`).join(' ')} Z`;
  const endX = x(count - 1) + 8;
  const endY = (v) => y(v) + 3.5;

  return (
    <div
      ref={ref}
      className="ch"
      role="group"
      aria-roledescription="chart"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, activeIndex, count, onActiveChange)}
    >
      <svg width={width} height={PAD_TOP + height + X_AXIS_H} aria-hidden="true">
        <Axis ticks={ticks} y={y} width={width - 84} formatTick={formatTick} />
        <path d={bandPath} fill="var(--ink2)" opacity={0.1} />
        <path d={path(low)} fill="none" stroke="var(--ink3)" strokeWidth={1.5} />
        <path d={path(high)} fill="none" stroke="var(--ink3)" strokeWidth={1.5} />
        {reference && <path className="ch-reference" d={path(reference.values)} />}
        {reference?.label && (
          <text className="ch-reference-label" x={AXIS_W + 4} y={y(reference.values[0]) - 6}>
            {reference.label}
          </text>
        )}
        {lines.map((l) => (
          <path key={l.key} d={path(l.values)} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {edgeLabels && (
          <>
            <text className="ch-tick" x={endX} y={endY(high[count - 1])}>
              {edgeLabels.high}
            </text>
            <text className="ch-tick" x={endX} y={endY(low[count - 1])}>
              {edgeLabels.low}
            </text>
          </>
        )}
        {activeIndex !== null && (
          <>
            <line className="ch-crosshair" x1={x(activeIndex)} x2={x(activeIndex)} y1={PAD_TOP} y2={PAD_TOP + height} />
            {lines.map((l) => (
              <circle key={l.key} cx={x(activeIndex)} cy={y(l.values[activeIndex])} r={4.5} fill={l.color} stroke="var(--canvas)" strokeWidth={2} />
            ))}
          </>
        )}
        {xLabels(count, band, labelEvery, activeIndex).map((i) => (
          <text key={i} className={`ch-tick ${i === activeIndex ? 'ch-tick-active' : ''}`} x={x(i)} y={PAD_TOP + height + 15} textAnchor="middle">
            {labels[i]}
          </text>
        ))}
        <rect className="ch-hit" x={AXIS_W} y={0} width={plotW} height={PAD_TOP + height + X_AXIS_H} {...pointerHandlers(count, onActiveChange)} />
      </svg>
    </div>
  );
}

// Legend keys mirror the mark: a square for bars and areas, a short stroke
// for lines. Text stays in ink; the colour is only ever on the key.
export function ChartLegend({ items }) {
  return (
    <div className="ch-legend">
      {items.map((item) => (
        <span key={item.label} className="ch-key">
          {item.kind === 'line' ? (
            <i className="ch-linekey" style={{ borderColor: item.color }} />
          ) : (
            <i className="ch-swatch" style={{ background: item.color }} />
          )}
          {item.label}
        </span>
      ))}
    </div>
  );
}
