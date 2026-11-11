import { Link } from 'react-router-dom';
import { tabHref } from '../../lib/activityLink';
import { couldntLoad } from '../../lib/loadState';
import { ownerName } from '../overviewMath';
import { balanceStatus } from '../../lib/balance';
import { accountValueAed } from '../../lib/accounts';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Accounts: each one's balance and how fresh it is, in the scope shown.
export default function OverviewAccounts({ unread, accountRows, members, money }) {
  return (
    <div>
      <div className="ov-section-head">
        <div className="ov-kicker">Accounts</div>
        <Link className="ov-link" to={tabHref('/wealth', 'accounts')}>
          Wealth →
        </Link>
      </div>
      <div className="ov-list">
        {unread.includes('accounts') ? (
          <div className="ov-muted" role="alert" style={{ padding: '11px 0' }}>
            {couldntLoad(['accounts'])}
          </div>
        ) : accountRows.length === 0 ? (
          <div className="ov-muted" style={{ padding: '11px 0' }}>
            No accounts yet.
          </div>
        ) : (
          accountRows.map((a) => (
            <div key={a.id} className="ov-list-row">
              <div className="ov-list-main">
                <div>{a.name}</div>
                <div className="ov-muted">{a.is_shared ? 'Joint' : ownerName(a.owner_member_id, members)}</div>
              </div>
              <div className={`fig ov-list-amt ${a.type === 'credit_card' || a.type === 'loan' ? 'ov-neg' : ''}`}>
                {balanceStatus(a) === 'unset' ? (
                  <span className="ov-muted">Not set</span>
                ) : accountValueAed(a) === null ? (
                  // A foreign balance with no conversion. Printing it
                  // under the AED heading -- which `balance_aed ??
                  // balance` did -- turned INR 20,000 into "AED
                  // 20,000" right next to a headline that had excluded
                  // it entirely (QA #4).
                  <span className="ov-muted">{a.currency} {Number(a.balance ?? 0).toLocaleString('en-AE')} · not converted</span>
                ) : (
                  // A liability reduces the position, so it is shown
                  // negative — by negating the value, not by prefixing
                  // a sign that could double up on an overpaid card.
                  money.fmtBalance(
                    a.type === 'credit_card' || a.type === 'loan' ? -accountValueAed(a) : accountValueAed(a),
                  )
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
