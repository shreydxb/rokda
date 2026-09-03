import { useState } from 'react';
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
  const [contribAmount, setContribAmount] = useState('');
  const [contribDate, setContribDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={goal ? 'Edit goal' : 'Add goal'}>
        <div className="te-head">
          <div className="ov-kicker">{goal ? 'Edit goal' : 'Add a goal'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Name</span>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} />
          </label>

          <label className="te-field">
            <span>Note</span>
            <input type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="What this is for" />
          </label>

          <div className="te-row">
            <label className="te-field te-amount">
              <span>Target amount (AED)</span>
              <input type="number" step="0.01" value={form.target_amount} onChange={(e) => set('target_amount', e.target.value)} aria-invalid={!!targetError} />
            </label>
            <label className="te-field te-currency">
              <span>Target date</span>
              <input type="date" value={form.target_date} onChange={(e) => set('target_date', e.target.value)} />
            </label>
          </div>

          <label className="te-field">
            <span>Funding source</span>
            <input
              type="text"
              value={form.funding_source}
              onChange={(e) => set('funding_source', e.target.value)}
              placeholder="e.g. standing transfer of 4,000 into Savings"
            />
          </label>

          <label className="te-field">
            <span>Owner</span>
            <select value={form.owner} onChange={(e) => set('owner', e.target.value)}>
              <option value="shared">Shared</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {goal && (
              <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                {confirmingDelete ? 'Confirm delete?' : 'Delete'}
              </button>
            )}
            <div className="te-actions-right">
              <button type="button" className="om-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </form>

        {goal && (
          <div className="te-form" style={{ paddingTop: 0, borderTop: '1px solid var(--rule)' }}>
            <div className="ov-kicker" style={{ marginTop: 4 }}>
              Contributions
            </div>
            <div className="te-row" style={{ alignItems: 'flex-end' }}>
              <label className="te-field te-amount">
                <span>Amount (AED)</span>
                <input type="number" step="0.01" value={contribAmount} onChange={(e) => setContribAmount(e.target.value)} />
              </label>
              <label className="te-field te-currency">
                <span>Date</span>
                <input type="date" value={contribDate} onChange={(e) => setContribDate(e.target.value)} />
              </label>
              <button type="button" className="om-btn" onClick={handleLogContribution} disabled={saving || !contribAmount}>
                Log
              </button>
            </div>

            {contributions.length === 0 ? (
              <div className="ov-muted" style={{ fontSize: 12.5 }}>
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
      </div>
    </div>
  );
}
