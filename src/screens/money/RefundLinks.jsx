import { formatSigned } from '../../lib/money';
import { parseDay } from '../../lib/day';

// Part of the transaction editor (TransactionEditor.jsx), split out with
// the round 2 cleanup (SHR-383).
//
// A refund's purchase (lib/refunds.js): the one it is linked to, with Unlink,
// or up to three to choose from, linked on save. A purchase lists the refunds
// linked to it.
export default function RefundLinks({ isRefund, refundLink, linkedPurchase, refundSuggestions, refundFor, onChoose, confirmingUnlink, onUnlink, purchaseRefunds, accounts, saving }) {
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? 'Another account';
  const shortDay = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <>
      {isRefund && (
        <div className="te-refund" role="group" aria-label="Refund for">
          <span className="te-fieldlabel">Refund for</span>
          {refundLink ? (
            <div className="mn-row te-refund-row">
              <div className="mn-row-main">
                <div>{linkedPurchase ? linkedPurchase.merchant || 'Purchase' : 'A purchase that isn’t loaded'}</div>
                {linkedPurchase && (
                  <div className="ov-muted">
                    {shortDay(linkedPurchase.occurred_at)} · {accountName(linkedPurchase.account_id)} · {formatSigned(linkedPurchase.amount)}
                  </div>
                )}
              </div>
              <button type="button" className="om-btn" disabled={saving} onClick={onUnlink}>
                {confirmingUnlink ? 'Unlink it?' : 'Unlink'}
              </button>
            </div>
          ) : refundSuggestions.length > 0 ? (
            <>
              <div className="ov-muted te-refund-note">Choose the purchase this returns. Saving links them, and the refund takes the purchase’s category.</div>
              <div className="mn-list">
                {refundSuggestions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="mn-row te-refund-row"
                    aria-pressed={refundFor === p.id}
                    data-active={refundFor === p.id}
                    onClick={() => onChoose(p.id)}
                  >
                    <div className="mn-row-main">
                      <div>{p.merchant || 'Purchase'}</div>
                      <div className="ov-muted">
                        {shortDay(p.occurred_at)} · {accountName(p.account_id)}
                      </div>
                    </div>
                    <div className="fig">{formatSigned(p.amount)}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="ov-muted te-refund-note">No earlier purchase from this shop or on this account in the last four months to link it to.</div>
          )}
        </div>
      )}

      {purchaseRefunds.length > 0 && (
        <div className="te-refund" role="group" aria-label="Refunded">
          <span className="te-fieldlabel">Refunded</span>
          <div className="mn-list">
            {purchaseRefunds.map((r) => (
              <div key={r.id} className="mn-row te-refund-row" style={{ cursor: 'default' }}>
                <div className="mn-row-main">
                  <div>{r.merchant || 'Refund'}</div>
                  <div className="ov-muted">
                    {shortDay(r.occurred_at)} · {accountName(r.account_id)}
                  </div>
                </div>
                <div className="fig ov-pos">{formatSigned(r.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
