import { useId, useRef, useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { DEFAULT_INFLATION_PCT, accountCanBackGoal, goalCostAtDate } from '../../lib/goals';
import { goalPayload, goalProblems, initialForm, linkErrorMessage, shareProblem } from '../../lib/goalForm';
import { householdToday, parseDay } from '../../lib/day';
import '../money/TransactionEditor.css';
import OwnerPicker from '../OwnerPicker';
import GoalContributions from './GoalContributions';
import GoalLinks from './GoalLinks';

const dayLabel = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// done_at is a moment, not a day: read in the browser's own time.
const doneLabel = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

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
    planned: `${uid}-planned`,
    funding: `${uid}-funding`,
    rate: `${uid}-rate`,
    target: `${uid}-target`,
    owner: `${uid}-owner`,
    contribAmount: `${uid}-camount`,
    contribDate: `${uid}-cdate`,
    linkSource: `${uid}-lsource`,
    linkShare: `${uid}-lshare`,
  };
  const removeRefs = useRef({});
  const shareRefs = useRef({});
  const headingRefs = useRef({});
  const drawerRef = useDrawerFocus();
  const [form, setForm] = useState(() => initialForm(goal));
  const [dirty, setDirty] = useState(false);
  // Fields are marked wrong only once a save has been tried, not on opening.
  const [triedSave, setTriedSave] = useState(false);
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
  const { confirmingClose, requestClose, keepEditing } = useCloseGuard({
    dirty: unsaved,
    onClose,
    // Escape steps back out of a pending confirmation before it closes anything.
    onEscape: () => {
      if (confirmingRemove) cancelRemove();
      else if (confirmingDelete) setConfirmingDelete(false);
      else requestClose();
    },
  });

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  // Each field carries its own message once a save has been tried, and the
  // message follows the field as it is corrected (lib/goalForm.js).
  const fieldProblems = goalProblems(form);
  const rateText = String(form.inflation_pct).trim();
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
    form.cost_today && form.target_date && Number(form.target_amount) > 0 && !fieldProblems.rate
      ? goalCostAtDate({ target_amount: form.target_amount, target_date: form.target_date, cost_today: true, inflation_pct: rateText === '' ? null : rateText }, new Date(), inflationPct)
      : null;

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    setNotice(null);
    const firstProblem = ['target', 'rate', 'name', 'planned', 'priority'].find((key) => fieldProblems[key]);
    if (firstProblem) {
      setTriedSave(true);
      setFormError('Fix the marked field to save.');
      document.getElementById(ids[firstProblem])?.focus();
      return;
    }
    if (pendingWork) {
      setFormError(pendingWork);
      return;
    }
    setSaving(true);
    setFormError('');

    const payload = goalPayload(form, householdId);

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

  // Done, or open again: written at once, like a contribution, and only with
  // nothing unsaved, which it would otherwise drop. A done goal leaves every
  // plan and keeps its contributions (Planning audit, 2.7).
  async function handleDone() {
    if (saving) return;
    setNotice(null);
    if (unsaved) {
      setFormError(`Save or discard your changes first, then ${goal.done_at ? 'reopen it' : 'mark it done'}.`);
      return;
    }
    setSaving(true);
    setFormError('');
    const { error: doneError } = await supabase
      .from('goals')
      .update({ done_at: goal.done_at ? null : new Date().toISOString() })
      .eq('id', goal.id);
    setSaving(false);
    if (doneError) {
      setFormError(doneError.message);
      return;
    }
    await onSaved();
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
                  id={ids.target}
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
                <input id={ids.name} className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Japan trip" {...invalid('name')} />
                {problemText('name')}
              </div>
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={ids.date}>
                  Target date
                </label>
                <input id={ids.date} className="te-fieldvalue" type="date" value={form.target_date} onChange={(e) => set('target_date', e.target.value)} />
              </div>
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={ids.planned}>
                  Monthly plan · AED
                </label>
                <input
                  id={ids.planned}
                  className="te-fieldvalue"
                  type="number"
                  step="0.01"
                  value={form.planned_monthly}
                  onChange={(e) => set('planned_monthly', e.target.value)}
                  placeholder="blank: no plan"
                  {...invalid('planned')}
                />
                {problemText('planned')}
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
              <OwnerPicker value={form.owner} members={members} onChange={(id) => set('owner', id)} labelledBy={ids.owner} />
            </div>
          </form>

          {goal && (
            <section className="te-section" aria-labelledby={`${uid}-done-head`}>
              {sectionHeading('done', goal.done_at ? 'Done' : 'Reached or spent?')}
              <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                {goal.done_at
                  ? `Marked done on ${doneLabel(goal.done_at)}. It is out of every plan and the Telegram bot; its contributions are kept.`
                  : 'Mark it done: it leaves Goals\u2019 plans, Plan\u2019s checks, the Life plan and the Telegram bot, and keeps its contributions. You can reopen it.'}
              </div>
              <div className="te-subactions">
                <button type="button" className="om-btn" onClick={handleDone} aria-disabled={saving}>
                  {goal.done_at ? 'Reopen' : 'Mark done'}
                </button>
              </div>
            </section>
          )}

          {goal && (
            <GoalContributions
              labelledBy={`${uid}-contributions-head`}
              heading={sectionHeading('contributions', 'Contributions')}
              messages={sectionMessages('contributions')}
              hasLinks={linked.length > 0}
              ids={{ amount: ids.contribAmount, date: ids.contribDate }}
              amount={contribAmount}
              onAmount={(value) => {
                setContribAmount(value);
                setNotice(null);
              }}
              date={contribDate}
              onDate={setContribDate}
              onLog={handleLogContribution}
              saving={saving}
              contributions={contributions}
              removeControls={removeControls}
            />
          )}

          {goal && (sourceOptions.length > 0 || linked.length > 0) && (
            <GoalLinks
              labelledBy={`${uid}-linked-head`}
              heading={sectionHeading('linked', <>Linked accounts &amp; holdings</>, { marginBottom: 4 })}
              messages={sectionMessages('linked')}
              ids={{ source: ids.linkSource, share: ids.linkShare }}
              linkableAccounts={linkableAccounts}
              linkableHoldings={linkableHoldings}
              allocSource={allocSource}
              onSource={setSourceChoice}
              allocSharePct={allocSharePct}
              onShare={(value) => {
                setAllocSharePct(value);
                setNotice(null);
              }}
              onAdd={handleAddAllocation}
              saving={saving}
              linked={linked}
              allocationLabel={allocationLabel}
              findAccount={findAccount}
              shareEdits={shareEdits}
              onShareEdit={(id, value) => {
                setShareEdits((edits) => ({ ...edits, [id]: value }));
                setNotice(null);
              }}
              onShareChange={handleShareChange}
              shareRef={(id) => (el) => {
                shareRefs.current[id] = el;
              }}
              removeControls={removeControls}
            />
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
                    <DiscardPrompt onDiscard={onClose} onKeepEditing={keepEditing} />
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
