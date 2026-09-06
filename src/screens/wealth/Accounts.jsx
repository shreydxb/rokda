import { useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatPct } from '../../lib/money';
import { utilisation, estimatedStatement, billingCycle, daysUntilDue } from '../../lib/creditCard';
import { activeAccounts, archivedAccounts, closurePlan, isArchived } from '../../lib/accounts';
import { balanceLabel, balanceStatus } from '../../lib/balance';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { supabase } from '../../lib/supabaseClient';
import AccountEditor from './AccountEditor';

export default function Accounts({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const { accounts, transactions, reload } = data;
  const [editing, setEditing] = useState(null);
  const [closing, setClosing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const visible = accounts.filter((a) => scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId);
  const open = activeAccounts(visible);
  const closed = archivedAccounts(visible);
  const cards = open.filter((a) => a.type === 'credit_card');
  const other = open.filter((a) => a.type !== 'credit_card');

  // "Remove" closes the account and keeps its transactions. An account that was
  // never used is deleted outright; anything with history is archived, and the
  // database refuses the delete even if this check were bypassed (QA-01).
  async function confirmClose(account) {
    const plan = closurePlan(account, transactions);
    setBusy(true);
    setError(null);
    const { error: mutationError } =
      plan.action === 'delete'
        ? await supabase.from('accounts').delete().eq('id', account.id)
        : await supabase
            .from('accounts')
            .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', account.id);
    setBusy(false);
    if (mutationError) {
      setError(mutationError.message);
      return;
    }
    setClosing(null);
    await reload();
  }

  async function reopen(account) {
    setBusy(true);
    setError(null);
    const { error: mutationError } = await supabase
      .from('accounts')
      .update({ archived_at: null, updated_at: new Date().toISOString() })
      .eq('id', account.id);
    setBusy(false);
    if (mutationError) {
      setError(mutationError.message);
      return;
    }
    await reload();
  }

  return (
    <div>
      <div className="mn-filters">
        <div>
          {closed.length > 0 && (
            <button type="button" className="om-tab" data-active={showClosed} onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? 'Hide' : 'Show'} closed ({closed.length})
            </button>
          )}
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add account
        </button>
      </div>

      {error && (
        <div className="ov-error" role="alert" style={{ marginTop: 12 }}>
          Couldn’t update the account: {error}
        </div>
      )}

      {open.length === 0 && closed.length === 0 ? (
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
                  money={money}
                  onEdit={setEditing}
                  busy={busy}
                  plan={closing === a.id ? closurePlan(a, transactions) : null}
                  onRemove={() => (closing === a.id ? confirmClose(a) : setClosing(a.id))}
                  onCancelRemove={() => setClosing(null)}
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
                <AccountRow key={a.id} account={a} members={members} money={money} onEdit={() => setEditing(a)} />
              ))}
            </div>
          )}

          {showClosed && closed.length > 0 && (
            <>
              <div className="ov-kicker" style={{ marginTop: 30 }}>
                Closed accounts
              </div>
              <div className="ov-muted" style={{ marginTop: 4 }}>
                Their transactions stay in your history and reports. They aren’t offered for new entries and aren’t counted in
                today’s net worth.
              </div>
              <div className="mn-list" style={{ marginTop: 12 }}>
                {closed.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    members={members}
                    money={money}
                    onEdit={() => setEditing(a)}
                    action={
                      <button type="button" className="om-btn" disabled={busy} onClick={() => reopen(a)}>
                        Reopen
                      </button>
                    }
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {editing && (
        <AccountEditor
          account={editing === 'new' || editing === 'new-card' ? null : editing}
          defaultType={editing === 'new-card' ? 'credit_card' : undefined}
          householdId={household?.id}
          members={members}
          transactions={transactions}
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

function AccountRow({ account, members, money, onEdit, action }) {
  // An unconfirmed balance is unknown, not zero (QA-02).
  const status = balanceStatus(account);
  const note = balanceLabel(account);
  const owner = account.is_shared
    ? 'Joint'
    : (members.find((m) => m.id === account.owner_member_id)?.display_name ?? 'Unassigned');
  return (
    <div className="mn-row-wrap">
      <button type="button" className="mn-row" onClick={onEdit}>
        <div className="mn-row-main">
          <div>
            {account.name}
            {isArchived(account) && <span className="wl-card-chip" style={{ marginLeft: 8 }}>Closed</span>}
          </div>
          <div className="ov-muted">
            {owner}
            {` · ${account.type.replace('_', ' ')}`}
          </div>
        </div>
        <div className="mn-row-amt" style={{ textAlign: 'right' }}>
          {status === 'unset' ? (
            <span className="ov-muted">Set balance</span>
          ) : (
            <>
              <div className="fig">{money.fmtBalance(account.balance)}</div>
              {note && <div className="ov-muted" style={{ fontSize: 11 }}>{note}</div>}
            </>
          )}
        </div>
      </button>
      {action}
    </div>
  );
}

const CARD_DUE_SOON_DAYS = 10;

function CreditCard({ account, transactions, members, money, onEdit, plan, busy, onRemove, onCancelRemove }) {
  const util = utilisation(account);
  const est = estimatedStatement(transactions, account.id, account.statement_day);
  const cycle = account.statement_day ? billingCycle(account.statement_day) : null;
  const closesInDays = cycle ? Math.ceil((cycle.nextClose - new Date()) / 86400000) : null;
  const balance = Number(account.balance);
  // "Nothing owed" is a claim; an unconfirmed balance cannot make it (QA-02).
  const balanceUnset = balanceStatus(account) === 'unset';
  const balanceNote = balanceLabel(account);

  // Same rule as Overview's attention list: whole days from today, so a card
  // due today is due today on both screens (QA-07).
  const daysUntil = balance > 0 ? daysUntilDue(account.due_day) : null;
  const dueSoon = daysUntil !== null && daysUntil <= CARD_DUE_SOON_DAYS;

  return (
    <div className="wl-card">
      <button type="button" className="wl-card-main" onClick={() => onEdit(account)}>
        <div className="wl-card-head">
          <div>{account.name}</div>
          <span
            className={`wl-card-chip ${
              balanceUnset ? '' : dueSoon ? 'wl-card-chip-warn' : balance === 0 ? 'wl-card-chip-pos' : ''
            }`}
          >
            {balanceUnset ? 'Balance not set' : balance === 0 ? 'Nothing owed' : dueSoon ? 'Due soon' : 'Open'}
          </span>
        </div>
        <div className="ov-muted">
          {account.is_shared ? 'Joint' : (members.find((m) => m.id === account.owner_member_id)?.display_name ?? 'Unassigned')} · credit
          card
        </div>

        <div className="wl-card-owed fig">
          {balanceUnset ? <span className="ov-muted" style={{ fontSize: 15 }}>Not set</span> : money.fmtBalance(balance)}
        </div>
        {!balanceUnset && balanceNote && (
          <div className="ov-muted" style={{ marginTop: 4, fontSize: 11.5 }}>{balanceNote}</div>
        )}
        {util !== null ? (
          <>
            <div className="bud-bar" style={{ marginTop: 8 }}>
              <span className={`bud-bar-spent ${util > 0.8 ? 'bud-bar-over' : ''}`} style={{ width: `${Math.min(100, util * 100)}%` }} />
            </div>
            <div className="ov-muted" style={{ marginTop: 4 }}>
              {formatPct(util)} of {money.fmt(account.credit_limit)} used
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
            <div className="fig">{est ? money.fmt(est.amount) : '—'}</div>
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
        {plan ? (
          <div className="wl-card-confirm">
            <div>
              <div>{plan.title}</div>
              <div className="ov-muted">{plan.detail}</div>
            </div>
            <div className="wl-card-confirm-actions">
              <button type="button" className="om-btn" onClick={onCancelRemove} disabled={busy}>
                Keep
              </button>
              <button type="button" className="om-btn te-delete" onClick={onRemove} disabled={busy}>
                {plan.action === 'delete' ? 'Delete' : 'Close account'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="wl-card-removebtn" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
