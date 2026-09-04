import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { CADENCES } from '../../lib/recurring';
import './TransactionEditor.css';

function initialForm(item, accounts) {
  if (item) {
    return {
      type: Number(item.amount) >= 0 ? 'income' : 'expense',
      amount: String(Math.abs(Number(item.amount))),
      name: item.name ?? '',
      cadence: item.cadence ?? 'monthly',
      next_due_date: item.next_due_date,
      account_id: item.account_id ?? '',
      category_id: item.category_id ?? '',
      owner: item.is_shared ? 'shared' : (item.owner_member_id ?? ''),
      autopay: !!item.autopay,
      is_fixed: item.is_fixed !== false,
      active: item.active !== false,
    };
  }
  return {
    type: 'expense',
    amount: '',
    name: '',
    cadence: 'monthly',
    next_due_date: new Date().toISOString().slice(0, 10),
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    owner: 'shared',
    autopay: false,
    is_fixed: true,
    active: true,
  };
}

export default function RecurringEditor({ item, householdId, accounts, categories, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(item, accounts));
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmingClose]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  const amountError = form.amount.trim() === '' || Number(form.amount) <= 0 ? 'Enter an amount greater than zero.' : '';
  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const kindCategories = categories.filter((c) => c.kind === form.type && (!c.archived || c.id === form.category_id));

  async function handleSave(e) {
    e.preventDefault();
    if (amountError || nameError) {
      setError(amountError || nameError);
      return;
    }
    setSaving(true);
    setError('');

    const signed = form.type === 'income' ? Math.abs(Number(form.amount)) : -Math.abs(Number(form.amount));
    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      account_id: form.account_id || null,
      category_id: form.category_id || null,
      amount: signed,
      currency: 'AED',
      cadence: form.cadence,
      next_due_date: form.next_due_date,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      autopay: form.autopay,
      is_fixed: form.is_fixed,
      active: form.active,
    };

    const query = item
      ? supabase.from('recurring').update(payload).eq('id', item.id)
      : supabase.from('recurring').insert(payload);

    const { error: saveError } = await query;
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('recurring').delete().eq('id', item.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={item ? 'Edit recurring item' : 'Add recurring item'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{item ? 'Edit commitment' : 'New commitment'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{item ? item.name : 'Add a bill or income'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-type">
            <button type="button" className="om-seg" data-active={form.type === 'expense'} onClick={() => set('type', 'expense')}>
              Bill
            </button>
            <button type="button" className="om-seg" data-active={form.type === 'income'} onClick={() => set('type', 'income')}>
              Expected income
            </button>
          </div>

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
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                aria-invalid={!!amountError}
                placeholder="0"
              />
            </div>
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. Salik top-up" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Cadence</span>
              <select className="te-fieldvalue" value={form.cadence} onChange={(e) => set('cadence', e.target.value)}>
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {c[0].toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Next due date</span>
              <input className="te-fieldvalue" type="date" value={form.next_due_date} onChange={(e) => set('next_due_date', e.target.value)} />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Account</span>
              <select className="te-fieldvalue" value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
                <option value="">Not linked</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Category</span>
            <div className="te-chips">
              <button type="button" className="om-seg" data-active={form.category_id === ''} onClick={() => set('category_id', '')}>
                Uncategorised
              </button>
              {kindCategories.map((c) => (
                <button key={c.id} type="button" className="om-seg" data-active={form.category_id === c.id} onClick={() => set('category_id', c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Paid by</span>
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

          <button type="button" className="te-togglerow" onClick={() => set('autopay', !form.autopay)}>
            <div>
              <div className="te-togglelabel">Autopay</div>
              <div className="te-togglenote">Skip the reminder, still show on the calendar</div>
            </div>
            <span className="te-togglestate">{form.autopay ? 'On' : 'Off'}</span>
          </button>
          <button type="button" className="te-togglerow" onClick={() => set('is_fixed', !form.is_fixed)}>
            <div>
              <div className="te-togglelabel">Fixed amount</div>
              <div className="te-togglenote">Uncheck if this bill varies month to month</div>
            </div>
            <span className="te-togglestate">{form.is_fixed ? 'Fixed' : 'Variable'}</span>
          </button>
          <button type="button" className="te-togglerow" onClick={() => set('active', !form.active)}>
            <div>
              <div className="te-togglelabel">Active</div>
              <div className="te-togglenote">Inactive items drop out of the next-30-days strip</div>
            </div>
            <span className={`te-togglestate ${form.active ? '' : 'te-togglestate-warn'}`}>{form.active ? 'Active' : 'Paused'}</span>
          </button>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {item && (
                <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                  {confirmingDelete ? 'Confirm delete?' : 'Delete'}
                </button>
              )}
              <div className="te-actions-right">
                {confirmingClose ? (
                  <>
                    <span className="ov-muted" style={{ marginRight: 8 }}>
                      Discard changes?
                    </span>
                    <button type="button" className="om-btn" onClick={onClose}>
                      Discard
                    </button>
                    <button type="button" className="om-btn" onClick={() => setConfirmingClose(false)}>
                      Keep editing
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="om-btn" onClick={requestClose}>
                      Cancel
                    </button>
                    <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : item ? 'Save changes' : 'Add commitment'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
