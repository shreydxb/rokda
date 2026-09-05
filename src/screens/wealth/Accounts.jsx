import { useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import { utilisation, estimatedStatement, billingCycle } from '../../lib/creditCard';
import { supabase } from '../../lib/supabaseClient';
import AccountEditor from './AccountEditor';

export default function Accounts({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { accounts, transactions, reload } = data;
  const [editing, setEditing] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const visible = accounts.filter((a) => scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId);
  const cards = visible.filter((a) => a.type === 'credit_card');
  const other = visible.filter((a) => a.type !== 'credit_card');

  async function handleRemove(id) {
    if (removingId !== id) {
      setRemovingId(id);
      return;
    }
    setRemovingId(null);
    await supabase.from('accounts').delete().eq('id', id);
    await reload();
  }

  return (
    <div>
      <div className="mn-filters">
        <div />
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add account
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No accounts</div>
          <div className="ov-empty-body">Add your first account to start tracking net worth.</div>
        </div>
      ) : (
        <>
          {cards.length > 0 && (
            <div className="wl-cardgrid" style={{ marginTop: 22 }}>
              {cards.map((a) => (
                <CreditCard
                  key={a.id}
                  account={a}
                  transactions={transactions}
                  members={members}
                  onEdit={setEditing}
                  removing={removingId === a.id}
                  onRemove={() => handleRemove(a.id)}
                  onCancelRemove={() => setRemovingId(null)}
                />
              ))}
              <button type="button" className="wl-cardadd" onClick={() => setEditing('new-card')}>
                + Add a card
              </button>
            </div>
          )}

          {other.length > 0 && (
            <div className="mn-list" style={{ marginTop: cards.length > 0 ? 30 : 22 }}>
              {other.map((a) => (
                <button key={a.id} type="button" className="mn-row" onClick={() => setEditing(a)}>
                  <div className="mn-row-main">
                    <div>{a.name}</div>
                    <div className="ov-muted">
                      {a.is_shared ? 'Joint' : (members.find((m) => m.id === a.owner_member_id)?.display_name ?? 'Unassigned')}
                      {` · ${a.type.replace('_', ' ')}`}
                    </div>
                  </div>
                  <div className="fig mn-row-amt">{formatMoney(a.balance)}</div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {editing && (
        <AccountEditor
          account={editing === 'new' || editing === 'new-card' ? null : editing}
          defaultType={editing === 'new-card' ? 'credit_card' : undefined}
          householdId={household?.id}
          members={members}
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

const CARD_DUE_SOON_DAYS = 10;

function CreditCard({ account, transactions, members, onEdit, removing, onRemove, onCancelRemove }) {
  const util = utilisation(account);
  const est = estimatedStatement(transactions, account.id, account.statement_day);
  const cycle = account.statement_day ? billingCycle(account.statement_day) : null;
  const closesInDays = cycle ? Math.ceil((cycle.nextClose - new Date()) / 86400000) : null;
  const balance = Number(account.balance);

  let dueSoon = false;
  if (account.due_day && balance > 0) {
    const today = new Date();
    let due = new Date(today.getFullYear(), today.getMonth(), account.due_day);
    if (due < today) due = new Date(today.getFullYear(), today.getMonth() + 1, account.due_day);
    dueSoon = Math.round((due - today) / 86400000) <= CARD_DUE_SOON_DAYS;
  }

  return (
    <div className="wl-card">
      <button type="button" className="wl-card-main" onClick={() => onEdit(account)}>
        <div className="wl-card-head">
          <div>{account.name}</div>
          <span className={`wl-card-chip ${dueSoon ? 'wl-card-chip-warn' : balance === 0 ? 'wl-card-chip-pos' : ''}`}>
            {balance === 0 ? 'Nothing owed' : dueSoon ? 'Due soon' : 'Open'}
          </span>
        </div>
        <div className="ov-muted">
          {account.is_shared ? 'Joint' : (members.find((m) => m.id === account.owner_member_id)?.display_name ?? 'Unassigned')} · credit
          card
        </div>

        <div className="wl-card-owed fig">{formatMoney(balance)}</div>
        {util !== null ? (
          <>
            <div className="bud-bar" style={{ marginTop: 8 }}>
              <span className={`bud-bar-spent ${util > 0.8 ? 'bud-bar-over' : ''}`} style={{ width: `${Math.min(100, util * 100)}%` }} />
            </div>
            <div className="ov-muted" style={{ marginTop: 4 }}>
              {formatPct(util)} of {formatMoney(account.credit_limit)} used
            </div>
          </>
        ) : (
          <div className="ov-muted" style={{ marginTop: 8 }}>
            No limit set yet
          </div>
        )}

        <div className="wl-card-stats">
          <div>
            <div className="ov-muted">Spent so far</div>
            <div className="fig">{est ? formatMoney(est.amount) : '—'}</div>
          </div>
          <div>
            <div className="ov-muted">Closes in</div>
            <div className="fig">{closesInDays !== null ? `${closesInDays}d` : '—'}</div>
          </div>
          <div>
            <div className="ov-muted">Due</div>
            <div className="fig">{account.due_day ? `${account.due_day}th` : '—'}</div>
          </div>
        </div>
      </button>
      <div className="wl-card-foot">
        {removing ? (
          <>
            <span className="ov-muted">Remove this card?</span>
            <button type="button" className="om-btn" onClick={onCancelRemove}>
              Keep
            </button>
            <button type="button" className="om-btn te-delete" onClick={onRemove}>
              Confirm
            </button>
          </>
        ) : (
          <button type="button" className="wl-card-removebtn" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
