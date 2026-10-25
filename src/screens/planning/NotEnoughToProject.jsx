import { Link } from 'react-router-dom';
import { tabHref } from '../../lib/activityLink';

// What a projection still needs, said item by item (Planning audit, 3.15).
// It was Forecast's, the only list of missing inputs, and the Life plan only
// sent you there; Forecast has gone, so the Life plan says it itself.
//
// `inputs` is forecastInputs; `startNetWorth` is null with nothing valued to
// start from. `incomplete` and `provisional` are what the start leaves out or
// has not confirmed, said as Plan says them.
export default function NotEnoughToProject({ inputs, startNetWorth, incomplete = null, provisional = null }) {
  const rows = [
    {
      label: 'Spending and saving',
      state:
        inputs.why === 'no-budget'
          ? 'needs a monthly budget, the basis you chose'
          : inputs.monthCount >= 3
            ? 'known'
            : `needs three ended months of records or a monthly budget · has ${inputs.monthCount}`,
    },
    {
      label: 'What you hold today',
      state: startNetWorth === null ? 'needs one account valuation' : incomplete ? `incomplete · ${incomplete}` : provisional ? `provisional · ${provisional}` : 'known',
    },
  ];
  return (
    <div className="ov-empty" style={{ marginTop: 22 }}>
      <div className="ov-empty-kicker">Not enough to project</div>
      <div className="ov-empty-body">
        The life plan starts from what the household spends, saves and holds. Without them, any year it gave would be a number the app
        invented, so none is shown.
      </div>
      <dl className="lp-needs">
        {rows.map((r) => (
          <div key={r.label} className="lp-need">
            <dt>{r.label}</dt>
            <dd className="ov-muted">{r.state}</dd>
          </div>
        ))}
      </dl>
      <div className="ov-empty-actions">
        <Link className="om-btn ov-btn-primary" to={tabHref('/wealth', 'accounts')}>
          Add an account
        </Link>
        <Link className="om-btn" to={tabHref('/money', 'budget')}>
          Set a budget
        </Link>
        <Link className="om-btn" to="/money">
          Record spending
        </Link>
      </div>
    </div>
  );
}
