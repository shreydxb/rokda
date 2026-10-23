import { useEffect, useId, useRef, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { DEFAULT_INFLATION_PCT, accountCanBackGoal, goalCostAtDate } from '../../lib/goals';
import { isArchived } from '../../lib/accounts';
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
      kept: goal.counts_in_life_plan === false,
    };
  }
  return { name: '', note: '', target_amount: '', target_date: '', funding_source: '', owner: 'shared', cost_today: false, inflation_pct: '', priority: '', kept: false };
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

// The database takes any share above 0 and up to 100, fractions included.
const shareProblem = (text) => {
  const pct = Number(text);
  return String(text ?? '').trim() !== '' && Number.isFinite(pct) && pct > 0 && pct <= 100 ? '' : 'A share above 0 and up to 100%.';
};

// Why a link made before loans, cards and closed accounts were refused now counts for nothing.
function linkCountsAsNothing(account) {
  if (!account) return 'the account is gone';
  if (isArchived(account)) return 'the account is closed';
  if (account.type === 'loan') return 'a loan is owed, not saved';
  return 'a card is owed, not saved';
}

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
    contribAmount: `${uid}-camount`,
    contribDate: `${uid}-cdate`,
    linkSource: `${uid}-lsource`,
    linkShare: `${uid}-lshare`,
  };
  const fieldRefs = useRef({});
  const removeRefs = useRef({});
  const shareRefs = useRef({});
  const headingRefs = useRef({});
  const drawerRef = useDrawerFocus();
  const [form, setForm] = useState(() => initialForm(goal));
  const [dirty, setDirty] = useState(false);
  // Fields are marked wrong only once a save has been tried, not on opening.
  const [triedSave, setTriedSave] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [contribAmount, setContribAmount] = useState('');
  const [contribDate, setContribDate] = useState(() => householdToday());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(null);
  // A save or delete that failed, or why a save was refused; shown by the buttons.
  const [formError, setFormError] = useState('');
  // The outcome of the last contribution or link action, shown in its own section.
  const [notice, setNotice] = useState(null);
  // Held from a write until the reload after it lands, so a second press can't
  // send it again while the drawer still shows the old records.
  const [saving, setSaving] = useState(false);
  const linked = allocations ?? [];
  const findAccount = (id) => (accounts ?? []).find((a) => a.id === id);
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

  function allocationLabel(a) {
    if (a.account_id) return findAccount(a.account_id)?.name ?? 'Unknown account';
    return (holdings ?? []).find((h) => h.id === a.holding_id)?.name ?? 'Unknown holding';
  }

  // Typed but not yet logged or updated counts as unsaved too: Save would
  // drop it, and so would closing.
  const pendingShare = linked.find((a) => shareEdits[a.id] !== undefined && Number(shareEdits[a.id]) !== Number(a.share_pct));
  const pendingWork =
    contribAmount.trim() !== '' ? `Log or clear the contribution of ${contribAmount.trim()} first.` : pendingShare ? `Update or undo the share on ${allocationLabel(pendingShare)} first.` : '';
  const unsaved = dirty || pendingWork !== '';

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Escape steps back out of a pending confirmation before it closes anything.
      if (confirmingRemove) cancelRemove();
      else if (confirmingDelete) setConfirmingDelete(false);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsaved, confirmingClose, confirmingRemove, confirmingDelete]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function requestClose() {
    if (unsaved && !confirmingClose) {
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
  // Each field carries its own message once a save has been tried, and the
  // message follows the field as it is corrected.
  const fieldProblems = { target: targetError, rate: rateError, name: nameError, priority: priorityError };
  const invalid = (key) => (triedSave && fieldProblems[key] ? { 'aria-invalid': true, 'aria-describedby': `${uid}-${key}-problem` } : { 'aria-invalid': false });
  const problemText = (key) =>
    triedSave &&
    fieldProblems[key] && (
      <span className="te-fieldproblem" id={`${uid}-${key}-problem`}>
        {fieldProblems[key]}
      </span>
    );
  // What a today's cost comes to on the date, shown while it is being typed.
  const costOnDate =
    form.cost_today && form.target_date && Number(form.target_amount) > 0 && !rateError
      ? goalCostAtDate({ target_amount: form.target_amount, target_date: form.target_date, cost_today: true, inflation_pct: rateText === '' ? null : rateText }, new Date(), inflationPct)
      : null;

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    setNotice(null);
    const firstProblem = ['target', 'rate', 'name', 'priority'].find((key) => fieldProblems[key]);
    if (firstProblem) {
      setTriedSave(true);
      setFormError('Fix the marked field to save.');
      fieldRefs.current[firstProblem]?.focus();
      return;
    }
    if (pendingWork) {
      setFormError(pendingWork);
      return;
    }
    setSaving(true);
    setFormError('');

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
      // Kept money, an emergency fund, is never paid out of the Life plan's
      // pot. Only the Life plan could set this (Planning audit, 1.6).
      counts_in_life_plan: !form.kept,
    };

    const query = goal ? supabase.from('goals').update(payload).eq('id', goal.id) : supabase.from('goals').insert(payload);
    const { error: saveError } = await query;
    setSaving(false);
    if (saveError) {
      setFormError(saveError.message);
      return;
    }
    await onSaved();
  }

  // Runs one write for the Contributions or Linked section and reports its
  // outcome there. What was typed clears as soon as the write lands; the
  // records then reload without closing the drawer. Focus stays put unless
  // what held it went away, in which case it goes to the section's heading.
  async function act(section, write, { written, done }) {
    if (saving) return false;
    setSaving(true);
    setNotice(null);
    try {
      const { error: writeError } = await write();
      if (writeError) {
        setNotice({ section, error: true, text: section === 'linked' ? linkErrorMessage(writeError) : writeError.message });
        return false;
      }
      written?.();
      setNotice({ section, error: false, text: done });
      await onChanged();
      return true;
    } finally {
      setSaving(false);
      (window.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0)))(() => {
        if (drawerRef.current && !drawerRef.current.contains(document.activeElement)) headingRefs.current[section]?.focus();
      });
    }
  }

  async function handleLogContribution(e) {
    e.preventDefault();
    if (saving) return;
    const amount = Number(contribAmount);
    if (!(amount > 0) || !contribDate) {
      setNotice({ section: 'contributions', error: true, text: !contribDate ? 'Pick the day it was put aside.' : 'An amount above zero.' });
      return;
    }
    await act('contributions', () => supabase.from('goal_contributions').insert({ goal_id: goal.id, amount, occurred_at: contribDate }), {
      written: () => setContribAmount(''),
      done: `Logged ${formatMoney(amount)} on ${dayLabel(contribDate)}.`,
    });
  }

  function cancelRemove() {
    const key = confirmingRemove && `${confirmingRemove.kind}:${confirmingRemove.id}`;
    setConfirmingRemove(null);
    if (key) removeRefs.current[key]?.focus();
  }

  async function handleRemove(kind, id) {
    if (saving) return;
    if (confirmingRemove?.kind !== kind || confirmingRemove?.id !== id) {
      setConfirmingRemove({ kind, id });
      return;
    }
    const table = kind === 'contribution' ? 'goal_contributions' : 'goal_allocations';
    await act(kind === 'contribution' ? 'contributions' : 'linked', () => supabase.from(table).delete().eq('id', id), {
      written: () => setConfirmingRemove(null),
      done: kind === 'contribution' ? 'Contribution removed.' : 'Link removed.',
    });
  }

  async function handleAddAllocation(e) {
    e.preventDefault();
    if (saving) return;
    const problem = shareProblem(allocSharePct);
    if (!allocSource || problem) {
      setNotice({ section: 'linked', error: true, text: problem || 'Pick an account or holding.' });
      return;
    }
    const [kind, id] = allocSource.split(':');
    const label = kind === 'account' ? findAccount(id)?.name : (holdings ?? []).find((h) => h.id === id)?.name;
    const pct = Number(allocSharePct);
    await act(
      'linked',
      () =>
        supabase.from('goal_allocations').insert({
          household_id: householdId,
          goal_id: goal.id,
          account_id: kind === 'account' ? id : null,
          holding_id: kind === 'holding' ? id : null,
          share_pct: pct,
        }),
      { written: () => setAllocSharePct('100'), done: `Linked ${label ?? 'it'} at ${pct}%.` },
    );
  }

  async function handleShareChange(e, allocation) {
    e.preventDefault();
    if (saving) return;
    const text = shareEdits[allocation.id];
    // Enter on a share left as it was changes nothing.
    if (text === undefined || Number(text) === Number(allocation.share_pct)) return;
    const problem = shareProblem(text);
    if (problem) {
      setNotice({ section: 'linked', error: true, text: problem });
      return;
    }
    await act('linked', () => supabase.from('goal_allocations').update({ share_pct: Number(text) }).eq('id', allocation.id), {
      written: () =>
        setShareEdits((edits) => {
          const next = { ...edits };
          delete next[allocation.id];
          return next;
        }),
      done: `${allocationLabel(allocation)} now counts at ${Number(text)}%.`,
    });
    shareRefs.current[allocation.id]?.focus();
  }

  async function handleDelete() {
    if (saving) return;
    setNotice(null);
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('goals').delete().eq('id', goal.id);
    setSaving(false);
    if (delError) {
      setFormError(delError.message);
      return;
    }
    await onSaved();
  }

  // A section's messages. The status line is always in the page, so a screen
  // reader hears it change; a failure is an alert, which is read when it appears.
  const sectionMessages = (section) => {
    const mine = notice?.section === section ? notice : null;
    return (
      <>
        <p className="ov-muted te-status" role="status">
          {mine && !mine.error ? mine.text : ''}
        </p>
        {mine?.error && (
          <p className="ov-warn te-status" role="alert">
            {mine.text}
          </p>
        )}
      </>
    );
  };

  // One Remove button per row: asking to confirm changes its words rather
  // than swapping it for another button, so focus stays on it.
  const removeControls = (kind, id, what) => {
    const key = `${kind}:${id}`;
    const confirming = confirmingRemove?.kind === kind && confirmingRemove?.id === id;
    return (
      <>
        <button
          ref={(el) => {
            removeRefs.current[key] = el;
          }}
          type="button"
          className={`ov-link te-rowaction${confirming ? ' te-rowaction-danger' : ''}`}
          onClick={() => handleRemove(kind, id)}
          aria-disabled={saving}
          aria-label={confirming ? `Confirm removing ${what}` : `Remove ${what}`}
        >
          {confirming ? 'Confirm remove' : 'Remove'}
        </button>
        {confirming && (
          <button type="button" className="ov-link te-rowaction" onClick={cancelRemove}>
            Keep
          </button>
        )}
      </>
    );
  };

  const sectionHeading = (section, text, style) => (
    <h3
      className="ov-kicker te-section-head"
      id={`${uid}-${section}-head`}
      tabIndex={-1}
      ref={(el) => {
        headingRefs.current[section] = el;
      }}
      style={style}
    >
      {text}
    </h3>
  );

  const fieldRef = (key) => (el) => {
    fieldRefs.current[key] = el;
  };

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={goal ? 'Edit goal' : 'Add goal'} ref={drawerRef} tabIndex={-1}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{goal ? 'Edit goal' : 'New goal'}</span>
              {unsaved && <span className="te-dirty-chip">Unsaved</span>}
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
                <input
                  ref={fieldRef('target')}
                  type="number"
                  step="0.01"
                  className="te-hero-input"
                  value={form.target_amount}
                  onChange={(e) => set('target_amount', e.target.value)}
                  aria-label="Target, AED"
                  placeholder="0"
                  {...invalid('target')}
                />
              </div>
              {problemText('target')}
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
                    ref={fieldRef('rate')}
                    className="te-fieldvalue"
                    type="number"
                    step="0.1"
                    value={form.inflation_pct}
                    onChange={(e) => set('inflation_pct', e.target.value)}
                    placeholder={`blank: ${inflationPct}%, general inflation`}
                    aria-label="Rises by, percent a year"
                    {...invalid('rate')}
                  />
                  {problemText('rate')}
                  <span className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    {costOnDate !== null
                      ? `About ${formatMoney(costOnDate)} by ${form.target_date.slice(0, 4)}, the amount progress is measured against.`
                      : 'Set a date to see what it will cost then. Education and medical costs often rise faster than prices in general.'}
                  </span>
                </div>
              )}
            </div>

            <div>
              <div className="om-scope-list" role="group" aria-label="When its date comes">
                <button type="button" className="om-scope" data-active={!form.kept} aria-pressed={!form.kept} onClick={() => set('kept', false)}>
                  Spent on its date
                </button>
                <button type="button" className="om-scope" data-active={form.kept} aria-pressed={form.kept} onClick={() => set('kept', true)}>
                  Kept, not spent
                </button>
              </div>
              <span className="ov-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
                {form.kept
                  ? 'Like an emergency fund: held in cash, and never paid out of the Life plan\u2019s savings.'
                  : 'Paid in its year: from cash if it is due within 3 years, otherwise by the Life plan.'}
              </span>
            </div>

            <div className="te-fieldgrid">
              <div className="te-fieldcell te-span2">
                <label className="te-fieldlabel" htmlFor={ids.name}>
                  Name
                </label>
                <input id={ids.name} ref={fieldRef('name')} className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Japan trip" {...invalid('name')} />
                {problemText('name')}
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
                <input
                  id={ids.priority}
                  ref={fieldRef('priority')}
                  className="te-fieldvalue"
                  type="number"
                  step="1"
                  value={form.priority}
                  onChange={(e) => set('priority', e.target.value)}
                  placeholder="1 = first"
                  {...invalid('priority')}
                />
                {problemText('priority')}
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
          </form>

          {goal && (
            <section className="te-section" aria-labelledby={`${uid}-contributions-head`}>
              {sectionHeading('contributions', 'Contributions')}
              <form onSubmit={handleLogContribution} noValidate>
                <div className="te-fieldgrid">
                  <div className="te-fieldcell">
                    <label className="te-fieldlabel" htmlFor={ids.contribAmount}>
                      Amount (AED)
                    </label>
                    <input
                      id={ids.contribAmount}
                      className="te-fieldvalue"
                      type="number"
                      step="0.01"
                      value={contribAmount}
                      onChange={(e) => {
                        setContribAmount(e.target.value);
                        setNotice(null);
                      }}
                    />
                  </div>
                  <div className="te-fieldcell">
                    <label className="te-fieldlabel" htmlFor={ids.contribDate}>
                      Date
                    </label>
                    <input id={ids.contribDate} className="te-fieldvalue" type="date" value={contribDate} onChange={(e) => setContribDate(e.target.value)} />
                  </div>
                </div>
                <div className="te-subactions">
                  <button type="submit" className="om-btn" aria-disabled={saving}>
                    Log contribution
                  </button>
                </div>
              </form>
              {sectionMessages('contributions')}

              {contributions.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                  No contributions logged yet.
                </div>
              ) : (
                <div className="mn-list">
                  {contributions.map((c) => (
                    <div key={c.id} className="mn-row te-linkrow" style={{ cursor: 'default' }}>
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
              {sectionHeading('linked', <>Linked accounts &amp; holdings</>, { marginBottom: 4 })}
              <div className="ov-muted" style={{ fontSize: 11.5, marginBottom: 12, lineHeight: 1.5 }}>
                Earmark a share of a real account or holding toward this goal — its current value (interest or growth included)
                counts toward progress automatically. One account/holding can be split across several goals as long as its shares
                never add up past 100%. Loans and cards can&rsquo;t be linked: what they hold is owed.
              </div>
              {sourceOptions.length > 0 && (
                <form onSubmit={handleAddAllocation} noValidate>
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
                      <input
                        id={ids.linkShare}
                        className="te-fieldvalue"
                        type="number"
                        step="any"
                        value={allocSharePct}
                        onChange={(e) => {
                          setAllocSharePct(e.target.value);
                          setNotice(null);
                        }}
                      />
                    </div>
                  </div>
                  <div className="te-subactions">
                    <button type="submit" className="om-btn" aria-disabled={saving}>
                      Link
                    </button>
                  </div>
                </form>
              )}
              {sectionMessages('linked')}

              {linked.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                  Nothing linked yet — this goal's progress is only from logged contributions.
                </div>
              ) : (
                <div className="mn-list">
                  {linked.map((a) => {
                    const label = allocationLabel(a);
                    const account = a.account_id ? findAccount(a.account_id) : null;
                    const nothing = a.account_id && !accountCanBackGoal(account) ? linkCountsAsNothing(account) : null;
                    const stored = String(Number(a.share_pct));
                    const shown = shareEdits[a.id] ?? stored;
                    return (
                      <form key={a.id} className="mn-row te-linkrow" style={{ cursor: 'default' }} onSubmit={(e) => handleShareChange(e, a)} noValidate>
                        <div className="mn-row-main">
                          {label}
                          {nothing && <div className="ov-muted te-rownote">Counts as nothing: {nothing}.</div>}
                        </div>
                        <div className="te-rowcontrols">
                          {!nothing && (
                            <>
                              <input
                                ref={(el) => {
                                  shareRefs.current[a.id] = el;
                                }}
                                className="te-fieldvalue te-shareinput"
                                type="number"
                                step="any"
                                value={shown}
                                onChange={(e) => {
                                  setShareEdits((edits) => ({ ...edits, [a.id]: e.target.value }));
                                  setNotice(null);
                                }}
                                aria-label={`Share of ${label}, percent`}
                              />
                              <span className="fig">%</span>
                              {shown !== stored && (
                                <button type="submit" className="om-btn" aria-disabled={saving}>
                                  Update
                                </button>
                              )}
                            </>
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
            {formError && (
              <p className="ov-warn" role="alert" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
                {formError}
              </p>
            )}
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {goal && (
                <button type="button" className="om-btn te-delete" onClick={handleDelete} aria-disabled={saving}>
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
                    <button type="submit" form={ids.form} className="om-btn ov-btn-primary" aria-disabled={saving}>
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
