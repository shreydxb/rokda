import { tabHref } from '../../lib/activityLink';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Day one: no figures yet, so none are shown, and where to start.
export default function EmptyState({ navigate }) {
  return (
    <div className="ov-empty">
      <div className="ov-empty-kicker">Day one</div>
      <div className="ov-empty-body">
        There are no figures to show, so none are shown. Net worth, savings rate and runway all need a first record;
        until one arrives they stay blank rather than reading as zero.
      </div>
      <div className="ov-empty-actions">
        <button type="button" className="om-btn ov-btn-primary" onClick={() => navigate('/money')}>
          Add a transaction
        </button>
        <button type="button" className="om-btn" onClick={() => navigate(tabHref('/wealth', 'accounts'))}>
          Add an account
        </button>
      </div>
      <div className="ov-empty-foot">Three records is enough for Activity and Accounts. A savings rate needs one closed month. Runway needs six.</div>
    </div>
  );
}
