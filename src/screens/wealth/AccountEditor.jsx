import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

const TYPES = ['checking', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'other', 'fd'];
const COMPOUNDING = ['simple', 'monthly', 'quarterly', 'half_yearly', 'annually'];

function initialForm(account, defaultType) {
  if (account) {
    return {
      name: account.name,
      type: account.type,
      currency: account.currency ?? 'AED',
      balance: String(account.balance ?? 0),
      owner: account.is_shared ? 'shared' : (account.owner_member_id ?? ''),
      credit_limit: account.credit_limit !== null ? String(account.credit_limit) : '',
      statement_day: account.statement_day !== null ? String(account.statement_day) : '',
      due_day: account.due_day !== null ? String(account.due_day) : '',
      principal: account.principal !== null ? String(account.principal) : '',
      interest_rate_pct: account.interest_rate_pct !== null ? String(account.interest_rate_pct) : '',
      compounding: account.compounding ?? 'simple',
      opened_date: account.opened_date ?? '',
      maturity_date: account.maturity_date ?? '',
    };
  }
  return {
    name: '',
    type: defaultType ?? 'checking',
    currency: 'AED',
    balance: '',
    owner: 'shared',
    credit_limit: '',
    statement_day: '',
    due_day: '',
    principal: '',
    interest_rate_pct: '',
    compounding: 'simple',
    opened_date: '',
    maturity_date: '',
  };
}

export default function AccountEditor({ account, defaultType, householdId, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(account, defaultType));
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

  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const isCard = form.type === 'credit_card';
  const isFd = form.type === 'fd';

  function startNewTerm() {
    setForm((f) => ({
      ...f,
      principal: String(account?.balance ?? f.principal),
      opened_date: new Date().toISOString().slice(0, 10),
      maturity_date: '',
    }));
    setDirty(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      type: form.type,
      currency: form.currency || 'AED',
      balance: Number(form.balance) || 0,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      credit_limit: isCard && form.credit_limit ? Number(form.credit_limit) : null,
      statement_day: isCard && form.statement_day ? Number(form.statement_day) : null,
      due_day: isCard && form.due_day ? Number(form.due_day) : null,
      principal: isFd && form.principal ? Number(form.principal) : null,
      interest_rate_pct: isFd && form.interest_rate_pct ? Number(form.interest_rate_pct) : null,
      compounding: isFd ? form.compounding : null,
      opened_date: isFd && form.opened_date ? form.opened_date : null,
      maturity_date: isFd && form.maturity_date ? form.maturity_date : null,
    };

    const query = account
      ? supabase.from('accounts').update(payload).eq('id', account.id)
      : supabase.from('accounts').insert(payload);

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
    const { error: delError } = await supabase.from('accounts').delete().eq('id', account.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={account ? 'Edit account' : 'Add account'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{account ? 'Edit account' : 'New account'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{account ? account.name : 'Add an account'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">{isCard ? 'Balance owed' : isFd ? 'Current value (auto-calculated)' : 'Current balance'}</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">{form.currency || 'AED'}</span>
              {isFd ? (
                <span className="te-hero-input" style={{ display: 'flex', alignItems: 'center' }}>
                  {account ? Number(account.balance).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                </span>
              ) : (
                <input type="number" step="0.01" className="te-hero-input" value={form.balance} onChange={(e) => set('balance', e.target.value)} placeholder="0" />
              )}
            </div>
            {isFd && (
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                Computed daily from principal, rate and dates below — never edited directly.
              </div>
            )}
          </div>

          {isFd && account?.fd_status === 'matured' && (
            <div className="ov-warn" role="alert" style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span>This FD has matured at {Number(account.balance).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Roll it into a new term?</span>
              <button type="button" className="om-btn" onClick={startNewTerm}>
                Start new term
              </button>
            </div>
          )}

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. ADCB Savings" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Type</span>
              <select className="te-fieldvalue" value={form.type} onChange={(e) => set('type', e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Currency</span>
              <input className="te-fieldvalue" type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </div>
            {isCard && (
              <>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Credit limit</span>
                  <input className="te-fieldvalue" type="number" step="0.01" value={form.credit_limit} onChange={(e) => set('credit_limit', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Statement day</span>
                  <input className="te-fieldvalue" type="number" min="1" max="31" value={form.statement_day} onChange={(e) => set('statement_day', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Due day</span>
                  <input className="te-fieldvalue" type="number" min="1" max="31" value={form.due_day} onChange={(e) => set('due_day', e.target.value)} />
                </div>
              </>
            )}
            {isFd && (
              <>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Principal</span>
                  <input className="te-fieldvalue" type="number" step="0.01" value={form.principal} onChange={(e) => set('principal', e.target.value)} placeholder="e.g. 100000" />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Interest rate (annual %)</span>
                  <input className="te-fieldvalue" type="number" step="0.01" value={form.interest_rate_pct} onChange={(e) => set('interest_rate_pct', e.target.value)} placeholder="e.g. 4.5" />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Compounding</span>
                  <select className="te-fieldvalue" value={form.compounding} onChange={(e) => set('compounding', e.target.value)}>
                    {COMPOUNDING.map((c) => (
                      <option key={c} value={c}>
                        {c === 'simple' ? 'Simple (paid at maturity)' : c.replace('_', '-')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Opened</span>
                  <input className="te-fieldvalue" type="date" value={form.opened_date} onChange={(e) => set('opened_date', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Maturity date</span>
                  <input className="te-fieldvalue" type="date" value={form.maturity_date} onChange={(e) => set('maturity_date', e.target.value)} />
                </div>
              </>
            )}
          </div>

          <div>
            <span className="te-fieldlabel">Owner</span>
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

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {account && (
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
                      {saving ? 'Saving…' : account ? 'Save changes' : 'Add account'}
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
