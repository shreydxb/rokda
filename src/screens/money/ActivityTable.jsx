import { useState } from 'react';
import { formatBalance, formatMoney, formatSigned } from '../../lib/money';
import { isPosted, parseDay } from '../../lib/day';
import { isUncategorised, rowDateLabel, shareOf } from '../../lib/activity';
import { fileableCategories } from '../../lib/fileableCategories';
import { transferCounterpart, transferDirectionLabel } from '../../lib/transfers';
import { categoryParts } from '../../lib/splits';
import { Avatar, Card, Chip, InfoButton, EmptyState } from '../../design-system/kit';

// Activity's list as a table, as in the prototype (the revamp, phase 4;
// review S-activity-3 to 5): the count and the month's Spent and Income on
// the card, the rows with what each says about itself as chips, a category
// chosen in place for a record that has none, and the owner beside the
// account. Date and Amount sort from their headings.

// A reading below the bar the Telegram bot uses to ask a person to look
// (isReadyForFastConfirm in lib/intake.js) is flagged; well below it, as
// needing attention.
function confidenceFlag(t) {
  if (t.confidence == null) return null;
  if (t.confidence < 0.6) return { label: 'Needs attention', tone: 'neg' };
  if (t.confidence < 0.85) return { label: 'Low confidence', tone: 'warn' };
  return null;
}

const SORT_OF = {
  date: { first: 'newest', then: 'oldest' },
  amount: { first: 'largest', then: 'smallest' },
};
const ARIA_SORT = { newest: ['date', 'descending'], oldest: ['date', 'ascending'], largest: ['amount', 'descending'], smallest: ['amount', 'ascending'] };

export default function ActivityTable({
  title = null,
  showTotals = true,
  rows,
  visibleCount,
  onShowMore,
  totals,
  scheduledHidden,
  onShowScheduled,
  sort,
  onSort,
  scopeMemberId,
  members,
  categories,
  accountById,
  links,
  transactions,
  refundLinks,
  amountOf,
  categoryFilterName,
  duplicateIds,
  now,
  onOpen,
  onCategorise,
  onClearFilters,
}) {
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const memberTone = new Map(members.map((m, i) => [m.id, i === 0 ? 'a' : 'b']));
  const scoped = scopeMemberId !== null;

  const owner = (t) => {
    if (t.is_shared) return <Avatar name="Shared" initial="S" />;
    const m = members.find((x) => x.id === t.owner_member_id);
    return m ? <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={memberTone.get(m.id)} /> : null;
  };

  const choose = async (t, categoryId) => {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;
    setSaving(t.id);
    setError(null);
    const result = await onCategorise(t, category);
    setSaving(null);
    if (result.error) setError(result.error);
    else if (result.historyError) setError(`Saved, but not added to the record's history: ${result.historyError}`);
  };

  const heading = (key, label) => {
    const [active, dir] = ARIA_SORT[sort] ?? ['date', 'descending'];
    const on = active === key;
    return (
      <th scope="col" className={key === 'amount' ? 'ds-num' : undefined} aria-sort={on ? dir : 'none'}>
        <button type="button" className="mn-sort" data-on={on || undefined} onClick={() => onSort(on && sort === SORT_OF[key].first ? SORT_OF[key].then : SORT_OF[key].first)}>
          {label}
          {on && <span aria-hidden="true">{dir === 'descending' ? ' ↓' : ' ↑'}</span>}
        </button>
      </th>
    );
  };

  const info = (
    <InfoButton about="these totals">
      {`Spent is purchases ${formatMoney(totals.purchases)} less refunds ${formatMoney(totals.refunds)}. ${totals.transfers} transfer${totals.transfers === 1 ? '' : 's'} between your own accounts count as neither.`}
      {scoped && ' Shared records count half.'}
    </InfoButton>
  );

  return (
    <Card
      title={title ?? `${rows.length} transaction${rows.length === 1 ? '' : 's'}`}
      className="mn-table-card"
      flush
      right={
        showTotals && (
        <span className="mn-summary">
          {scheduledHidden > 0 && (
            <button type="button" className="ds-chip ds-chip-neutral" onClick={onShowScheduled}>
              {`${scheduledHidden} scheduled not counted`}
            </button>
          )}
          <span>
            {/* Refunds can outweigh purchases: the money back keeps its sign. */}
            Spent <b className="mn-sum">{formatBalance(totals.spend)}</b>
          </span>
          <span>
            Income <b className="mn-sum">{formatMoney(totals.income)}</b>
          </span>
          {info}
        </span>
        )
      }
    >
      {error && (
        <div className="mn-row-error" role="alert">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Nothing matches" body="Try fewer filters." action={{ label: 'Clear filters', onClick: onClearFilters }} />
      ) : (
        <div className="ds-table-wrap" tabIndex={0} role="region" aria-label="Transactions">
          <table className="ds-table mn-table">
            <thead>
              <tr>
                {heading('date', 'Date')}
                <th scope="col">Merchant</th>
                <th scope="col" className="mn-col-cat">
                  Category
                </th>
                <th scope="col" className="mn-col-acct">
                  Account
                </th>
                {heading('amount', 'Amount')}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, visibleCount).map((t) => {
                const transfer = t.kind === 'transfer';
                const parts = t.is_split ? categoryParts(t) : null;
                const label = transfer ? transferDirectionLabel(t, transferCounterpart(t, links, transactions), accountById) : null;
                const flag = t.needs_review ? null : confidenceFlag(t);
                const scheduled = !isPosted(t, now);
                const full = Number(t.amount);
                const shown = scoped ? shareOf(t, scopeMemberId) : full;
                const inFiltered = parts && amountOf ? amountOf(t) : null;
                const purchase = refundLinks.purchaseOf.get(t.id);
                const back = refundLinks.back.get(t.id);
                const account = accountById.get(t.account_id)?.name ?? '—';
                return (
                  <tr key={t.id} className="om-tx-row" onClick={() => onOpen(t)}>
                    <td className="mn-date">{rowDateLabel(t.occurred_at, now)}</td>
                    <td className="mn-merchant">
                      <div className="mn-merchant-line">
                        <button
                          type="button"
                          className="mn-open"
                          title={t.merchant ?? undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(t);
                          }}
                        >
                          {transfer ? (t.merchant ?? label) : t.merchant || 'Transaction'}
                        </button>
                        {t.needs_review && <Chip tone="warn">Needs review</Chip>}
                        {flag && <Chip tone={flag.tone}>{flag.label}</Chip>}
                        {t.kind === 'refund' && <Chip tone="pos">Refund</Chip>}
                        {back != null && <Chip>{back + 0.005 >= -full ? 'Refunded' : 'Part refunded'}</Chip>}
                        {scheduled && <Chip>Scheduled</Chip>}
                        {duplicateIds.has(t.id) && <Chip tone="warn">Possible duplicate</Chip>}
                      </div>
                      {t.kind === 'refund' && refundLinks.purchaseOf.has(t.id) && <div className="mn-sub">{refundFor(purchase)}</div>}
                      {transfer && t.merchant && <div className="mn-sub">{label}</div>}
                      {/* On a phone the category and account columns fold away,
                          and say themselves here instead. */}
                      <div className="mn-meta">
                        {transfer ? 'Transfer' : parts ? parts.map((p) => catName.get(p.categoryId) ?? 'Unknown').join(' + ') : (catName.get(t.category_id) ?? 'Uncategorised')} · {account}
                      </div>
                    </td>
                    <td className="mn-cat mn-col-cat">
                      {transfer ? (
                        <span className="ds-muted">Transfer</span>
                      ) : parts ? (
                        parts.map((p) => catName.get(p.categoryId) ?? 'Unknown').join(' + ')
                      ) : isUncategorised(t) && refundLinks.purchaseOf.has(t.id) ? (
                        // A linked refund is filed under its purchase's
                        // category, and has none of its own to choose.
                        <span className="ds-muted">With its purchase</span>
                      ) : isUncategorised(t) ? (
                        <select
                          className="ds-select ds-select-sm mn-cat-select"
                          aria-label={`Category for ${t.merchant || 'this record'}`}
                          value=""
                          disabled={saving === t.id}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => choose(t, e.target.value)}
                        >
                          <option value="">Uncategorised</option>
                          {fileableCategories(categories, full > 0 && t.kind !== 'refund' ? 'income' : 'expense').map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (catName.get(t.category_id) ?? 'Unknown')
                      )}
                    </td>
                    <td className="mn-acct mn-col-acct">
                      <span className="mn-acct-line">
                        {owner(t)}
                        <span className="mn-acct-name">{account}</span>
                      </span>
                    </td>
                    <td className={`ds-num mn-amt${transfer ? ' ds-muted' : full > 0 ? ' ds-pos' : ''}`}>
                      {formatSigned(shown)}
                      {t.native_amount != null && t.currency && t.currency !== 'AED' && (
                        <div className={`mn-sub${t.aed_estimated ? ' mn-warn' : ''}`}>
                          {t.currency} {formatSigned(t.native_amount)}
                          {t.aed_estimated ? ' · AED estimated' : ''}
                        </div>
                      )}
                      {inFiltered !== null && (
                        <div className="mn-sub">
                          {categoryFilterName} {formatSigned(inFiltered)}
                        </div>
                      )}
                      {scoped && shown !== full && <div className="mn-sub">half of {formatSigned(full)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > visibleCount && (
            <button type="button" className="ds-btn mn-show-more" onClick={onShowMore}>
              Show {Math.min(200, rows.length - visibleCount)} more · {rows.length - visibleCount} not shown
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// "for Shop, 20 Sept" once a refund is linked to its purchase.
function refundFor(purchase) {
  if (!purchase) return 'for a purchase';
  return `for ${purchase.merchant || 'a purchase'}, ${parseDay(purchase.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}
