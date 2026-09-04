import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import '../money/TransactionEditor.css';

function initialForm(goal) {
  if (goal) {
    return {
      name: goal.name,
      note: goal.note ?? '',
      target_amount: String(goal.target_amount ?? ''),
      target_date: goal.target_date ?? '',
      funding_source: goal.funding_source ?? '',
      owner: goal.is_shared ? 'shared' : (goal.owner_member_id ?? ''),
    };
  }
  return { name: '', note: '', target_amount: '', target_date: '', funding_source: '', owner: 'shared' };
}

export default function GoalEditor({ goal, contributions, householdId, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(goal));
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [contribAmount, setContribAmount] = useState('');
  const [contribDate, setContribDate] = useState(() => new Date().toISOString().slice(0, 10));
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
  const targetError = !form.target_amount || Number(form.target_amount) <= 0 ? 'Set a target above zero.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError || targetError) {
      setError(nameError || targetError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      note: form.note.trim(),
      target_amount: Number(form.target_amount),
      target_date: form.target_date || null,
      funding_source: form.funding_source.trim(),
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
    };

    const query = goal ? supabase.from('goals').update(payload).eq('id', goal.id) : supabase.from('goals').insert(payload);
    const { error: saveError } = await query;
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function handleLogContribution() {
    const amount = Number(contribAmount);
    if (!amount || amount <= 0 || !contribDate) return;
    setSaving(true);
    setError('');
    const { error: contribError } = await supabase
      .from('goal_contributions')
      .insert({ goal_id: goal.id, amount, occurred_at: contribDate });
    setSaving(false);
    if (contribError) {
      setError(contribError.message);
      return;
    }
    setContribAmount('');
    await onSaved();
  }

  async function handleDeleteContribution(id) {
    setSaving(true);
    await supabase.from('goal_contributions').delete().eq('id', id);
    setSaving(false);
    await onSaved();
  }

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('goals').delete().eq('id', goal.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={goal ? 'Edit goal' : 'Add goal'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{goal ? 'Edit goal' : 'New goal'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{goal ? goal.name : 'Add a goal'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">Target</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input type="number" step="0.01" className="te-hero-input" value={form.target_amount} onChange={(e) => set('target_amount', e.target.value)} aria-invalid={!!targetError} placeholder="0" />
            </div>
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. Japan trip" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Target date</span>
              <input className="te-fieldvalue" type="date" value={form.target_date} onChange={(e) => set('target_date', e.target.value)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Note</span>
              <input className="te-fieldvalue" type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="What this is for" />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Funding source</span>
              <input
                className="te-fieldvalue"
                type="text"
                value={form.funding_source}
                onChange={(e) => set('funding_source', e.target.value)}
                placeholder="e.g. standing transfer of 4,000 into Savings"
              />
            </div>
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

          {goal && (
            <div style={{ borderTop: '1px solid var(--rule2)', paddingTop: 18, marginTop: 6 }}>
              <div className="ov-kicker" style={{ marginBottom: 12 }}>
                Contributions
              </div>
              <div className="te-fieldgrid" style={{ alignItems: 'flex-end' }}>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Amount (AED)</span>
                  <input className="te-fieldvalue" type="number" step="0.01" value={contribAmount} onChange={(e) => setContribAmount(e.target.value)} />
                </div>
                <div className="te-fieldcell" style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div className="te-fieldlabel">Date</div>
                    <input className="te-fieldvalue" type="date" value={contribDate} onChange={(e) => setContribDate(e.target.value)} />
                  </div>
                  <button type="button" className="om-btn" onClick={handleLogContribution} disabled={saving || !contribAmount}>
                    Log
                  </button>
                </div>
              </div>

              {contributions.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                  No contributions logged yet.
                </div>
              ) : (
                <div className="mn-list">
                  {contributions.map((c) => (
                    <div key={c.id} className="mn-row" style={{ cursor: 'default' }}>
                      <div className="mn-row-main">{new Date(c.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="fig mn-row-amt">{formatMoney(c.amount)}</span>
                        <button type="button" className="ov-link" style={{ fontSize: 11.5 }} onClick={() => handleDeleteContribution(c.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {goal && (
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
                      {saving ? 'Saving…' : goal ? 'Save changes' : 'Add goal'}
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
