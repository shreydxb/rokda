import { Link } from 'react-router-dom';
import { Card, Chip } from '../../design-system/kit';
import { isTransfer } from '../../lib/transactionKind';

// The last five transactions, a glance not a ledger (SHR-328; the revamp,
// phase 3, review S-overview-8): Activity is where records are looked into.
// Each opens in its editor here.
export default function OverviewRecent({ recent, money, categories, accounts, onOpen }) {
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  return (
    <Card
      title="Recent"
      className="ov-recent"
      flush
      right={
        <Link className="ov-link" to="/money">
          All records in Activity →
        </Link>
      }
    >
      {recent.length === 0 ? (
        <div className="ov-muted ov-recent-none">No transactions yet.</div>
      ) : (
        // A table scrolls sideways inside its card when the screen is narrow,
        // never the page.
        <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Merchant</th>
              <th scope="col">Category</th>
              <th scope="col">Account</th>
              <th scope="col" className="ds-num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={t.id} className="ov-recent-row">
                <td className="ov-recent-date">{new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
                <td className="ov-recent-main">
                  <button type="button" className="ov-recent-open" onClick={() => onOpen(t)}>
                    {t.merchant ?? 'Transaction'}
                  </button>
                </td>
                <td>{isTransfer(t) ? <span className="ov-muted">Transfer</span> : t.category_id ? (catName.get(t.category_id) ?? '—') : <Chip tone="warn">Uncategorised</Chip>}</td>
                <td className="ov-muted">{accName.get(t.account_id) ?? '—'}</td>
                <td className={`ds-num${Number(t.amount) > 0 ? ' ds-pos' : ''}`}>{money.fmtSigned(t.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </Card>
  );
}
