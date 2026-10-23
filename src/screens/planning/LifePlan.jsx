import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { startingNetWorth } from '../overviewMath';
import { budgetInputs, budgetPlan, forecastInputs, incomesWithoutRate, spendThatStops } from '../../lib/forecast';
import { agesIn, agesLabel, earliestStop, extraSavingNeeded, leftOutText, lifePlan, lifePlanBasis, maxRetirementSpend, membersLeftOut, planEndYear, planPeople, potNeededAt } from '../../lib/lifePlan';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { ChartLegend, ColumnChart } from '../../charts/Charts';
import BudgetBasis, { BudgetBeside } from './BudgetBasis';
import LifePlanEditor from './LifePlanEditor';
import ForecastAssumptionsEditor from './ForecastAssumptionsEditor';
import AssumptionsBar from './AssumptionsBar';
import { neverLoaded } from '../../lib/loadState';
import { projectionInputs } from './planningSources';
import Withheld from './Withheld';

// Fixed order, so each phase keeps its colour whatever the numbers do.
const PHASES = [
  { key: 'working', label: 'While working', color: 'var(--series-1)' },
  { key: 'retired', label: 'After work stops', color: 'var(--series-2)' },
];

// The whole of a household's financial life on one timeline: what an
// adviser's "cash adequacy" sheet shows, from the household's own figures and
// on the same basis as Forecast and Drawdown (the same spending, saving,
// scenarios and other income). The stop-work year, scenario and spending here
// are what-ifs; the saved plan is changed with "Make this the plan" or the
// editor.
// One empty list for every missing prop: a fresh [] on each render would
// work the whole plan out again on every step along the chart.
const NONE = [];

export default function LifePlan({
  household,
  members = NONE,
  accounts = NONE,
  transactions = NONE,
  recurring = NONE,
  holdings = NONE,
  budgets = NONE,
  categories = NONE,
  data,
  sources,
  onRetry,
  loading,
  onReload,
  onOpenTab,
  scenario,
  onScenario,
  moneyMode,
  onMoneyMode,
}) {
  const { assumptions } = data;
  const money = useMoneyDisplay(household);
  const now = useMemo(() => new Date(), []);
  const startYear = now.getFullYear();
  const [editing, setEditing] = useState(false);
  // Shared with Forecast and Drawdown when Planning passes them
  // (AssumptionsBar); on their own they are local.
  const [localSet, setLocalSet] = useState('baseline');
  const fcSet = scenario ?? localSet;
  const setFcSet = onScenario ?? setLocalSet;
  const [editingAssumptions, setEditingAssumptions] = useState(false);
  const [stopOverride, setStopOverride] = useState(null);
  const [spendKind, setSpendKind] = useState(null); // null follows the saved plan
  const [localMode, setLocalMode] = useState('real');
  const mode = moneyMode ?? localMode;
  const setMode = onMoneyMode ?? setLocalMode;
  const [activeYear, setActiveYear] = useState(null);
  // The year-by-year table is built only once it is opened: closed, its rows
  // were most of the work on every chart step (Planning audit, 0b-E).
  const [tableOpen, setTableOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const startNetWorth = useMemo(() => startingNetWorth(accounts, holdings), [accounts, holdings]);
  const plan = useMemo(() => budgetPlan(budgets, categories, now), [budgets, categories, now]);
  const inputs = useMemo(() => forecastInputs(transactions, startNetWorth, now, plan, recurring), [transactions, startNetWorth, now, plan, recurring]);
  const stopping = useMemo(() => spendThatStops({ inputs, transactions, budgets, categories, now }), [inputs, transactions, budgets, categories, now]);
  // The budget's figures, once ended months have taken over from them, so its
  // answer can be given beside theirs (Planning audit, 1.2).
  const budgetBasis = useMemo(() => (inputs.source === 'actual' ? budgetInputs(plan, startNetWorth, inputs.monthCount) : null), [inputs, plan, startNetWorth]);
  const budgetStopping = useMemo(
    () => (budgetBasis ? spendThatStops({ inputs: budgetBasis, transactions, budgets, categories, now }) : null),
    [budgetBasis, transactions, budgets, categories, now]
  );

  // The people planned for: members with a birth year and an age to plan to.
  const people = useMemo(() => planPeople(members, data.memberLife ?? []), [members, data.memberLife]);
  // Anyone without them is left out, and says so: the money could seem to last
  // when it runs out before their plan would end (Planning audit, 1.1).
  const leftOut = useMemo(() => membersLeftOut(members, data.memberLife ?? []), [members, data.memberLife]);

  // The plan and the four answers built on it, worked out once for each change
  // of input rather than on every step along the chart (Planning audit, 0b-E).
  // Null while there is no plan to work out; the states below say why.
  const worked = useMemo(() => {
    if (!inputs.ready || !people.length || planEndYear(people) < startYear) return null;
    const basisOn = (on, spendStopping) =>
      lifePlanBasis({
        people,
        assumptions,
        inputs: on,
        startNetWorth,
        goals: data.goals ?? [],
        incomes: data.independenceIncome ?? [],
        household,
        stopping: spendStopping,
        startYear,
        now,
        fcSet,
        stopOverride,
        spendKind,
      });
    const basis = basisOn(inputs, stopping);
    const result = lifePlan(basis.args);
    const earliest = earliestStop(basis.args);
    const budget = budgetBasis ? basisOn(budgetBasis, budgetStopping) : null;
    return {
      basis,
      result,
      need: potNeededAt(basis.args),
      earliest,
      extra: result.lasts ? 0 : extraSavingNeeded(basis.args),
      mostSpend: maxRetirementSpend(basis.args),
      recorded: { inputs, earliest, result },
      onBudget: budget ? { inputs: budgetBasis, earliest: earliestStop(budget.args), result: lifePlan(budget.args) } : null,
    };
  }, [people, assumptions, inputs, startNetWorth, data.goals, data.independenceIncome, household, stopping, budgetBasis, budgetStopping, startYear, now, fcSet, stopOverride, spendKind]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const missing = neverLoaded(sources, projectionInputs(inputs));
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={onRetry}>
        The life plan isn&rsquo;t worked out, rather than worked out without them.
      </Withheld>
    );
  }

  const editor = editing && (
    <LifePlanEditor
      householdId={household?.id}
      members={members}
      memberLife={data.memberLife ?? []}
      assumptions={assumptions}
      categories={categories}
      spendByCategory={stopping.byCategory}
      onClose={() => setEditing(false)}
      onSaved={async () => {
        setEditing(false);
        setStopOverride(null);
        setSpendKind(null);
        // The editor also marks which categories stop when work does, and
        // categories are the household's records rather than the plan's, so
        // both are read again.
        await Promise.all([data.reload(), onReload?.()]);
      }}
    />
  );

  if (!inputs.ready) {
    return (
      <div className="ov-empty" style={{ marginTop: 22 }}>
        <div className="ov-empty-kicker">Not enough to project</div>
        <div className="ov-empty-body">
          The life plan starts from what the household spends, saves and holds: three finished months of recorded spending, or a monthly
          budget until then, and an account valuation. The same inputs Forecast needs.
        </div>
        <div className="ov-empty-actions">
          <button type="button" className="om-btn" onClick={() => onOpenTab?.('forecast')}>
            Open Forecast
          </button>
        </div>
      </div>
    );
  }

  if (!people.length) {
    return (
      <>
        <div className="ov-empty" style={{ marginTop: 22 }}>
          <div className="ov-empty-kicker">Set up your life plan</div>
          <div className="ov-empty-body">
            The life plan follows the household year by year, from today to the end of the longest life expectancy: saving while you
            work, each goal in its year, then spending once work stops. It shows whether the money lasts, and if not, the year it runs
            out. It needs each person&rsquo;s birth year and the age to plan to.
          </div>
          <div className="ov-empty-actions">
            <button type="button" className="om-btn ov-btn-primary" onClick={() => setEditing(true)}>
              Set up the plan
            </button>
          </div>
        </div>
        {editor}
      </>
    );
  }

  // Everyone planned for is past the age the plan runs to, so there is no
  // year left to plan. Drawing one crashed the whole app (Planning audit,
  // 0b-D); the editor asks for a later age before it saves.
  if (planEndYear(people) < startYear) {
    return (
      <>
        <div className="ov-empty" style={{ marginTop: 22 }}>
          <div className="ov-empty-kicker">The plan has run its course</div>
          <div className="ov-empty-body">
            It plans for {people.map((p) => `${p.name} to ${p.lifeExpectancy}`).join(' and ')}, and everyone is past that age now. Plan to a
            later age to see the years ahead.
          </div>
          <div className="ov-empty-actions">
            <button type="button" className="om-btn ov-btn-primary" onClick={() => setEditing(true)}>
              Plan to a later age
            </button>
          </div>
        </div>
        {editor}
      </>
    );
  }

  const { basis, result, need, earliest, extra, mostSpend, recorded, onBudget } = worked;
  const { endYear, sets, selected, inflationPct, postNominal, savedStop, stopYear, spendOptions, spendChoice, survivorPct, goals, incomes, inflows } = basis;
  const anyIncome = incomes.length > 0 || inflows.length > 0;
  const uncounted = incomesWithoutRate(data.independenceIncome ?? [], household);

  // Today's money, or grown with inflation to the year it happens -- the way
  // an adviser's sheets show it.
  const inflation = inflationPct / 100;
  const shown = (value, year) => (mode === 'nominal' ? value * (1 + inflation) ** (year - startYear) : value);
  const agesText = (year) => agesLabel(agesIn(people, year));
  // While working the pot can be below zero: debt the saving is repaying
  // (lib/lifePlan.js). Said as what is owed, never as money held.
  const potText = (value, year) => (value < 0 ? `${money.code} ${money.fmt(shown(value, year))} still owed` : `${money.code} ${money.fmt(shown(value, year))}`);

  const shortRow = result.shortYear !== null ? result.rows.find((r) => r.year === result.shortYear) : null;
  const firstForOne = result.rows.find((r) => r.forOne)?.year ?? null;
  const lastPerson = [...people].sort((a, b) => b.birthYear + b.lifeExpectancy - (a.birthYear + a.lifeExpectancy))[0];

  const rows = result.rows;
  const activeIdx = Math.min(activeYear ?? Math.max(0, rows.findIndex((r) => r.year === (result.shortYear ?? stopYear))), rows.length - 1);
  const active = rows[activeIdx];

  async function makeThePlan() {
    setSaving(true);
    setSaveError('');
    const { error } = await supabase
      .from('planning_assumptions')
      .upsert({ household_id: household.id, retirement_year: stopYear, updated_at: new Date().toISOString() }, { onConflict: 'household_id' });
    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    setStopOverride(null);
    await data.reload();
  }

  const heroFigure = result.lasts ? `Lasts to ${endYear}` : shortRow.working ? `Short in ${result.shortYear}` : `Runs out in ${result.shortYear}`;
  const spendText = `${money.code} ${money.fmt(shown(spendChoice.value, stopYear))} a year`;
  let heroText;
  if (result.lasts) {
    heroText = `Stopping work in ${stopYear} (${agesText(stopYear)}) with ${potText(result.potAtStop, stopYear)} by then, and spending ${spendText} after, the money lasts to ${endYear}, the year ${lastPerson.name} turns ${lastPerson.lifeExpectancy}, with ${money.code} ${money.fmtBalance(shown(result.left, endYear + 1))} left.`;
  } else if (shortRow.working) {
    // While working, only a goal falls short (lib/lifePlan.js).
    const names = shortRow.goals.map((g) => g.name).join(', ');
    const by = money.fmt(shown(shortRow.start, shortRow.year));
    heroText = `${names} in ${result.shortYear} needs ${money.code} ${money.fmt(shown(shortRow.goalOutflow, shortRow.year))}; by then ${shortRow.start < 0 ? `${money.code} ${by} will still be owed` : `the pot will hold ${money.code} ${by}`}, before that year's saving.`;
  } else {
    heroText = `Stopping work in ${stopYear} (${agesText(stopYear)}) with ${potText(result.potAtStop, stopYear)} by then, and spending ${spendText} after, the money runs out in ${result.shortYear} (${agesText(result.shortYear)}), ${endYear - result.shortYear + 1} year${endYear - result.shortYear + 1 === 1 ? '' : 's'} before the plan ends.`;
  }

  const goalsTotal = goals.reduce((s, g) => s + shown(g.amount, g.year), 0);
  const columns = rows.map((r) => ({
    key: r.year,
    label: String(r.year),
    values: r.working ? [shown(r.start, r.year), 0] : [0, shown(r.start, r.year)],
  }));

  return (
    <div>
      <BudgetBasis inputs={inputs} />
      <BudgetBeside recorded={recorded} budget={onBudget} stopYear={stopYear} money={money} />
      <AssumptionsBar
        sets={sets}
        scenario={fcSet}
        onScenario={setFcSet}
        mode={mode}
        onMode={setMode}
        growth={postNominal !== selected.nominalPct ? [`${postNominal.toFixed(1)}% return after work stops`] : []}
        onEdit={() => setEditingAssumptions(true)}
        spending={
          <div className="dd-segs" role="group" aria-label="Spending">
            {spendOptions.map((o) => (
              <button key={o.key} type="button" className="om-seg" data-active={spendChoice.key === o.key} aria-pressed={spendChoice.key === o.key} onClick={() => setSpendKind(o.key)}>
                {o.label} · {money.fmtCompact(o.value)} a year
              </button>
            ))}
            <span className="ov-muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>
              after work stops
            </span>
          </div>
        }
      />
      {spendChoice.key === 'less' && (
        <div className="ov-muted lp-stops" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 8 }}>
          Leaves out {stopping.categories.map((c) => `${c.name} ${money.fmtCompact(c.annual)}`).join(', ')} a year, expected to have stopped by then.{' '}
          <button type="button" className="om-link" style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }} onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      )}
      {editingAssumptions && (
        <ForecastAssumptionsEditor
          householdId={household?.id}
          assumptions={assumptions}
          budgetMonthlySaving={plan?.monthlySaving ?? null}
          scenario={fcSet}
          onClose={() => setEditingAssumptions(false)}
          onSaved={async () => {
            setEditingAssumptions(false);
            await data.reload();
          }}
        />
      )}
      <section className="pl-hero" style={{ marginTop: 22 }}>
        <div className="ov-section-head">
          <div className="ov-kicker">Life plan</div>
          <button type="button" className="om-btn" onClick={() => setEditing(true)}>
            Edit plan
          </button>
        </div>
        <div className={`ov-hero fig ${result.lasts ? '' : 'ov-neg'}`}>{heroFigure}</div>
        <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10, lineHeight: 1.6, maxWidth: '92ch' }}>{heroText}</div>
        {leftOut.length > 0 && (
          <p className="ov-warn" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
            {leftOutText(leftOut)} Add {leftOut.length === 1 ? 'them' : 'each'} under Edit plan.
          </p>
        )}

        <div className="dd-controls">
          <div className="dd-control">
            <span className="dd-label">Stop working</span>
            <span className="fc-solve-year">
              <button type="button" className="fc-solve-step" aria-label="A year earlier" disabled={stopYear <= startYear} onClick={() => setStopOverride(stopYear - 1)}>
                −
              </button>
              <span className="fig" aria-live="polite">
                {stopYear}
              </span>
              <button type="button" className="fc-solve-step" aria-label="A year later" disabled={stopYear >= endYear} onClick={() => setStopOverride(stopYear + 1)}>
                +
              </button>
            </span>
            <span className="ov-muted" style={{ fontSize: 11.5 }}>
              {agesText(stopYear)}
              {savedStop !== null && stopYear !== savedStop && ` · your plan says ${savedStop}`}
              {savedStop === null && ' · not saved yet'}
            </span>
            {stopYear !== savedStop && (
              <button type="button" className="om-btn" onClick={makeThePlan} disabled={saving}>
                {saving ? 'Saving…' : 'Make this the plan'}
              </button>
            )}
          </div>
        </div>
        {saveError && (
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
            {saveError}
          </p>
        )}
      </section>

      <div className="fc-kpis">
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>When work stops</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmtBalance(shown(result.potAtStop ?? 0, stopYear))}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>The pot at the start of {stopYear}</div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Needed then</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{need === null ? '—' : money.fmt(shown(need, stopYear))}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            To last to {endYear}
            {anyIncome ? ', other income counted' : ''}
          </div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Goals on the way</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmt(goalsTotal)}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {goals.length} goal{goals.length === 1 ? '' : 's'} paid from the pot
          </div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>{result.lasts ? `Left in ${endYear}` : 'Short by'}</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>
            {result.lasts
              ? money.fmtBalance(shown(result.left, endYear + 1))
              : money.fmt(rows.reduce((s, r) => s + shown(r.short, r.year), 0))}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {result.lasts ? 'At the end of the plan' : `Over the years from ${result.shortYear} the pot cannot pay`}
          </div>
        </div>
      </div>

      <section style={{ marginTop: 34 }}>
        <div className="ov-kicker">What it would take</div>
        <div className="fc-solve lp-take">
          {result.lasts ? (
            <span className="fc-solve-answer">
              {earliest !== null && earliest < stopYear ? (
                <>
                  You could stop as early as <b className="fig">{earliest}</b> ({agesText(earliest)})
                </>
              ) : (
                <>{stopYear} is the earliest year that lasts</>
              )}
              {mostSpend !== null && (
                <span className="ov-muted">
                  {' · or, stopping in '}
                  {stopYear}, spend up to {money.code} {money.fmt(shown(mostSpend, stopYear))} a year
                </span>
              )}
            </span>
          ) : shortRow.working ? (
            // A goal the pot cannot pay while still working: stopping later
            // does not help, so the goal itself is the lever.
            <span className="fc-solve-answer">
              The pot is <b className="fig">{money.code} {money.fmt(shown(shortRow.short, shortRow.year))}</b> short for{' '}
              {shortRow.goals.map((g) => g.name).join(', ')} in {shortRow.year}. Move it later or make it smaller
              {extra !== null && (
                <span className="ov-muted">
                  {' · or save '}
                  {money.code} {money.fmt(shown(extra / 12, startYear))} more a month from now
                </span>
              )}
            </span>
          ) : earliest === null && extra === null && mostSpend === null ? (
            <span className="fc-solve-answer">No stop year makes the money last to {endYear} with the goals as they are.</span>
          ) : (
            <span className="fc-solve-answer">
              To last to {endYear}:{' '}
              {[
                earliest !== null && (
                  <span key="stop">
                    stop work in <b className="fig">{earliest}</b> ({agesText(earliest)})
                  </span>
                ),
                extra !== null && (
                  <span key="save">
                    save {money.code} {money.fmt(shown(extra / 12, startYear))} more a month until {stopYear}
                  </span>
                ),
                mostSpend !== null && (
                  <span key="spend">
                    spend at most {money.code} {money.fmt(shown(mostSpend, stopYear))} a year after stopping in {stopYear}
                  </span>
                ),
              ]
                .filter(Boolean)
                .map((part, i) => (
                  <span key={part.key} className={i ? 'ov-muted' : undefined}>
                    {i ? ' · or ' : ''}
                    {part}
                  </span>
                ))}
            </span>
          )}
        </div>
      </section>

      <section style={{ marginTop: 40 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div className="ov-kicker">The pot, year by year</div>
          <div className="ov-muted" style={{ fontSize: 11.5 }}>
            {mode === 'real' ? 'Today’s money' : `Future money, at ${inflationPct.toFixed(1)}% inflation`} · at the start of each year
          </div>
        </div>
        <ColumnChart
          columns={columns}
          series={PHASES}
          height={220}
          formatTick={money.fmtCompact}
          labelEvery={10}
          activeIndex={activeIdx}
          onActiveChange={setActiveYear}
          ariaLabel={`The pot at the start of each year from ${startYear} to ${endYear}, while working and after work stops in ${stopYear}. Use the arrow keys to move between years.`}
        />
        <div className="ov-chart-readout">
          <span className="fig">{active.year}</span>
          <span>{agesText(active.year)}</span>
          <span>
            Pot <b className="fig">{money.fmtBalance(shown(active.start, active.year))}</b>
          </span>
          {active.working ? (
            <span>
              Saved <b className="fig">{money.fmtBalance(shown(active.saving, active.year))}</b>
            </span>
          ) : (
            <span>
              Spent <b className="fig">{money.fmt(shown(active.spend, active.year))}</b>
            </span>
          )}
          {active.inflows.length > 0 && (
            <span>
              {active.inflows.map((i) => i.name).join(', ')} arrives
            </span>
          )}
          {active.income > 0 && (
            <span>
              Other income <b className="fig">{money.fmt(shown(active.income, active.year))}</b>
            </span>
          )}
          {active.goals.length > 0 && (
            <span>
              {active.goals.map((g) => g.name).join(', ')} <b className="fig">{money.fmt(shown(active.goalOutflow, active.year))}</b>
            </span>
          )}
          <span>
            Earned <b className="fig">{money.fmtBalance(shown(active.growth, active.year))}</b>
          </span>
          {active.short > 0 && <span className="ov-neg">Short by {money.fmt(shown(active.short, active.year))}</span>}
        </div>
        <ChartLegend items={PHASES.map((p) => ({ label: p.label, color: p.color }))} />
        <details className="ch-table" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
          <summary>Year by year, as a table</summary>
          <div className="ch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  <th scope="col">Ages</th>
                  <th scope="col">Pot at start</th>
                  <th scope="col">Saved or spent</th>
                  {anyIncome && <th scope="col">Other income</th>}
                  <th scope="col">Goals</th>
                  <th scope="col">Earned</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {tableOpen && rows.map((r, i) => {
                  const notes = [
                    r.year === stopYear && 'Work stops',
                    r.year === firstForOne && 'Planning for one',
                    r.short > 0 && `Short by ${money.fmt(shown(r.short, r.year))}`,
                  ].filter(Boolean);
                  return (
                    <tr key={r.year} data-active={i === activeIdx}>
                      <td className="fig">{r.year}</td>
                      <td>{agesText(r.year)}</td>
                      <td className="fig">{money.fmtBalance(shown(r.start, r.year))}</td>
                      <td className="fig">{r.working ? money.fmtSigned(shown(r.saving, r.year)) : `−${money.fmt(shown(r.spend, r.year))}`}</td>
                      {anyIncome && <td className="fig">{r.income > 0 ? money.fmt(shown(r.income, r.year)) : ''}</td>}
                      <td>{r.goals.length ? `${r.goals.map((g) => g.name).join(', ')} −${money.fmt(shown(r.goalOutflow, r.year))}` : ''}</td>
                      <td className="fig">{money.fmtBalance(shown(r.growth, r.year))}</td>
                      <td className={r.short > 0 ? 'ov-neg' : undefined}>{notes.join(' · ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <GoalsOnTimeline goals={data.goals ?? []} startYear={startYear} money={money} onChanged={data.reload} onOpenTab={onOpenTab} />

      <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 30, lineHeight: 1.7, maxWidth: '92ch' }}>
        {selected.label}: {selected.nominalPct.toFixed(1)}% a year before work stops and {postNominal.toFixed(1)}% after, less {inflationPct.toFixed(1)}%
        inflation. Saving is {money.code} {money.fmtBalance(inputs.monthlySaving)} a month
        {inputs.source === 'budget' ? ', your savings target in the budget' : `, the average of the last ${inputs.monthCount} closed months`}, kept the
        same in today&rsquo;s money until work stops.
        {people.length > 1 && survivorPct !== 100 && ` Once one person remains, spending is ${survivorPct}% of the couple's.`}
        {incomes.length > 0 && ` ${incomes.length} source${incomes.length === 1 ? '' : 's'} of other income from Drawdown count from ${stopYear}.`}
        {uncounted.length > 0 &&
          ` ${uncounted.map((r) => r.name).join(', ')} ${uncounted.length === 1 ? 'is' : 'are'} not counted: no AED/INR rate is set yet (Settings → Household).`}
        {inflows.length > 0 &&
          ` ${inflows.map((i) => `${i.name} (${i.year})`).join(', ')} ${inflows.length === 1 ? 'is' : 'are'} added in ${inflows.length === 1 ? 'its' : 'their'} year, converted at today's rate: the rupee's drift against the dirham is not modelled.`}{' '}
        No tax is
        taken out.
      </div>

      {editor}
    </div>
  );
}

// Every goal with a date is paid out of the pot in its year unless it is money
// kept rather than spent. The choice is saved on the goal.
function GoalsOnTimeline({ goals, startYear, money, onChanged, onOpenTab }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const dated = goals.filter((g) => g.target_date);
  const undated = goals.filter((g) => !g.target_date);

  async function toggle(goal) {
    setBusy(goal.id);
    setError('');
    const { error: saveError } = await supabase.from('goals').update({ counts_in_life_plan: goal.counts_in_life_plan === false }).eq('id', goal.id);
    setBusy(null);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onChanged?.();
  }

  return (
    <section style={{ marginTop: 40 }}>
      <div className="ov-section-head">
        <div className="ov-kicker">Goals on the timeline</div>
        <button type="button" className="om-btn" onClick={() => onOpenTab?.('goals')}>
          Open Goals
        </button>
      </div>
      {goals.length === 0 ? (
        <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch' }}>
          No goals yet. A goal with a date is paid out of the pot in its year: a car, a down payment, a child&rsquo;s education.
        </div>
      ) : (
        <div className="mn-list">
          {dated.map((g) => {
            const year = Math.max(startYear, Number(String(g.target_date).slice(0, 4)));
            const counts = g.counts_in_life_plan !== false;
            return (
              <label key={g.id} className="mn-row lp-goal" data-muted={!counts}>
                <input type="checkbox" checked={counts} disabled={busy === g.id} onChange={() => toggle(g)} />
                <div className="mn-row-main">
                  <div>{g.name}</div>
                  <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>
                    {counts ? `Paid from the pot in ${year}` : 'Kept, not spent: stays in the pot'}
                  </div>
                </div>
                <div className="fig mn-row-amt">{money.fmt(Number(g.target_amount))}</div>
              </label>
            );
          })}
          {undated.map((g) => (
            <div key={g.id} className="mn-row lp-goal" data-muted="true">
              <span aria-hidden="true" style={{ width: 16 }} />
              <div className="mn-row-main">
                <div>{g.name}</div>
                <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>
                  No date, so not on the timeline
                </div>
              </div>
              <div className="fig mn-row-amt">{money.fmt(Number(g.target_amount))}</div>
            </div>
          ))}
        </div>
      )}
      <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.6, maxWidth: '84ch' }}>
        A goal&rsquo;s target is what it costs on its date. Untick one that is money kept rather than spent, such as an emergency fund.
      </div>
      {error && (
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
          {error}
        </p>
      )}
    </section>
  );
}
