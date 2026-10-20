import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { householdToday } from '../../lib/day';
import { transferEdits } from '../../lib/editHistory';
import { ENTRY_TYPES } from '../../lib/entryTypes';
import EditHistory from './EditHistory';
import './TransactionEditor.css';

// Money moved between two of the household's own accounts (docs/decisions.md,
// "Transfers are neither income nor spending"; SHR-234): paying the card from
// the current account, or putting money into savings. It is two records, one
// out and one in, for the same amount, and it is neither income nor spending.
//
// Every write goes through a database function that writes both sides and
// their link together, so a transfer is never left half there:
// record_transfer, update_transfer, unlink_transfer and delete_transfer.
// Amounts are AED, as every record's is.
export default function TransferEditor({ transfer, householdId, accounts, members, onClose, onSaved, onSwitchType }) {
  // `transfer` is { link, out, in } for an existing one, null for a new one.
  const existing = !!transfer;
  const selectable = selectableAccounts(accounts, transfer?.out?.account_id ?? null).filter((a) => existing || !a.archived_at);
  const [form, setForm] = useState(() =>
    existing
      ? {
          from: transfer.out.account_id,
          to: transfer.in.account_id,
          amount: String(Math.abs(Number(transfer.in.amount))),
          occurred_at: transfer.out.occurred_at,
          note: transfer.out.note ?? '',
          owner: transfer.out.is_shared ? 'shared' : (transfer.out.owner_member_id ?? 'shared'),
        }
      : { from: selectable[0]?.id ?? '', to: selectable[1]?.id ?? '', amount: '', occurred_at: householdToday(), note: '', owner: 'shared' },
  );
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(null); // null | 'close' | 'delete' | 'unlink'
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirming]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function requestClose() {
    if (dirty && confirming !== 'close') {
      setConfirming('close');
      return;
    }
    onClose();
  }

  const amount = Number(form.amount);
  const problem =
    form.amount.trim() === '' || !(amount > 0)
      ? 'Enter an amount greater than zero.'
      : !form.from || !form.to
        ? 'Choose both accounts.'
        : form.from === form.to
          ? 'Choose two different accounts.'
          : '';

  // Each call writes or changes both sides at once; an error from the
  // database names what it refused.
  async function run(call) {
    setSaving(true);
    setError('');
    const { error: callError } = await call;
    setSaving(false);
    if (callError) {
      setError(callError.message);
      return false;
    }
    await onSaved();
    return true;
  }

  async function handleSave(e) {
    e.preventDefault();
    if (problem) {
      setError(problem);
      return;
    }
    if (existing) {
      setSaving(true);
      setError('');
      const { error: updateError } = await supabase.rpc('update_transfer', { p_link_id: transfer.link.id, p_amount: amount, p_occurred_at: form.occurred_at, p_note: form.note });
      if (updateError) {
        setSaving(false);
        setError(updateError.message);
        return;
      }
      // update_transfer changes both sides and records nothing, so the
      // history of each side is written here, as the transaction editor writes
      // its own (SHR-323).
      const changes = transferEdits(transfer, amount, form.occurred_at);
      if (changes.length > 0) {
        const { error: historyError } = await supabase.from('transaction_edits').insert(changes);
        if (historyError) {
          setSaving(false);
          setError(`Transfer saved, but its edit history couldn't be recorded: ${historyError.message}`);
          return;
        }
      }
      setSaving(false);
      await onSaved();
      return;
    }
    await run(
      supabase.rpc('record_transfer', {
        p_household_id: householdId,
        p_from_account_id: form.from,
        p_to_account_id: form.to,
        p_amount: amount,
        p_occurred_at: form.occurred_at,
        p_note: form.note,
        p_is_shared: form.owner === 'shared',
        p_owner_member_id: form.owner === 'shared' ? null : form.owner,
      }),
    );
  }

  async function handleUnlink() {
    if (confirming !== 'unlink') {
      setConfirming('unlink');
      return;
    }
    await run(supabase.rpc('unlink_transfer', { p_link_id: transfer.link.id }));
  }

  async function handleDelete() {
    if (confirming !== 'delete') {
      setConfirming('delete');
      return;
    }
    await run(supabase.rpc('delete_transfer', { p_link_id: transfer.link.id }));
  }

  const accountLabel = (a) => accountOptionLabel(a, { members, accounts: selectable });

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={existing ? 'Edit transfer' : 'Add transfer'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{existing ? 'Edit transfer' : 'New entry'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">Transfer between your accounts</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          {!existing && onSwitchType && (
            <div className="te-type">
              {['expense', 'income', 'refund'].map((type) => (
                <button key={type} type="button" className="om-seg" onClick={() => onSwitchType(type)}>
                  {type[0].toUpperCase() + type.slice(1)}
                </button>
              ))}
              <button type="button" className="om-seg" data-active="true">
                Transfer
              </button>
            </div>
          )}

          <p className="ov-muted te-type-note">
            {ENTRY_TYPES.transfer.meaning} {ENTRY_TYPES.transfer.result}
          </p>

          <div>
            <div className="te-hero-label">Amount</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                className="te-hero-input"
                aria-label="Amount"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="te-fieldgrid">
            <label className="te-fieldcell">
              <span className="te-fieldlabel">From</span>
              {/* An existing transfer's accounts stay put; unlink it to move one side. */}
              <select className="te-fieldvalue" aria-label="From account" value={form.from} disabled={existing} onChange={(e) => set('from', e.target.value)}>
                <option value="" disabled>
                  Choose…
                </option>
                {selectable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </label>
            <label className="te-fieldcell">
              <span className="te-fieldlabel">To</span>
              <select className="te-fieldvalue" aria-label="To account" value={form.to} disabled={existing} onChange={(e) => set('to', e.target.value)}>
                <option value="" disabled>
                  Choose…
                </option>
                {selectable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </label>
            <label className="te-fieldcell">
              <span className="te-fieldlabel">Date</span>
              <input className="te-fieldvalue" type="date" value={form.occurred_at} onChange={(e) => set('occurred_at', e.target.value)} />
            </label>
          </div>

          {!existing && (
            <div>
              <span className="te-fieldlabel">Whose money</span>
              <div className="om-scope-list" style={{ marginTop: 10 }}>
                <button type="button" className="om-scope" data-active={form.owner === 'shared'} onClick={() => set('owner', 'shared')}>
                  Shared
                </button>
                {members.map((m) => (
                  <button key={m.id} type="button" className="om-scope" data-active={form.owner === m.id} onClick={() => set('owner', m.id)}>
                    {m.display_name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="te-fieldcell">
            <span className="te-fieldlabel">Note</span>
            <textarea className="te-fieldvalue" rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
          </label>

          {existing && (
            <EditHistory
              records={[
                { id: transfer.out.id, label: `Money out · ${accounts.find((a) => a.id === transfer.out.account_id)?.name ?? 'Unknown account'}` },
                { id: transfer.in.id, label: `Money in · ${accounts.find((a) => a.id === transfer.in.account_id)?.name ?? 'Unknown account'}` },
              ]}
              members={members}
            />
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {existing && (
                <div className="te-actions-left">
                  <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                    {confirming === 'delete' ? 'Delete both sides?' : 'Delete'}
                  </button>
                  <button type="button" className="om-btn" onClick={handleUnlink} disabled={saving}>
                    {confirming === 'unlink' ? 'Make two records?' : 'Unlink'}
                  </button>
                </div>
              )}
              <div className="te-actions-right">
                {confirming === 'close' ? (
                  <>
                    <span className="ov-muted" style={{ marginRight: 8 }}>
                      Discard changes?
                    </span>
                    <button type="button" className="om-btn" onClick={onClose}>
                      Discard
                    </button>
                    <button type="button" className="om-btn" onClick={() => setConfirming(null)}>
                      Keep editing
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="om-btn" onClick={requestClose}>
                      Cancel
                    </button>
                    <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : existing ? 'Save changes' : 'Add transfer'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          {existing && confirming === 'unlink' && (
            <p className="ov-muted" style={{ fontSize: 12 }}>
              Unlinking leaves an expense on the first account and income on the second, each with the change in its history.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
