import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

// One source of money once working stops: rent, part-time work, or a one-off
// sum such as an end-of-service gratuity. Amounts are AED in today's money,
// and timing counts from the first year of independence, not a calendar year,
// because the independence year is itself a projection.
function initialForm(row) {
  if (row) {
    return {
      name: row.name,
      note: row.note ?? '',
      kind: row.kind,
      amount: String(row.amount ?? ''),
      starts_after_years: String(row.starts_after_years ?? 0),
      lasts: row.lasts_years == null ? 'forever' : 'years',
      lasts_years: row.lasts_years != null ? String(row.lasts_years) : '',
    };
  }
  return { name: '', note: '', kind: 'yearly', amount: '', starts_after_years: '0', lasts: 'forever', lasts_years: '' };
}

const whole = (v) => /^\d+$/.test(String(v).trim());

export default function IncomeEditor({ row, householdId, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(row));
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

  const yearly = form.kind === 'yearly';
  // The same limits the database enforces, said here in words first.
  const problem =
    form.name.trim() === ''
      ? 'Name it.'
      : !(Number(form.amount) > 0)
        ? 'Enter an amount above zero.'
        : !whole(form.starts_after_years) || Number(form.starts_after_years) > 60
          ? 'Start between 0 and 60 years into independence.'
          : yearly && form.lasts === 'years' && (!whole(form.lasts_years) || Number(form.lasts_years) < 1 || Number(form.lasts_years) > 60)
            ? 'Say how many years it pays, from 1 to 60.'
            : '';

  async function handleSave(e) {
    e.preventDefault();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError('');
    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      note: form.note.trim(),
      kind: form.kind,
      amount: Number(form.amount),
      starts_after_years: Number(form.starts_after_years),
      lasts_years: yearly && form.lasts === 'years' ? Number(form.lasts_years) : null,
      updated_at: new Date().toISOString(),
    };
    const query = row
      ? supabase.from('independence_income').update(payload).eq('id', row.id)
      : supabase.from('independence_income').insert(payload);
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
    const { error: delError } = await supabase.from('independence_income').delete().eq('id', row.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={row ? 'Edit income' : 'Add income'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{row ? 'Edit income' : 'New income'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{row ? row.name : 'Income once working stops'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <span className="te-fieldlabel">What kind</span>
            <div className="om-scope-list" style={{ marginTop: 10 }}>
              <button type="button" className="om-scope" data-active={yearly} onClick={() => set('kind', 'yearly')}>
                Every year
              </button>
              <button type="button" className="om-scope" data-active={!yearly} onClick={() => set('kind', 'lump_sum')}>
                One-off sum
              </button>
            </div>
          </div>

          <div>
            <div className="te-hero-label">{yearly ? 'Amount a year, in today’s money' : 'Amount, in today’s money'}</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input type="number" step="0.01" min="0" className="te-hero-input" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" aria-label="Amount" />
            </div>
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input
                className="te-fieldvalue"
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={yearly ? 'e.g. Flat rent, consulting' : 'e.g. End-of-service gratuity'}
                aria-label="Name"
              />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">{yearly ? 'Starts after (years into independence)' : 'Paid after (years into independence)'}</span>
              <input
                className="te-fieldvalue"
                type="number"
                min="0"
                max="60"
                step="1"
                value={form.starts_after_years}
                onChange={(e) => set('starts_after_years', e.target.value)}
                aria-label="Starts after years"
              />
            </div>
            {yearly && (
              <div className="te-fieldcell te-span2">
                <span className="te-fieldlabel">Pays for</span>
                <div className="om-scope-list" style={{ marginTop: 8 }}>
                  <button type="button" className="om-scope" data-active={form.lasts === 'forever'} onClick={() => set('lasts', 'forever')}>
                    For good
                  </button>
                  <button type="button" className="om-scope" data-active={form.lasts === 'years'} onClick={() => set('lasts', 'years')}>
                    A set number of years
                  </button>
                </div>
                {form.lasts === 'years' && (
                  <input
                    className="te-fieldvalue"
                    style={{ marginTop: 10 }}
                    type="number"
                    min="1"
                    max="60"
                    step="1"
                    value={form.lasts_years}
                    onChange={(e) => set('lasts_years', e.target.value)}
                    placeholder="years"
                    aria-label="Pays for years"
                  />
                )}
              </div>
            )}
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Note</span>
              <input className="te-fieldvalue" type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="optional" />
            </div>
          </div>

          <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            {yearly
              ? 'Income that starts in the first year of independence and pays for good lowers the independence target. The rest is counted year by year on Drawdown.'
              : 'A one-off sum is added to the pot in the year it arrives. It does not change the independence target.'}{' '}
            Enter it after tax.
          </div>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {row && (
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
                      {saving ? 'Saving…' : row ? 'Save changes' : 'Add income'}
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
