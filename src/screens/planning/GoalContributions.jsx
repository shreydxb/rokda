import { formatMoney } from '../../lib/money';
import { parseDay } from '../../lib/day';

const dayLabel = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Part of the goal editor (GoalEditor.jsx), split out with the round 2
// cleanup (SHR-383).
//
// What has been put towards a goal: a form to log a contribution, and the
// list, each with the editor's Remove controls. With accounts or holdings
// linked, those are what count as saved, and the list is a record.
export default function GoalContributions({ labelledBy, heading, messages, hasLinks, ids, amount: contribAmount, onAmount, date: contribDate, onDate, onLog, saving, contributions, removeControls }) {
  return (
    <section className="te-section" aria-labelledby={labelledBy}>
      {heading}
      {hasLinks && (
        <div className="ov-muted" style={{ fontSize: 11.5, marginBottom: 12, lineHeight: 1.5 }}>
          Its linked accounts and holdings are what count as saved, so what is logged here is a record and is not added on top.
        </div>
      )}
      <form onSubmit={onLog} noValidate>
        <div className="te-fieldgrid">
          <div className="te-fieldcell">
            <label className="te-fieldlabel" htmlFor={ids.amount}>
              Amount (AED)
            </label>
            <input
              id={ids.amount}
              className="te-fieldvalue"
              type="number"
              step="0.01"
              value={contribAmount}
              onChange={(e) => onAmount(e.target.value)}
            />
          </div>
          <div className="te-fieldcell">
            <label className="te-fieldlabel" htmlFor={ids.date}>
              Date
            </label>
            <input id={ids.date} className="te-fieldvalue" type="date" value={contribDate} onChange={(e) => onDate(e.target.value)} />
          </div>
        </div>
        <div className="te-subactions">
          <button type="submit" className="om-btn" aria-disabled={saving}>
            Log contribution
          </button>
        </div>
      </form>
      {messages}

      {contributions.length === 0 ? (
        <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
          No contributions logged yet.
        </div>
      ) : (
        <div className="mn-list">
          {contributions.map((c) => (
            <div key={c.id} className="mn-row te-linkrow" style={{ cursor: 'default' }}>
              <div className="mn-row-main">{dayLabel(c.occurred_at)}</div>
              <div className="te-rowcontrols">
                <span className="fig mn-row-amt">{formatMoney(c.amount)}</span>
                {removeControls('contribution', c.id, `the contribution of ${formatMoney(c.amount)} on ${dayLabel(c.occurred_at)}`)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
