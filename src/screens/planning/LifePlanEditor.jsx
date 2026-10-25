import { useEffect, useId, useRef, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { AFTER_WORK_RETURN_GAP, DEFAULT_STOP_AGE, defaultStopPerson } from '../../lib/lifePlan';
import { PLANNING_DEFAULTS, assumption } from '../../lib/planningDefaults';
import { describeCost, describeIncome, nativeAmountLabel } from '../../lib/planRows';
import IncomeEditor from './IncomeEditor';
import CostEditor from './CostEditor';
import '../money/TransactionEditor.css';

// The plan's one drawer (Planning audit, 3.13): who the plan is for, when work
// stops, spending after that and the costs that start then, other income, and
// the growth it all rests on. These were edited in three places, Forecast's
// assumptions, Drawdown's other income and this editor, and each tab's figures
// rest on all of them.
//
// Ages are kept per member (member_life); other income and the costs that
// start when work stops are rows of their own, each saved as it is added in a
// drawer over this one; the rest is the household's planning assumptions.
// Blank optional fields mean "the same as now": spending at today's rate, the
// same spending for one, a return one point below the working return.
const whole = (v) => /^\d+$/.test(String(v).trim());
const numeric = (v) => String(v).trim() !== '' && Number.isFinite(Number(v));
const blank = (v) => String(v ?? '').trim() === '';
const str = (v) => (v == null ? '' : String(Number(v)));
// Names that usually stop by the time work does: a hint, never a default.
const USUALLY_STOPS = /\b(rent|emi|loan|mortgage|instal?ments?)\b/i;

// What a blank growth figure saves. Never 0: a 0% return or 0% inflation is an
// answer someone has to type, not what an emptied box should quietly become.
// Baseline's columns always hold a number, so a blank there is the default its
// placeholder names; a blank on Custom saves nothing, and follows Baseline.
const DEFAULTS = { nominal: PLANNING_DEFAULTS.nominal_return_pct, inflation: PLANNING_DEFAULTS.inflation_pct, swr: PLANNING_DEFAULTS.safe_withdrawal_pct };
const GROWTH = ['nominal', 'inflation', 'swr'];

function initialForm(members, memberLife, assumptions, isCustom) {
  const byMember = new Map(memberLife.map((r) => [r.member_id, r]));
  const people = members.map((m) => ({
    id: m.id,
    name: m.display_name,
    birthYear: byMember.has(m.id) ? String(byMember.get(m.id).birth_year) : '',
    lifeExpectancy: byMember.has(m.id) ? String(byMember.get(m.id).life_expectancy) : '',
    had: byMember.has(m.id),
  }));
  const baseline = { nominal: assumption(assumptions, 'nominal_return_pct'), inflation: assumption(assumptions, 'inflation_pct'), swr: assumption(assumptions, 'safe_withdrawal_pct') };
  // Custom starts from Baseline's figures the first time. Once saved, a figure
  // saved blank opens blank again, so saving it again doesn't pin it.
  const customSaved = assumptions?.custom_updated_at != null;
  const custom = (column, key) => str(customSaved ? assumptions[column] : baseline[key]);
  return {
    people,
    stopYear: str(assumptions?.retirement_year),
    spend: str(assumptions?.retirement_annual_spend),
    lean: str(assumptions?.lean_annual_spend),
    survivorPct: str(assumptions?.survivor_spend_pct),
    returnPct: str(assumptions?.retirement_return_pct),
    ...(isCustom
      ? { nominal: custom('custom_nominal_return_pct', 'nominal'), inflation: custom('custom_inflation_pct', 'inflation'), swr: custom('custom_safe_withdrawal_pct', 'swr') }
      : { nominal: str(baseline.nominal), inflation: str(baseline.inflation), swr: str(baseline.swr) }),
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
  budgetMonthlySaving = null,
  scenario = 'baseline',
  section = null,
  onClose,
  onSaved,
  onRowsChanged,
}) {
  const drawerRef = useDrawerFocus();
  const uid = useId();
  const isCustom = scenario === 'custom';
  const [form, setForm] = useState(() => initialForm(members, memberLife, assumptions, isCustom));
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
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // An income or cost open in a drawer over this one: { kind, row }.
  const [sub, setSub] = useState(null);
  const fieldRefs = useRef({});
  const sectionRefs = useRef({});
  const thisYear = new Date().getFullYear();

  // Opened for one part of the plan (Edit beside the growth figures, say),
  // the drawer starts there. The first part is at the top already, and
  // scrolling to it would hide the drawer's own heading.
  useEffect(() => {
    if (section !== 'people') sectionRefs.current[section]?.scrollIntoView?.({ block: 'start' });
  }, [section]);

  useEffect(() => {
    const onKey = (e) => {
      // Escape closes the drawer on top, not both.
      if (e.key === 'Escape' && !sub) requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmingClose, sub]);

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

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
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
  if (!inRange('survivorPct', 10, 100)) problems.push(['survivorPct', 'Spending for one between 10% and 100%.']);
  if (!inRange('nominal', -20, 50)) problems.push(['nominal', 'A return between −20% and 50%.']);
  if (!inRange('inflation', -10, 30)) problems.push(['inflation', 'Inflation between −10% and 30%.']);
  if (!inRange('swr', 1, 10)) problems.push(['swr', 'A withdrawal rate between 1% and 10%.']);
  if (!inRange('returnPct', -20, 50)) problems.push(['returnPct', 'A return after work stops between −20% and 50%.']);
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

  // Baseline's figures, which a blank on Custom follows, and which the return
  // after work stops sits a point below until one is set.
  const baseline = { nominal: assumption(assumptions, 'nominal_return_pct'), inflation: assumption(assumptions, 'inflation_pct'), swr: assumption(assumptions, 'safe_withdrawal_pct') };
  const growthValue = (key) => (blank(form[key]) ? (isCustom ? null : DEFAULTS[key]) : Number(form[key]));
  const growthPlaceholder = (key) => (isCustom ? `blank: Baseline's ${baseline[key].toFixed(1)}` : `blank: ${DEFAULTS[key].toFixed(1)}`);
  const workingReturn = !isCustom && numeric(form.nominal) ? Number(form.nominal) : isCustom ? baseline.nominal : DEFAULTS.nominal;
  const hasBaseline = !!assumptions?.baseline_set_at;
  // The first save of Baseline's figures sets the baseline Forecast compares
  // against, and its saving is the budget's savings target: the plan as the
  // household wrote it down (Planning audit, 1.2). With no savings target in
  // the budget there is nothing to set it from, so no baseline is taken yet.
  const takesBaseline = !isCustom && !hasBaseline && budgetMonthlySaving > 0;

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
      updated_at: now,
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
      survivor_spend_pct: blank(form.survivorPct) ? null : Number(form.survivorPct),
      updated_at: now,
    };
    if (growthChanged && isCustom) {
      Object.assign(plan, {
        custom_nominal_return_pct: growthValue('nominal'),
        custom_inflation_pct: growthValue('inflation'),
        custom_safe_withdrawal_pct: growthValue('swr'),
        custom_updated_at: now,
      });
    } else if (growthChanged) {
      Object.assign(plan, {
        nominal_return_pct: growthValue('nominal'),
        inflation_pct: growthValue('inflation'),
        safe_withdrawal_pct: growthValue('swr'),
        // From now on these are the household's, not the defaults
        // (lib/planningDefaults.js).
        assumptions_saved_at: now,
      });
      if (takesBaseline) {
        Object.assign(plan, {
          baseline_set_at: now,
          baseline_nominal_return_pct: plan.nominal_return_pct,
          baseline_inflation_pct: plan.inflation_pct,
          baseline_monthly_saving: budgetMonthlySaving,
        });
      }
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

  const sectionHead = (key, text) => (
    <h3
      className="ov-kicker te-section-head"
      id={`${uid}-${key}-head`}
      ref={(el) => {
        sectionRefs.current[key] = el;
      }}
    >
      {text}
    </h3>
  );

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

  return (
    <>
      <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
        <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Life plan">
          <div className="te-head">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span className="ov-kicker">Life plan</span>
                {dirty && <span className="te-dirty-chip">Unsaved</span>}
              </div>
              <div className="te-title">Who it is for, and what it assumes</div>
            </div>
            <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
              ×
            </button>
          </div>

          <form className="te-form" onSubmit={handleSave} noValidate>
            <section aria-labelledby={`${uid}-people-head`}>
              {sectionHead('people', 'Who it is for')}
              <div className="ov-muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
                Each person is planned for until the end of the year they reach the age you give. It is the age to plan to, not a prediction:
                planning a little long is the safer mistake, and 95 is a careful age for a couple. Leave someone blank to leave them out.
              </div>
              <div style={{ display: 'grid', gap: 16 }}>
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
            </section>

            <section className="te-section" aria-labelledby={`${uid}-stop-head`}>
              {sectionHead('stop', 'When work stops')}
              <div className="te-fieldgrid">
                {numberField('stopYear', 'Stop working in', 'Stop working in', {
                  span2: true,
                  step: '1',
                  placeholder: suggestedStop ? String(suggestedStop) : 'year',
                  hint: stopAges && (
                    <span className="ov-muted" style={{ fontSize: 11.5 }}>
                      {blank(form.stopYear) ? `Assumed until you choose a year · ${stopAges}` : stopAges}
                    </span>
                  ),
                })}
              </div>
            </section>

            <section className="te-section" aria-labelledby={`${uid}-spending-head`}>
              {sectionHead('spending', 'Spending after work stops')}
              <div className="te-fieldgrid">
                {numberField('spend', <>A year · AED, today&rsquo;s money</>, 'Spending a year after work stops', { span2: true, step: '100', placeholder: "blank: today's, less what stops" })}
                {numberField('lean', 'Essentials only', 'Essentials-only annual spend', { step: '100', placeholder: 'optional' })}
                {numberField('survivorPct', 'For one · %', 'Spending once one person remains', { step: '5', placeholder: 'blank: 100%' })}
              </div>
              <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 10 }}>
                Essentials only is a leaner year&rsquo;s spending to set beside the full one. For one is the share of the couple&rsquo;s spending once
                only one person is still planned for.
              </div>
              {spendCategories.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <span className="te-fieldlabel">Stops when work stops</span>
                  <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 6 }}>
                    Spending you expect to have ended by then: rent on a home you will own, instalments on a loan that will be paid off. Left
                    blank above, spending after work stops is today&rsquo;s less these.
                  </div>
                  <div className="lp-stop-list" style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                    {spendCategories.map((c) => (
                      <label key={c.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                        <input type="checkbox" checked={stops.has(c.id)} onChange={() => toggleStop(c.id)} />
                        <span>{c.name}</span>
                        {spendByCategory.get(c.id) > 0 && <span className="ov-muted fig" style={{ fontSize: 11.5 }}>{formatMoney(spendByCategory.get(c.id))} a year</span>}
                        {!stops.has(c.id) && USUALLY_STOPS.test(c.name) && <span className="ov-muted" style={{ fontSize: 11.5 }}>· often stops</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="te-section" aria-labelledby={`${uid}-costs-head`}>
              <div className="ov-section-head" style={{ marginBottom: 0 }}>
                {sectionHead('costs', 'Costs that start when work stops')}
                <button type="button" className="om-btn mn-add" onClick={() => setSub({ kind: 'cost', row: null })}>
                  + Cost
                </button>
              </div>
              {costs.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  None added. Health cover an employer pays until then, rising with age, and residence visa fees go here, on top of the spending.
                </div>
              ) : (
                rowList(costs, 'cost', describeCost, (row) => (row.per_person ? ' a year each' : ' a year'))
              )}
            </section>

            <section className="te-section" aria-labelledby={`${uid}-income-head`}>
              <div className="ov-section-head" style={{ marginBottom: 0 }}>
                {sectionHead('income', 'Other income')}
                <button type="button" className="om-btn mn-add" onClick={() => setSub({ kind: 'income', row: null })}>
                  + Income
                </button>
              </div>
              {incomes.length === 0 ? (
                <div className="ov-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  None added. Rent from a property, part-time work, an end-of-service gratuity or a policy maturing go here.
                </div>
              ) : (
                rowList(incomes, 'income', describeIncome, (row) => (row.kind === 'lump_sum' ? ' once' : ' a year'))
              )}
              <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 10 }}>
                Costs and income are each saved as you add them.
              </div>
            </section>

            <section className="te-section" aria-labelledby={`${uid}-growth-head`}>
              {sectionHead('growth', isCustom ? 'Growth · Custom scenario' : 'Growth')}
              <div className="te-fieldgrid">
                {numberField('nominal', 'Return · %', 'Investment return, nominal percent a year', { placeholder: growthPlaceholder('nominal') })}
                {numberField('inflation', 'Inflation · %', 'Inflation, percent a year', { placeholder: growthPlaceholder('inflation') })}
                {numberField('swr', 'Withdrawal · %', 'Safe withdrawal rate, percent a year', { placeholder: growthPlaceholder('swr') })}
                {numberField('returnPct', 'After work · %', 'Return after work stops', {
                  placeholder: `blank: ${(workingReturn - AFTER_WORK_RETURN_GAP).toFixed(1)}, a point below`,
                })}
              </div>
              <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 10 }}>
                {isCustom
                  ? 'These apply only while the Custom scenario is selected; Baseline and its saved plan are untouched. A field left blank follows Baseline. The return after work stops is Baseline\'s, moved by as much as this return is. '
                  : 'Conservative and Optimistic move from these: two points lower or higher, both returns together. '}
                Returns are a year, before inflation. The withdrawal rate sets the independence target, spending ÷ the rate: 4% is 25 times
                spending.
              </div>
              {!isCustom && !hasBaseline && (
                <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 8 }}>
                  {takesBaseline
                    ? `The first time you change these figures, saving sets the baseline Forecast compares against: these figures, and your budget's savings target of ${formatMoney(budgetMonthlySaving)} a month. Changing them again later won't move it.`
                    : "No baseline is set yet. It takes your budget's savings target, and the budget has none, so saving keeps these figures without one."}
                </div>
              )}
            </section>

            {error && (
              <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
                {error}
              </p>
            )}

            <div className="te-sticky-actions">
              <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
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
                        {saving ? 'Saving…' : 'Save plan'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
      {sub?.kind === 'income' && <IncomeEditor row={sub.row} householdId={householdId} household={household} stacked onClose={() => setSub(null)} onSaved={subDone} />}
      {sub?.kind === 'cost' && <CostEditor row={sub.row} householdId={householdId} household={household} stacked onClose={() => setSub(null)} onSaved={subDone} />}
    </>
  );
}
