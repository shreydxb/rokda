import { useEffect, useId, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { DEFAULT_INFLATION_PCT, accountCanBackGoal, goalCostAtDate } from '../../lib/goals';
import { householdToday, parseDay } from '../../lib/day';
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
      cost_today: !!goal.cost_today,
      inflation_pct: goal.inflation_pct != null ? String(Number(goal.inflation_pct)) : '',
      priority: goal.priority != null ? String(goal.priority) : '',
    };
  }
  return { name: '', note: '', target_amount: '', target_date: '', funding_source: '', owner: 'shared', cost_today: false, inflation_pct: '', priority: '' };
}

const dayLabel = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// The database's own wording for a link it refuses names neither the account
// nor what to do instead.
function linkErrorMessage(err) {
  if (err?.code === '23514' && /exceed 100%/.test(err.message ?? '')) {
    const already = /already ([\d.]+)/.exec(err.message)?.[1];
    return `That would link more than 100% of it to goals${already ? `: ${Number(already)}% is already linked to other goals` : ''}. Lower the share.`;
  }
  if (err?.code === '23505') return 'This goal already links it. Change the share on its row instead.';
  return err?.message ?? 'That did not save.';
}

const shareProblem = (text) => {
  const pct = Number(text);
  return Number.isFinite(pct) && pct > 0 && pct <= 100 ? '' : 'A share from 1 to 100%.';
};

// The goal's own fields are one form. Logging a contribution and linking an
// account are forms of their own beside it, so Enter in their fields does
// their action rather than saving the goal, and they keep the drawer open:
// the goal's unsaved edits stay where they were.
export default function GoalEditor({ goal, contributions, allocations, accounts, holdings, householdId, members, inflationPct = DEFAULT_INFLATION_PCT, onClose, onSaved, onChanged = onSaved }) {
  const uid = useId();
  const ids = {
    form: `${uid}-goal`,
    name: `${uid}-name`,
    date: `${uid}-date`,
    note: `${uid}-note`,
    priority: `${uid}-priority`,
    funding: `${uid}-funding`,
    rate: `${uid}-rate`,
    owner: `${uid}-owner`,
    error: `${uid}-error`,
    contribAmount: `${uid}-camount`,
    contribDate: `${uid}-cdate`,
    linkSource: `${uid}-lsource`,
    linkShare: `${uid}-lshare`,
  };
  const [form, setForm] = useState(() => initialForm(goal));
  const [dirty, setDirty] = useState(false);
  // Fields are marked wrong only once a save has been tried, not on opening.
  const [triedSave, setTriedSave] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [contribAmount, setContribAmount] = useState('');
  const [contribDate, setContribDate] = useState(() => householdToday());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(null);
  const [error, setError] = useState('');
  // The outcome of the last contribution or link action, shown in its own section.
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const linked = allocations ?? [];
  const linkedAccountIds = new Set(linked.map((a) => a.account_id).filter(Boolean));
  const linkedHoldingIds = new Set(linked.map((a) => a.holding_id).filter(Boolean));
  // An account already linked keeps its row, where its share is changed.
  const linkableAccounts = (accounts ?? []).filter((a) => accountCanBackGoal(a) && !linkedAccountIds.has(a.id));
  const linkableHoldings = (holdings ?? []).filter((h) => !linkedHoldingIds.has(h.id));
  const sourceOptions = [...linkableAccounts.map((a) => `account:${a.id}`), ...linkableHoldings.map((h) => `holding:${h.id}`)];
  const [sourceChoice, setSourceChoice] = useState('');
  const allocSource = sourceOptions.includes(sourceChoice) ? sourceChoice : (sourceOptions[0] ?? '');
  const [allocSharePct, setAllocSharePct] = useState('100');
  const [shareEdits, setShareEdits] = useState({});

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
  const rateText = String(form.inflation_pct).trim();
  const priorityText = String(form.priority).trim();
  const rateError = form.cost_today && rateText !== '' && !(Number.isFinite(Number(rateText)) && Number(rateText) >= -10 && Number(rateText) <= 30) ? 'A yearly rise between −10% and 30%.' : '';
  const priorityError = priorityText !== '' && !(/^\d+$/.test(priorityText) && Number(priorityText) >= 1 && Number(priorityText) <= 999) ? 'Priority is a whole number from 1.' : '';
  const invalid = (problem) => (triedSave && problem ? { 'aria-invalid': true, 'aria-describedby': ids.error } : { 'aria-invalid': false });
  // What a today's cost comes to on the date, shown while it is being typed.
  const costOnDate =
    form.cost_today && form.target_date && Number(form.target_amount) > 0 && !rateError
      ? goalCostAtDate({ target_amount: form.target_amount, target_date: form.target_date, cost_today: true, inflation_pct: rateText === '' ? null : rateText }, new Date(), inflationPct)
      : null;

  async function handleSave(e) {
    e.preventDefault();
    if (nameError || targetError || rateError || priorityError) {
      setTriedSave(true);
      setError(nameError || targetError || rateError || priorityError);
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
      cost_today: form.cost_today,
      inflation_pct: form.cost_today && rateText !== '' ? Number(rateText) : null,
      priority: priorityText === '' ? null : Number(priorityText),
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

  // Runs one write for the Contributions or Linked section, reports its
  // outcome there, and reloads the records without closing the drawer.
  async function act(section, write, done) {
    setSaving(true);
    setNotice(null);
    const { error: writeError } = await write();
    setSaving(false);
    if (writeError) {
      setNotice({ section, error: true, text: section === 'linked' ? linkErrorMessage(writeError) : writeError.message });
      return false;
    }
    setNotice({ section, error: false, text: done });
    await onChanged();
    return true;
  }

  async function handleLogContribution(e) {
    e.preventDefault();
    const amount = Number(contribAmount);
    if (!(amount > 0) || !contribDate) {
      setNotice({ section: 'contributions', error: true, text: !contribDate ? 'Pick the day it was put aside.' : 'An amount above zero.' });
      return;
    }
    const ok = await act('contributions', () => supabase.from('goal_contributions').insert({ goal_id: goal.id, amount, occurred_at: contribDate }), `Logged ${formatMoney(amount)} on ${dayLabel(contribDate)}.`);
    if (ok) setContribAmount('');
  }

  async function handleRemove(kind, id) {
    if (confirmingRemove?.kind !== kind || confirmingRemove?.id !== id) {
      setConfirmingRemove({ kind, id });
      return;
    }
    const table = kind === 'contribution' ? 'goal_contributions' : 'goal_allocations';
    const ok = await act(kind === 'contribution' ? 'contributions' : 'linked', () => supabase.from(table).delete().eq('id', id), kind === 'contribution' ? 'Contribution removed.' : 'Link removed.');
    if (ok) setConfirmingRemove(null);
  }

  async function handleAddAllocation(e) {
    e.preventDefault();
    const problem = shareProblem(allocSharePct);
    if (!allocSource || problem) {
      setNotice({ section: 'linked', error: true, text: problem || 'Pick an account or holding.' });
      return;
    }
    const [kind, id] = allocSource.split(':');
    const label = kind === 'account' ? (accounts ?? []).find((a) => a.id === id)?.name : (holdings ?? []).find((h) => h.id === id)?.name;
    const pct = Number(allocSharePct);
    const ok = await act(
      'linked',
      () =>
        supabase.from('goal_allocations').insert({
          household_id: householdId,
          goal_id: goal.id,
          account_id: kind === 'account' ? id : null,
          holding_id: kind === 'holding' ? id : null,
          share_pct: pct,
        }),
      `Linked ${label ?? 'it'} at ${pct}%.`,
    );
    if (ok) setAllocSharePct('100');
  }

  async function handleShareChange(e, allocation) {
    e.preventDefault();
    const text = shareEdits[allocation.id];
    // Enter on a share left as it was changes nothing.
    if (text === undefined || Number(text) === Number(allocation.share_pct)) return;
    const problem = shareProblem(text);
    if (problem) {
      setNotice({ section: 'linked', error: true, text: problem });
      return;
    }
    const ok = await act('linked', () => supabase.from('goal_allocations').update({ share_pct: Number(text) }).eq('id', allocation.id), `${allocationLabel(allocation)} now counts at ${Number(text)}%.`);
    if (ok)
      setShareEdits((edits) => {
        const next = { ...edits };
        delete next[allocation.id];
        return next;
      });
  }

  function allocationLabel(a) {
    if (a.account_id) return (accounts ?? []).find((acc) => acc.id === a.account_id)?.name ?? 'Unknown account';
    return (holdings ?? []).find((h) => h.id === a.holding_id)?.name ?? 'Unknown holding';
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

  const sectionNotice = (section) =>
    notice?.section === section && (
      <p className={notice.error ? 'ov-warn' : 'ov-muted'} role={notice.error ? 'alert' : 'status'} style={{ fontSize: 12.5, marginTop: 12 }}>
        {notice.text}
      </p>
    );

  const removeControls = (kind, id, what) =>
    confirmingRemove?.kind === kind && confirmingRemove?.id === id ? (
      <>
        <button type="button" className="ov-link te-rowaction" onClick={() => handleRemove(kind, id)} disabled={saving}>
          Confirm remove
        </button>
        <button type="button" className="ov-link te-rowaction" onClick={() => setConfirmingRemove(null)}>
          Keep
        </button>
      </>
    ) : (
      <button type="button" className="ov-link te-rowaction" onClick={() => handleRemove(kind, id)} disabled={saving} aria-label={`Remove ${what}`}>
        Remove
      </button>
    );

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

        <div className="te-form">
          <form id={ids.form} className="te-part" onSubmit={handleSave}>
            <div>
              <div className="te-hero-label">Target</div>
              <div className="te-hero-row">
                <span className="te-hero-currency">AED</span>
                <input type="number" step="0.01" className="te-hero-input" value={form.target_amount} onChange={(e) => set('target_amount', e.target.value)} aria-label="Target, AED" placeholder="0" {...invalid(targetError)} />
              </div>
              <div className="om-scope-list" role="group" aria-label="How the target is set" style={{ marginTop: 12 }}>
                <button type="button" className="om-scope" data-active={!form.cost_today} aria-pressed={!form.cost_today} onClick={() => set('cost_today', false)}>
                  Amount on the date
                </button>
                <button type="button" className="om-scope" data-active={form.cost_today} aria-pressed={form.cost_today} onClick={() => set('cost_today', true)}>
                  Today&rsquo;s cost
                </button>
              </div>
              {form.cost_today && (
                <div className="te-fieldcell" style={{ marginTop: 12 }}>
                  <label className="te-fieldlabel" htmlFor={ids.rate}>
                    Rises by · % a year
                  </label>
                  <input
                    id={ids.rate}
                    className="te-fieldvalue"
                    type="number"
                    step="0.1"
                    value={form.inflation_pct}
                    onChange={(e) => set('inflation_pct', e.target.value)}
                    placeholder={`blank: ${inflationPct}%, general inflation`}
                    aria-label="Rises by, percent a year"
                    {...invalid(rateError)}
                  />
                  <span className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    {costOnDate !== null
                      ? `About ${formatMoney(costOnDate)} by ${form.target_date.slice(0, 4)}, the amount progress is measured against.`
                      : 'Set a date to see what it will cost then. Education and medical costs often rise faster than prices in general.'}
                  </span>
                </div>
              )}
            </div>

            <div className="te-fieldgrid">
              <div className="te-fieldcell te-span2">
                <label className="te-fieldlabel" htmlFor={ids.name}>
                  Name
                </label>
                <input id={ids.name} className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Japan trip" {...invalid(nameError)} />
              </div>
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={ids.date}>
                  Target date
                </label>
                <input id={ids.date} className="te-fieldvalue" type="date" value={form.target_date} onChange={(e) => set('target_date', e.target.value)} />
              </div>
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={ids.note}>
                  Note
                </label>
                <input id={ids.note} className="te-fieldvalue" type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="What this is for" />
              </div>
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={ids.priority}>
                  Priority
                </label>
                <input id={ids.priority} className="te-fieldvalue" type="number" step="1" value={form.priority} onChange={(e) => set('priority', e.target.value)} placeholder="1 = first" {...invalid(priorityError)} />
              </div>
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={ids.funding}>
                  Funding source
                </label>
                <input
                  id={ids.funding}
                  className="te-fieldvalue"
                  type="text"
                  value={form.funding_source}
                  onChange={(e) => set('funding_source', e.target.value)}
                  placeholder="e.g. standing transfer of 4,000 into Savings"
                />
              </div>
            </div>

            <div>
              <span className="te-fieldlabel" id={ids.owner}>
                Owner
              </span>
              <div className="om-scope-list" role="group" aria-labelledby={ids.owner} style={{ marginTop: 10 }}>
                <button type="button" className="om-scope" data-active={form.owner === 'shared'} aria-pressed={form.owner === 'shared'} onClick={() => set('owner', 'shared')}>
                  Shared
                </button>
                {members.map((m) => (
                  <button key={m.id} type="button" className="om-scope" data-active={form.owner === m.id} aria-pressed={form.owner === m.id} onClick={() => set('owner', m.id)}>
                    {m.display_name}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <p className="ov-warn" role="alert" id={ids.error} style={{ fontSize: 12.5 }}>
                {error}
              </p>
            )}
          </form>

          {goal && (
            <section className="te-section" aria-labelledby={`${uid}-contrib-head`}>
              <h3 className="ov-kicker te-section-head" id={`${uid}-contrib-head`}>
                Contributions
              </h3>
              <form onSubmit={handleLogContribution}>
                <div className="te-fieldgrid">
                  <div className="te-fieldcell">
                    <label className="te-fieldlabel" htmlFor={ids.contribAmount}>
                      Amount (AED)
                    </label>
                    <input id={ids.contribAmount} className="te-fieldvalue" type="number" step="0.01" value={contribAmount} onChange={(e) => setContribAmount(e.target.value)} />
                  </div>
                  <div className="te-fieldcell">
                    <label className="te-fieldlabel" htmlFor={ids.contribDate}>
                      Date
                    </label>
                    <input id={ids.contribDate} className="te-fieldvalue" type="date" value={contribDate} onChange={(e) => setContribDate(e.target.value)} />
                  </div>
                </div>
                <div className="te-subactions">
                  <button type="submit" className="om-btn" disabled={saving || !contribAmount}>
                    Log contribution
                  </button>
                </div>
              </form>
              {sectionNotice('contributions')}

              {contributions.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                  No contributions logged yet.
                </div>
              ) : (
                <div className="mn-list">
                  {contributions.map((c) => (
                    <div key={c.id} className="mn-row" style={{ cursor: 'default' }}>
                      <div className="mn-row-main">{dayLabel(c.occurred_at)}</div>
                      <div className="te-rowcontrols">
                        <span className="fig mn-row-amt">{formatMoney(c.amount)}</span>
                        {removeControls('contribution', c.id, `the contribution of ${formatMoney(c.amount)} on ${dayLabel(c.occurred_at)}`)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {goal && (sourceOptions.length > 0 || linked.length > 0) && (
            <section className="te-section" aria-labelledby={`${uid}-linked-head`}>
              <h3 className="ov-kicker te-section-head" id={`${uid}-linked-head`} style={{ marginBottom: 4 }}>
                Linked accounts &amp; holdings
              </h3>
              <div className="ov-muted" style={{ fontSize: 11.5, marginBottom: 12, lineHeight: 1.5 }}>
                Earmark a share of a real account or holding toward this goal — its current value (interest or growth included)
                counts toward progress automatically. One account/holding can be split across several goals as long as its shares
                never add up past 100%. Loans and cards can&rsquo;t be linked: what they hold is owed.
              </div>
              {sourceOptions.length > 0 && (
                <form onSubmit={handleAddAllocation}>
                  <div className="te-fieldgrid">
                    <div className="te-fieldcell te-span2">
                      <label className="te-fieldlabel" htmlFor={ids.linkSource}>
                        Account / holding
                      </label>
                      <select id={ids.linkSource} className="te-fieldvalue" value={allocSource} onChange={(e) => setSourceChoice(e.target.value)}>
                        {linkableAccounts.length > 0 && (
                          <optgroup label="Accounts">
                            {linkableAccounts.map((a) => (
                              <option key={a.id} value={`account:${a.id}`}>
                                {a.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {linkableHoldings.length > 0 && (
                          <optgroup label="Holdings">
                            {linkableHoldings.map((h) => (
                              <option key={h.id} value={`holding:${h.id}`}>
                                {h.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                    <div className="te-fieldcell">
                      <label className="te-fieldlabel" htmlFor={ids.linkShare}>
                        Share %
                      </label>
                      <input id={ids.linkShare} className="te-fieldvalue" type="number" min="1" max="100" step="1" value={allocSharePct} onChange={(e) => setAllocSharePct(e.target.value)} />
                    </div>
                  </div>
                  <div className="te-subactions">
                    <button type="submit" className="om-btn" disabled={saving || !allocSource}>
                      Link
                    </button>
                  </div>
                </form>
              )}
              {sectionNotice('linked')}

              {linked.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                  Nothing linked yet — this goal's progress is only from logged contributions.
                </div>
              ) : (
                <div className="mn-list">
                  {linked.map((a) => {
                    const label = allocationLabel(a);
                    const stored = String(Number(a.share_pct));
                    const shown = shareEdits[a.id] ?? stored;
                    return (
                      <form key={a.id} className="mn-row" style={{ cursor: 'default' }} onSubmit={(e) => handleShareChange(e, a)}>
                        <div className="mn-row-main">{label}</div>
                        <div className="te-rowcontrols">
                          <input
                            className="te-fieldvalue te-shareinput"
                            type="number"
                            min="1"
                            max="100"
                            step="1"
                            value={shown}
                            onChange={(e) => setShareEdits((edits) => ({ ...edits, [a.id]: e.target.value }))}
                            aria-label={`Share of ${label}, percent`}
                          />
                          <span className="fig">%</span>
                          {shown !== stored && (
                            <button type="submit" className="om-btn" disabled={saving}>
                              Update
                            </button>
                          )}
                          {removeControls('allocation', a.id, `the link to ${label}`)}
                        </div>
                      </form>
                    );
                  })}
                </div>
              )}
            </section>
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
                    <button type="submit" form={ids.form} className="om-btn ov-btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : goal ? 'Save changes' : 'Add goal'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
