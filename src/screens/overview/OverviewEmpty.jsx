import { tabHref } from '../../lib/activityLink';
import { Card } from '../../design-system/kit';

// A household with nothing recorded yet (the revamp, phase 3; review
// S-overview-10): one line and the two first steps. Figures stay blank
// rather than reading as zero until a first record arrives.
export default function OverviewEmpty({ navigate, onAddTransaction }) {
  return (
    <Card className="ov-empty-card">
      <div className="ds-empty">
        <div className="ds-empty-title">Nothing recorded yet.</div>
        <div className="ov-empty-actions">
          <button type="button" className="ds-btn ds-btn-primary" onClick={onAddTransaction}>
            + Transaction
          </button>
          <button type="button" className="ds-btn" onClick={() => navigate(tabHref('/wealth', 'accounts'))}>
            + Account
          </button>
        </div>
      </div>
    </Card>
  );
}
