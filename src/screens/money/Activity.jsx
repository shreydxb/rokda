import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatSigned } from '../../lib/money';
import TransactionEditor from './TransactionEditor';
import ActivityCalendar from './ActivityCalendar';

export default function Activity({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, accounts, categories, reload } = data;

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
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
          {rows.map((t) => (
            <button key={t.id} type="button" className="mn-row" onClick={() => setEditing(t)}>
              <div className="mn-row-main">
                <div>{t.merchant || 'Transaction'}</div>
                <div className="ov-muted">
                  {new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {' · '}
                  {t.categories?.name ?? 'Uncategorised'}
                  {' · '}
                  {ownerLabel(t, members)}
                  {t.needs_review ? <span className="ov-warn"> · needs review</span> : null}
                </div>
              </div>
              <div className={`fig mn-row-amt ${Number(t.amount) > 0 ? 'ov-pos' : ''}`}>{formatSigned(t.amount)}</div>
            </button>
          ))}
        </div>
      )}

      {editing && (
        <TransactionEditor
          tx={editing === 'new' ? null : editing}
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
