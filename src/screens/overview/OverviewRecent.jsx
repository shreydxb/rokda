import { Link } from 'react-router-dom';
import { Card, Chip } from '../../design-system/kit';
import { isTransfer } from '../../lib/transactionKind';
import { categoryParts } from '../../lib/splits';

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
        <div className="ds-table-wrap" tabIndex={0} role="region" aria-label="Recent transactions">
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
                  {t.needs_review && (
                    <>
                      {' '}
                      <Chip tone="warn">Needs review</Chip>
                    </>
                  )}
                </td>
                <td>
                  <CategoryCell t={t} catName={catName} />
                </td>
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

// A transfer says so; a split record names its lines' categories, as
// Activity does (it has none of its own, so it read as Uncategorised; fresh
// review of the cockpit); a record with none says so.
function CategoryCell({ t, catName }) {
  if (isTransfer(t)) return <span className="ov-muted">Transfer</span>;
  const names = [...new Set(categoryParts(t).map((p) => p.categoryId).filter(Boolean))].map((id) => catName.get(id) ?? '—');
  return names.length ? names.join(', ') : <Chip tone="warn">Uncategorised</Chip>;
}
