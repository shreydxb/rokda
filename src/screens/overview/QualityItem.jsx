// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// One line of Data quality: what it checks, whether it holds, and why.
export default function QualityItem({ name, ok, label, note }) {
  return (
    <div className="ov-quality-item">
      <span className={ok ? 'ov-dot-pos' : 'ov-dot-warn'} />
      <div>
        <div className="ov-quality-row">
          <span>{name}</span>
          <span className={ok ? 'ov-chip-ok' : 'ov-chip-warn'}>{label}</span>
        </div>
        <div className="ov-muted ov-quality-note">{note}</div>
      </div>
    </div>
  );
}
