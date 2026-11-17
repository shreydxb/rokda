import { useId, useRef, useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { Drawer, Fold } from '../../design-system/kit';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { AFTER_WORK_RETURN_GAP, CASH_RETURN_DEFAULT, DEFAULT_STOP_AGE, defaultStopPerson } from '../../lib/lifePlanBasis';
import { PLANNING_DEFAULTS, assumption } from '../../lib/planningDefaults';
import { describeCost, describeIncome, nativeAmountLabel } from '../../lib/planRows';
import IncomeEditor from './IncomeEditor';
import CostEditor from './CostEditor';
import '../money/TransactionEditor.css';

// The plan's one drawer (Planning audit, 3.13): who the plan is for, when work
// stops, spending after that and the costs that start then, other income, and
// the growth it all rests on. These were edited in three places, Forecast's
// assumptions, Drawdown's other income and this editor, and every figure
// rests on all of them. The withdrawal rate and Forecast's baseline went with
// Forecast (3.15): nothing works from either now.
//
// Ages are kept per member (member_life); other income and the costs that
// start when work stops are rows of their own, each saved as it is added, in
// place inside its fold; the rest is the household's planning assumptions.
// Blank optional fields mean "the same as now": spending at today's rate, a
// return one point below the working return.
//
// The revamp, phase 6 (design/prototype plan-edit): the kit's drawer with a
// fold for each part. The Custom scenario and spending "for one" went from
// it, never used; a figure saved for either before is left as it is.
const whole = (v) => /^\d+$/.test(String(v).trim());
const numeric = (v) => String(v).trim() !== '' && Number.isFinite(Number(v));
const blank = (v) => String(v ?? '').trim() === '';
const str = (v) => (v == null ? '' : String(Number(v)));
// Names that usually stop by the time work does: a hint, never a default.
const USUALLY_STOPS = /\b(rent|emi|loan|mortgage|instal?ments?)\b/i;

// What a blank growth figure saves. Never 0: a 0% return or 0% inflation is an
// answer someone has to type, not what an emptied box should quietly become.
// Baseline's columns always hold a number, so a blank there is the default its
// placeholder names.
const DEFAULTS = { nominal: PLANNING_DEFAULTS.nominal_return_pct, inflation: PLANNING_DEFAULTS.inflation_pct };
const GROWTH = ['nominal', 'inflation'];

function initialForm(members, memberLife, assumptions) {
  const byMember = new Map(memberLife.map((r) => [r.member_id, r]));
  const people = members.map((m) => ({
    id: m.id,
    name: m.display_name,
    birthYear: byMember.has(m.id) ? String(byMember.get(m.id).birth_year) : '',
    lifeExpectancy: byMember.has(m.id) ? String(byMember.get(m.id).life_expectancy) : '',
    had: byMember.has(m.id),
  }));
  return {
    people,
    stopYear: str(assumptions?.retirement_year),
    spend: str(assumptions?.retirement_annual_spend),
    lean: str(assumptions?.lean_annual_spend),
    returnPct: str(assumptions?.retirement_return_pct),
    cashPct: str(assumptions?.cash_return_pct),
    nominal: str(assumption(assumptions, 'nominal_return_pct')),
    inflation: str(assumption(assumptions, 'inflation_pct')),
  };
}

export default function LifePlanEditor({
  householdId,
  household = null,
  members,
  memberLife,
  assumptions,
  categories = [],
  spendByCategory = new Map(),
  incomes = [],
  costs = [],
  section = null,
  onClose,
  onSaved,
  onRowsChanged,
}) {
  const uid = useId();
  const formId = `${uid}-form`;
  const [form, setForm] = useState(() => initialForm(members, memberLife, assumptions));
  // Spending categories, the ones with spending first, and which of them stop.
  const spendCategories = categories
    .filter((c) => c.kind === 'expense' && !c.is_savings && (!c.archived || c.stops_after_work))
    .sort((a, b) => (spendByCategory.get(b.id) ?? 0) - (spendByCategory.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const [stops, setStops] = useState(() => new Set(categories.filter((c) => c.stops_after_work).map((c) => c.id)));
  // The growth figures are written only once one of them is changed, so saving
  // the people does not mark the defaults as the household's choice.
  const [growthChanged, setGrowthChanged] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // An income or cost open in place, in its fold: { kind, row }. One being
  // typed is unsaved work, so closing the plan asks first. Escape inside it
  // steps back out of it alone (CostEditor, IncomeEditor); the drawer
  // answers Escape on itself (lib/useCloseGuard.js).
  const [sub, setSub] = useState(null);
  const { confirmingClose, requestClose, keepEditing, escapeKey } = useCloseGuard({ dirty: dirty || sub !== null, onClose, listen: false });
  const fieldRefs = useRef({});
  const thisYear = new Date().getFullYear();
  // The part the drawer was opened for is unfolded, the rest folded.
  const opened = (key) => (section ?? 'people') === key;

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    if (GROWTH.includes(key)) setGrowthChanged(true);
    setDirty(true);
  }

  function toggleStop(id) {
    setStops((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  }

  function setPerson(id, key, value) {
    setForm((f) => ({ ...f, people: f.people.map((p) => (p.id === id ? { ...p, [key]: value } : p)) }));
    setDirty(true);
  }

  const planned = form.people.filter((p) => !blank(p.birthYear) || !blank(p.lifeExpectancy));
  // The year the plan assumes until one is chosen, by the same rule.
  const stopBy = defaultStopPerson(planned.filter((p) => whole(p.birthYear)).map((p) => ({ ...p, birthYear: Number(p.birthYear) })));
  const suggestedStop = stopBy ? stopBy.birthYear + DEFAULT_STOP_AGE : null;

  // The same limits the database enforces, said here in words first: each
  // field carries its own message once a save has been tried, and the message
  // follows the field as it is corrected.
  const inRange = (key, min, max) => blank(form[key]) || (numeric(form[key]) && Number(form[key]) >= min && Number(form[key]) <= max);
  const problems = [];
  if (!planned.length) problems.push([form.people.length ? `birth-${form.people[0].id}` : 'people', 'Add a birth year and an age to plan to for at least one person.']);
  for (const p of planned) {
    if (!whole(p.birthYear) || Number(p.birthYear) < 1900 || Number(p.birthYear) > thisYear) problems.push([`birth-${p.id}`, `Enter ${p.name}'s birth year.`]);
    else if (!whole(p.lifeExpectancy) || Number(p.lifeExpectancy) < 40 || Number(p.lifeExpectancy) > 120) problems.push([`age-${p.id}`, `Plan ${p.name} to an age between 40 and 120.`]);
    else if (Number(p.birthYear) + Number(p.lifeExpectancy) < thisYear) problems.push([`age-${p.id}`, `${p.name}'s plan would already have ended; plan to a later age.`]);
  }
  if (!blank(form.stopYear) && (!whole(form.stopYear) || Number(form.stopYear) < thisYear || Number(form.stopYear) > 2200)) problems.push(['stopYear', 'Stop working this year or later.']);
  if (!blank(form.spend) && !(numeric(form.spend) && Number(form.spend) >= 0)) problems.push(['spend', 'Spending after work stops is an amount of zero or more.']);
  if (!blank(form.lean) && !(numeric(form.lean) && Number(form.lean) > 0)) problems.push(['lean', 'Essentials-only spend is an amount above zero.']);
  if (!inRange('nominal', -20, 50)) problems.push(['nominal', 'A return between −20% and 50%.']);
  if (!inRange('inflation', -10, 30)) problems.push(['inflation', 'Inflation between −10% and 30%.']);
  if (!inRange('returnPct', -20, 50)) problems.push(['returnPct', 'A return after work stops between −20% and 50%.']);
  if (!inRange('cashPct', -5, 20)) problems.push(['cashPct', 'A return on cash between −5% and 20%.']);
  const problemFor = new Map(problems.slice().reverse());

  const invalid = (key) => (triedSave && problemFor.has(key) ? { 'aria-invalid': true, 'aria-describedby': `${uid}-${key}-problem` } : { 'aria-invalid': false });
  const problemText = (key) =>
    triedSave &&
    problemFor.has(key) && (
      <span className="te-fieldproblem" id={`${uid}-${key}-problem`}>
        {problemFor.get(key)}
      </span>
    );
  const fieldRef = (key) => (el) => {
    fieldRefs.current[key] = el;
  };

  // The return after work stops sits a point below the working one until
  // one is set.
  const growthValue = (key) => (blank(form[key]) ? DEFAULTS[key] : Number(form[key]));
  const growthPlaceholder = (key) => `blank: ${DEFAULTS[key].toFixed(1)}`;
  const workingReturn = numeric(form.nominal) ? Number(form.nominal) : DEFAULTS.nominal;

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    if (problems.length) {
      setTriedSave(true);
      setError(problems[0][1]);
      fieldRefs.current[problems[0][0]]?.focus();
      return;
    }
    setSaving(true);
    setError('');
    const now = new Date().toISOString();
    const rows = planned.map((p) => ({
      member_id: p.id,
      household_id: householdId,
      birth_year: Number(p.birthYear),
      life_expectancy: Number(p.lifeExpectancy),
    }));
    const cleared = form.people.filter((p) => p.had && blank(p.birthYear) && blank(p.lifeExpectancy)).map((p) => p.id);
    const changedStops = categories.filter((c) => !!c.stops_after_work !== stops.has(c.id));
    const plan = {
      household_id: householdId,
      // A year left blank stays blank: the plan assumes the suggested one
      // and says so. Writing it made a year nobody chose read as chosen
      // (Planning audit, 1.3).
      retirement_year: blank(form.stopYear) ? null : Number(form.stopYear),
      retirement_annual_spend: blank(form.spend) ? null : Number(form.spend),
      lean_annual_spend: blank(form.lean) ? null : Number(form.lean),
      retirement_return_pct: blank(form.returnPct) ? null : Number(form.returnPct),
      cash_return_pct: blank(form.cashPct) ? null : Number(form.cashPct),
    };
    if (growthChanged) {
      Object.assign(plan, {
        nominal_return_pct: growthValue('nominal'),
        inflation_pct: growthValue('inflation'),
        // From now on these are the household's, not the defaults
        // (lib/planningDefaults.js).
        assumptions_saved_at: now,
      });
    }
    const results = await Promise.all([
      ...changedStops.map((c) => supabase.from('categories').update({ stops_after_work: stops.has(c.id) }).eq('id', c.id)),
      supabase.from('member_life').upsert(rows, { onConflict: 'member_id' }),
      cleared.length ? supabase.from('member_life').delete().in('member_id', cleared) : Promise.resolve({ error: null }),
      supabase.from('planning_assumptions').upsert(plan, { onConflict: 'household_id' }),
    ]);
    setSaving(false);
    const failed = results.find((r) => r.error);
    if (failed) {
      setError(failed.error.message);
      return;
    }
    await onSaved();
  }

  const stopAges =
    whole(form.stopYear || suggestedStop || '') &&
    planned
      .filter((p) => whole(p.birthYear))
      .map((p) => `${p.name} ${Number(form.stopYear || suggestedStop) - Number(p.birthYear)}`)
      .join(' · ');

  const numberField = (key, label, aria, props = {}) => (
    <div className={`te-fieldcell${props.span2 ? ' te-span2' : ''}`}>
      <label className="te-fieldlabel" htmlFor={`${uid}-${key}`}>
        {label}
      </label>
      <input
        id={`${uid}-${key}`}
        ref={fieldRef(key)}
        className="te-fieldvalue"
        type="number"
        step={props.step ?? '0.1'}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder={props.placeholder}
        aria-label={aria}
        {...invalid(key)}
      />
      {problemText(key)}
      {props.hint}
    </div>
  );

  const rowList = (rows, kind, describe, amountNote) => (
    <div className="mn-list">
      {rows.map((row) => (
        <button key={row.id} type="button" className="mn-row te-linkrow" onClick={() => setSub({ kind, row })}>
          <div className="mn-row-main">
            <div>{row.name}</div>
            <div className="ov-muted te-rownote">{describe(row, household)}</div>
          </div>
          <div className="fig mn-row-amt">
            {nativeAmountLabel(row) ?? formatMoney(Number(row.amount))}
            <span className="ov-muted" style={{ fontSize: 11.5 }}>
              {amountNote(row)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );

  const subDone = async () => {
    setSub(null);
    await onRowsChanged?.();
  };

  const footer = confirmingClose ? (
    <DiscardPrompt onDiscard={onClose} onKeepEditing={keepEditing} />
  ) : (
    <>
      <span className="pl-grow" />
      <button type="button" className="ds-btn" onClick={requestClose}>
        Cancel
      </button>
      <button type="submit" form={formId} className="ds-btn ds-btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save plan'}
      </button>
    </>
  );

  return (
    <Drawer kicker="Plan" title="Who it is for, and what it assumes" wide dirty={dirty || sub !== null} onClose={requestClose} onEscape={escapeKey} footer={footer}>
      <form id={formId} className="pl-form" onSubmit={handleSave} noValidate>
        <Fold label="Who it is for" defaultOpen={opened('people')}>
          <div className="pl-fold-body">
            <div className="ds-muted pl-hint">
              Each person is planned for until the end of the year they reach the age you give. It is the age to plan to, not a prediction: planning a
              little long is the safer mistake, and 95 is a careful age for a couple. Leave someone blank to leave them out.
            </div>
            {form.people.map((p) => (
              <div key={p.id} className="te-fieldgrid">
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">{p.name} · birth year</span>
                  <input
                    ref={fieldRef(`birth-${p.id}`)}
                    className="te-fieldvalue"
                    type="number"
                    inputMode="numeric"
                    value={p.birthYear}
                    onChange={(e) => setPerson(p.id, 'birthYear', e.target.value)}
                    placeholder="e.g. 1994"
                    aria-label={`${p.name}'s birth year`}
                    {...invalid(`birth-${p.id}`)}
                  />
                  {problemText(`birth-${p.id}`)}
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Plan to age</span>
                  <input
                    ref={fieldRef(`age-${p.id}`)}
                    className="te-fieldvalue"
                    type="number"
                    inputMode="numeric"
                    value={p.lifeExpectancy}
                    onChange={(e) => setPerson(p.id, 'lifeExpectancy', e.target.value)}
                    placeholder="e.g. 95"
                    aria-label={`Age to plan ${p.name} to`}
                    {...invalid(`age-${p.id}`)}
                  />
                  {problemText(`age-${p.id}`)}
                </div>
              </div>
            ))}
          </div>
        </Fold>

        <Fold label="Stop year" defaultOpen={opened('stop')}>
          <div className="pl-fold-body">
            <div className="te-fieldgrid">
              {numberField('stopYear', 'Stop working in', 'Stop working in', {
                span2: true,
                step: '1',
                placeholder: suggestedStop ? String(suggestedStop) : 'year',
                hint: stopAges && <span className="ds-muted pl-hint">{blank(form.stopYear) ? `Assumed until you choose a year · ${stopAges}` : stopAges}</span>,
              })}
            </div>
          </div>
        </Fold>

        <Fold label="Spending after work stops" defaultOpen={opened('spending')}>
          <div className="pl-fold-body">
            <div className="te-fieldgrid">
              {numberField('spend', <>A year · AED, today&rsquo;s money</>, 'Spending a year after work stops', { step: '100', placeholder: "blank: today's, less what stops" })}
              {numberField('lean', 'Essentials only', 'Essentials-only annual spend', { step: '100', placeholder: 'optional' })}
            </div>
            <div className="ds-muted pl-hint">Essentials only is a leaner year&rsquo;s spending to set beside the full one.</div>
            {spendCategories.length > 0 && (
              <div>
                <span className="te-fieldlabel">Stops when work stops</span>
                <div className="ds-muted pl-hint">
                  Spending you expect to have ended by then: rent on a home you will own, instalments on a loan that will be paid off. Left blank above,
                  spending after work stops is today&rsquo;s less these.
                </div>
                <div className="lp-stop-list">
                  {spendCategories.map((c) => (
                    <label key={c.id} className="pl-stop-cat">
                      <input type="checkbox" checked={stops.has(c.id)} onChange={() => toggleStop(c.id)} />
                      <span>{c.name}</span>
                      {spendByCategory.get(c.id) > 0 && <span className="ds-muted">{formatMoney(spendByCategory.get(c.id))} a year</span>}
                      {!stops.has(c.id) && USUALLY_STOPS.test(c.name) && <span className="ds-muted">· often stops</span>}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Fold>

        <Fold label="Costs that start then" defaultOpen={opened('costs')}>
          <div className="pl-fold-body">
            {sub?.kind === 'cost' ? (
              <CostEditor row={sub.row} householdId={householdId} household={household} onClose={() => setSub(null)} onSaved={subDone} />
            ) : (
              <>
                {costs.length === 0 ? (
                  <div className="ds-muted pl-hint">None added. Health cover an employer pays until then, rising with age, and residence visa fees go here, on top of the spending.</div>
                ) : (
                  rowList(costs, 'cost', describeCost, (row) => (row.per_person ? ' a year each' : ' a year'))
                )}
                <div>
                  <button type="button" className="ds-btn ds-btn-sm" onClick={() => setSub({ kind: 'cost', row: null })}>
                    + Cost
                  </button>
                </div>
              </>
            )}
          </div>
        </Fold>

        <Fold label="Other income" defaultOpen={opened('income')}>
          <div className="pl-fold-body">
            {sub?.kind === 'income' ? (
              <IncomeEditor row={sub.row} householdId={householdId} household={household} onClose={() => setSub(null)} onSaved={subDone} />
            ) : (
              <>
                {incomes.length === 0 ? (
                  <div className="ds-muted pl-hint">None added. Rent from a property, part-time work, an end-of-service gratuity or a policy maturing go here.</div>
                ) : (
                  rowList(incomes, 'income', describeIncome, (row) => (row.kind === 'lump_sum' ? ' once' : ' a year'))
                )}
                <div>
                  <button type="button" className="ds-btn ds-btn-sm" onClick={() => setSub({ kind: 'income', row: null })}>
                    + Income
                  </button>
                </div>
              </>
            )}
            <div className="ds-muted pl-hint">Costs and income are each saved as you add them.</div>
          </div>
        </Fold>

        <Fold label="Growth" defaultOpen={opened('growth')}>
          <div className="pl-fold-body">
            <div className="te-fieldgrid">
              {numberField('nominal', 'Return · %', 'Investment return, nominal percent a year', { placeholder: growthPlaceholder('nominal') })}
              {numberField('inflation', 'Inflation · %', 'Inflation, percent a year', { placeholder: growthPlaceholder('inflation') })}
              {numberField('returnPct', 'Return after work stops · %', 'Return after work stops', {
                placeholder: `blank: ${(workingReturn - AFTER_WORK_RETURN_GAP).toFixed(1)}, a point below`,
              })}
              {numberField('cashPct', 'Return on cash · %', 'Return on cash held today', {
                placeholder: `blank: ${CASH_RETURN_DEFAULT.toFixed(1)}`,
              })}
            </div>
            <div className="ds-muted pl-hint">
              Conservative and Optimistic move from these: two points lower or higher, both returns together. The cash held today stays cash at its own return,
              in every scenario; the rest earns the return. Returns are a year, before inflation.
            </div>
          </div>
        </Fold>

        {error && (
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
            {error}
          </p>
        )}
      </form>
    </Drawer>
  );
}
