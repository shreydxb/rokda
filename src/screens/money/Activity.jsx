import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId, scopedValue } from '../../lib/scope';
import { formatSigned, formatMoney } from '../../lib/money';
import { applyToIncomeSpend } from '../../lib/transactionKind';
import TransactionEditor from './TransactionEditor';
import ActivityCalendar from './ActivityCalendar';

// A transaction reads as low-confidence once it's below the same bar the
// Telegram bot uses to decide a record needs a human look (see
// isReadyForFastConfirm in intake.js) -- 0.85. Below 0.6 it's flagged as
// "needs attention" instead, matching how unsure an unreviewed intake row
// would have to be before this app itself wouldn't auto-suggest it.
function confidenceFlag(t) {
  if (t.confidence == null) return null;
  if (t.confidence < 0.6) return { label: 'needs attention', tone: 'neg' };
  if (t.confidence < 0.85) return { label: 'low confidence', tone: 'warn' };
  return null;
}

export default function Activity({ household, members, me, data, loading, categoryFilter, setCategoryFilter }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, accounts, categories, reload } = data;
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const [search, setSearch] = useState('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [view, setView] = useState('list'); // 'list' | 'calendar'
  const [editing, setEditing] = useState(null); // null closed, 'new', or a transaction row

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (scopeMemberId !== null && !(t.is_shared || t.owner_member_id === scopeMemberId)) return false;
      if (needsReviewOnly && !t.needs_review) return false;
      if (categoryFilter !== 'all' && t.category_id !== categoryFilter) return false;
      if (q) {
        const hay = `${t.merchant ?? ''} ${t.note ?? ''} ${t.amount}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, scopeMemberId, needsReviewOnly, categoryFilter, search]);

  const totals = useMemo(() => {
    const t = { income: 0, spend: 0 };
    for (const row of rows) applyToIncomeSpend(row, scopedValue(row.amount, row, scopeMemberId), t);
    return t;
  }, [rows, scopeMemberId]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <div className="mn-filters">
        <input
          className="mn-search"
          placeholder="Search merchant, note or amount"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="om-seg" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="om-seg"
          data-active={needsReviewOnly}
          onClick={() => setNeedsReviewOnly((v) => !v)}
        >
          Needs review
        </button>
        <div className="mn-viewtoggle">
          <button type="button" className="om-seg" data-active={view === 'list'} onClick={() => setView('list')}>
            List
          </button>
          <button type="button" className="om-seg" data-active={view === 'calendar'} onClick={() => setView('calendar')}>
            Calendar
          </button>
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add transaction
        </button>
      </div>
      <div className="mn-count">
        {rows.length} record{rows.length === 1 ? '' : 's'}
        {rows.length > 0 && (
          <>
            {' · '}
            {formatMoney(totals.spend)} out · {formatMoney(totals.income)} in
          </>
        )}
      </div>

      {view === 'calendar' ? (
        <ActivityCalendar rows={rows} members={members} />
      ) : rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No records</div>
          <div className="ov-empty-body">
            {transactions.length === 0
              ? 'Nothing recorded yet. Add a record by hand to get started.'
              : 'Nothing matches your filters.'}
          </div>
          <div className="ov-empty-actions">
            <button type="button" className="om-btn ov-btn-primary" onClick={() => setEditing('new')}>
              Add a transaction
            </button>
          </div>
        </div>
      ) : (
        <div className="mn-list">
          <div className="om-tx om-tx-head">
            <div>Date</div>
            <div>Merchant</div>
            <div className="om-hide-sm">Category</div>
            <div className="om-hide-sm">Owner</div>
            <div className="om-hide-sm">Account</div>
            <div className="om-tx-amt">Amount</div>
            <div />
          </div>
          {rows.map((t) => {
            const categoryName = t.categories?.name ?? 'Uncategorised';
            const owner = ownerLabel(t, members);
            const account = accountById.get(t.account_id)?.name ?? '—';
            const flag = confidenceFlag(t);
            return (
              <button key={t.id} type="button" className="om-tx om-tx-row" onClick={() => setEditing(t)}>
                <div className="om-tx-date">
                  {new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </div>
                <div className="om-tx-merchant">
                  {t.merchant || 'Transaction'}
                  {t.needs_review && <span className="om-tx-flag ov-warn"> · needs review</span>}
                  {!t.needs_review && flag && <span className={`om-tx-flag ${flag.tone === 'neg' ? 'ov-neg' : 'ov-warn'}`}> · {flag.label}</span>}
                  <div className="om-tx-meta">
                    {categoryName} · {account} · {owner}
                  </div>
                </div>
                <div className={`om-hide-sm om-tx-cat ${categoryName === 'Uncategorised' ? 'ov-warn' : ''}`}>{categoryName}</div>
                <div className="om-hide-sm om-tx-owner">{owner}</div>
                <div className="om-hide-sm om-tx-account">{account}</div>
                <div className={`fig om-tx-amt ${Number(t.amount) > 0 ? 'ov-pos' : ''}`}>{formatSigned(t.amount)}</div>
                <div className="om-tx-chev">›</div>
              </button>
            );
          })}
        </div>
      )}

      {editing && (
        <TransactionEditor
          tx={editing === 'new' ? null : editing}
          household={household}
          householdId={household?.id}
          accounts={accounts}
          categories={categories}
          members={members}
          allTransactions={transactions}
          onOpenOther={(other) => setEditing(other)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ownerLabel(t, members) {
  if (t.is_shared) return 'Shared';
  return members.find((m) => m.id === t.owner_member_id)?.display_name ?? 'Unassigned';
}
