// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// One headline figure, and how it moved against the same stretch of the
// period before. Up is good for income, bad for spending; the arrow says the
// direction and the colour says whether that is good.
export default function Kpi({ label, figure, tone = '', change, goodWhenUp, prevLabel, fmt, hint = null }) {
  let note = null;
  if (change) {
    const up = change.value > 0;
    const flat = Math.abs(change.value) < 0.5;
    const text = change.kind === 'points' ? `${Math.abs(change.value).toFixed(0)} pts` : fmt(Math.abs(change.value));
    note = flat ? (
      <span className="ov-muted">same as {prevLabel}</span>
    ) : (
      <>
        <span className={up === goodWhenUp ? 'ov-pos' : 'ov-warn'}>
          {up ? '▲' : '▼'} {text}
        </span>
        <span className="ov-muted"> vs {prevLabel}</span>
      </>
    );
  }
  return (
    <div>
      <div className="ov-kpi-label">{label}</div>
      <div className={`ov-kpi-fig fig ${tone}`}>{figure}</div>
      {note && <div className="ov-kpi-change">{note}</div>}
      {hint && <div className="ov-kpi-change ov-muted ov-kpi-hint">{hint}</div>}
    </div>
  );
}
