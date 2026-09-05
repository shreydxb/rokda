import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney, formatPct } from '../../lib/money';
import { firstMatchingRule } from '../../lib/rules';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import './TransactionEditor.css';

export default function Inbox({ household, accounts, categories, data, loading }) {
  const { intake, categoryRules, reload } = data;
  const [selectedId, setSelectedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const pending = intake.filter((i) => i.status === 'pending');
  const selected = pending.find((i) => i.id === selectedId) ?? pending[0] ?? null;

  return (
    <div>
      <div className="ov-muted" style={{ marginTop: 22, marginBottom: 4 }}>
        {pending.length} pending
      </div>
      <div className="ov-empty-body" style={{ maxWidth: '70ch', marginTop: 0, marginBottom: 20 }}>
        Real Telegram intake (receipt photos, voice notes) isn't wired up yet — that needs a bot and a parsing
        pipeline, tracked separately. This reviews whatever lands here, however it lands here.
      </div>

      {pending.length === 0 ? (
        <div className="ov-empty" style={{ marginTop: 0 }}>
          <div className="ov-empty-kicker">Inbox zero</div>
          <div className="ov-empty-body">Nothing waiting on review.</div>
        </div>
      ) : (
        <div className="ov-split" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr)' }}>
          <div className="mn-list">
            {pending.map((i) => (
              <button
                key={i.id}
                type="button"
                className="mn-row"
                data-active={selected?.id === i.id}
                onClick={() => setSelectedId(i.id)}
                style={{ borderLeft: selected?.id === i.id ? '2px solid var(--accent)' : '2px solid transparent', paddingLeft: 8 }}
              >
                <div className="mn-row-main">
                  <div>{i.parsed_merchant || 'Unrecognised merchant'}</div>
                  <div className="ov-muted">
                    {i.source} · {i.confidence !== null ? `${formatPct(i.confidence)} confidence` : 'no confidence score'}
                  </div>
                </div>
                <div className="fig mn-row-amt">{i.parsed_amount !== null ? formatMoney(i.parsed_amount) : '—'}</div>
              </button>
            ))}
          </div>

          {selected && (
            <IntakeReview
              key={selected.id}
              item={selected}
              householdId={household?.id}
              accounts={accounts}
              categories={categories}
              categoryRules={categoryRules}
              saving={saving}
              setSaving={setSaving}
              error={error}
              setError={setError}
              onDone={async () => {
                setSelectedId(null);
                await reload();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function IntakeReview({ item, householdId, accounts, categories, categoryRules, saving, setSaving, error, setError, onDone }) {
  const [amount, setAmount] = useState(item.parsed_amount !== null ? String(item.parsed_amount) : '');
  const [merchant, setMerchant] = useState(item.parsed_merchant ?? '');
  const [date, setDate] = useState(item.parsed_date ?? new Date().toISOString().slice(0, 10));
  // Intake can only be approved onto an open account (QA-01).
  const selectable = selectableAccounts(accounts);
  const [accountId, setAccountId] = useState(selectableAccounts(accounts)[0]?.id ?? '');
  const suggestedRule = item.parsed_category_id ? null : firstMatchingRule(item.parsed_merchant, categoryRules);
  const [categoryId, setCategoryId] = useState(item.parsed_category_id ?? suggestedRule?.category_id ?? '');

  const lowConfidence = item.confidence !== null && item.confidence < 0.75;

  async function approve(e) {
    e.preventDefault();
    if (!amount || Number(amount) <= 0 || !accountId) {
      setError('Amount and account are required.');
      return;
    }
    setSaving(true);
    setError('');
    const { error: txError } = await supabase.from('transactions').insert({
      household_id: householdId,
      account_id: accountId,
      category_id: categoryId || null,
      amount: -Math.abs(Number(amount)),
      currency: 'AED',
      merchant: merchant.trim() || null,
      occurred_at: date,
      is_shared: true,
      needs_review: false,
    });
    if (txError) {
      setSaving(false);
      setError(txError.message);
      return;
    }
    const { error: updError } = await supabase.from('intake').update({ status: 'approved' }).eq('id', item.id);
    setSaving(false);
    if (updError) {
      setError(updError.message);
      return;
    }
    await onDone();
  }

  async function reject() {
    setSaving(true);
    const { error: updError } = await supabase.from('intake').update({ status: 'rejected' }).eq('id', item.id);
    setSaving(false);
    if (updError) {
      setError(updError.message);
      return;
    }
    await onDone();
  }

  return (
    <div>
      <div className="ov-kicker" style={{ marginBottom: 8 }}>
        {lowConfidence ? (
          <span className="ov-warn">Low confidence — confirm against the source</span>
        ) : (
          'Confirm the details'
        )}
      </div>
      {item.raw_text && (
        <div className="ov-muted" style={{ marginBottom: 16, lineHeight: 1.6, fontSize: 12.5 }}>
          "{item.raw_text}"
        </div>
      )}
      <form onSubmit={approve} style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 420 }}>
        <div>
          <div className="te-hero-label">Amount</div>
          <div className="te-hero-row">
            <span className="te-hero-currency">AED</span>
            <input type="number" min="0" step="0.01" className="te-hero-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
        </div>

        <div className="te-fieldgrid">
          <div className="te-fieldcell te-span2">
            <span className="te-fieldlabel">Merchant</span>
            <input className="te-fieldvalue" type="text" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          </div>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Date</span>
            <input className="te-fieldvalue" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Account</span>
            <select className="te-fieldvalue" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {selectable.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountOptionLabel(a, { accounts: selectable })}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <span className="te-fieldlabel">Category</span>
          <div className="te-chips">
            <button type="button" className="om-seg" data-active={categoryId === ''} onClick={() => setCategoryId('')}>
              Uncategorised
            </button>
            {categories
              .filter((c) => !c.archived || c.id === categoryId)
              .map((c) => (
                <button key={c.id} type="button" className="om-seg" data-active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
                  {c.name}
                </button>
              ))}
          </div>
        </div>
        {suggestedRule && categoryId === suggestedRule.category_id && (
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -12 }}>
            Suggested by a rule matching "{suggestedRule.pattern}".
          </div>
        )}

        {error && (
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="om-btn" onClick={reject} disabled={saving}>
            Reject
          </button>
          <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Approve'}
          </button>
        </div>
      </form>
    </div>
  );
}
