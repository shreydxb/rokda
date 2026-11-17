import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNow } from '../../lib/useNow';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { supabase } from '../../lib/supabaseClient';
import { tabHref } from '../../lib/activityLink';
import { incomesWithoutRate } from '../../lib/forecast';
import { agesIn, earliestStop, extraSavingNeeded, lifePlan, maxRetirementSpend, planEndYear, potNeededAt } from '../../lib/lifePlan';
import { agesLabel, costsText, DEFAULT_STOP_AGE, leftOutText, loansText, membersLeftOut, rupeeDrift, stopRange, stressTest } from '../../lib/lifePlanBasis';
import { planBand, shortAtStop, timelineChip, yearRows } from '../../lib/planView';
import { planningModel } from '../../lib/planningModel';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { neverLoaded } from '../../lib/loadState';
import { isDone } from '../../lib/goals';
import { Chip, EmptyState, Fold, InfoButton, KpiStrip, MonthStepper, WarningRow } from '../../design-system/kit';
import { PlanBars } from '../../design-system/charts';
import { Tools } from '../PageTools';
import PlanStrip from './PlanStrip';
import PlanRisks from './PlanRisks';
import LifePlanEditor from './LifePlanEditor';
import NotEnoughToProject from './NotEnoughToProject';
import { projectionInputs } from './planningSources';
import Withheld from './Withheld';
import './Plan.css';

// Planning -> Plan (the revamp, phase 6; design/prototype screens-planning.js):
// the whole of a household's financial life on one timeline, what an
// adviser's "cash adequacy" sheet shows, from the household's own figures. A
// strip with the basis, the scenario and the spending; then When can we
// stop?, What would it take? and What could go wrong? The stop year, the
// scenario and the spending here are what-ifs; the saved plan is changed with
// "Make this the plan" or Edit plan. It was the Life plan, and its sums are
// still lib/lifePlan.js's.

// The scenarios the plan is shown on. Custom went with the revamp: it was
// never used, and Growth under Edit plan sets Baseline, which the other two
// move from.
const SCENARIOS = ['baseline', 'conservative', 'optimistic'];

// One empty list for every missing prop: a fresh [] on each render would work
// the whole plan out again on every step along the chart.
const NONE = [];

export default function Plan({
  household,
  members = NONE,
  me = null,
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
}) {
  const { assumptions } = data;
  const money = useMoneyDisplay(household);
  const now = useNow(data?.loadedAt);
  const startYear = now.getFullYear();
  const { scope } = useScope();
  const householdOnly = resolveScopeMemberId(scope, me, members) !== null;
  // The plan's drawer, open at one of its sections, or null.
  const [editing, setEditing] = useState(null);
  const [fcSet, setFcSet] = useState('baseline');
  const [stopOverride, setStopOverride] = useState(null);
  const [spendKind, setSpendKind] = useState(null); // null follows the saved plan
  const [activeYear, setActiveYear] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // The planning model, built in one place for every tab (lib/planningModel.js;
  // Planning audit, 3.12).
  const model = useMemo(
    () =>
      planningModel({
        accounts,
        holdings,
        transactions,
        recurring,
        budgets,
        categories,
        data: { assumptions, goals: data.goals, memberLife: data.memberLife, independenceIncome: data.independenceIncome, afterWorkCosts: data.afterWorkCosts, debts: data.debts },
        members,
        household,
        now,
      }),
    [accounts, holdings, transactions, recurring, budgets, categories, assumptions, data.goals, data.memberLife, data.independenceIncome, data.afterWorkCosts, data.debts, members, household, now]
  );
  const { inputs, people } = model;
  // Anyone without a birth year and an age to plan to is left out, and says
  // so: the money could seem to last when it runs out before their plan
  // would end (Planning audit, 1.1).
  const leftOut = useMemo(() => membersLeftOut(members, data.memberLife ?? []), [members, data.memberLife]);
  // A goal marked done is off the timeline.
  const openGoals = useMemo(() => (data.goals ?? []).filter((g) => !isDone(g)), [data.goals]);

  // The plan and the answers built on it, worked out once for each change of
  // input rather than on every step along the chart (Planning audit, 0b-E).
  // Null while there is no plan to work out; the states below say why.
  const worked = useMemo(() => {
    if (!inputs.ready || !people.length || planEndYear(people) < startYear) return null;
    const whatIfs = { fcSet, stopOverride, spendKind };
    const basis = model.basis(whatIfs);
    const result = lifePlan(basis.args);
    const onBaseline = model.basis({ ...whatIfs, fcSet: 'baseline' });
    return {
      basis,
      result,
      need: potNeededAt(basis.args),
      earliest: earliestStop(basis.args),
      extra: result.lasts ? 0 : extraSavingNeeded(basis.args),
      mostSpend: maxRetirementSpend(basis.args),
      // Baseline and Conservative at this stop year (Planning audit, 3.12).
      range: stopRange((key) => model.basis({ ...whatIfs, fcSet: key })),
      // The chart's band, Conservative to Optimistic at this stop year.
      band: planBand((key) => model.basis({ ...whatIfs, fcSet: key })),
      // A market fall and a weaker rupee, both on Baseline: on top of
      // Conservative they would count caution twice (3.14, 4.19).
      stress: stressTest(onBaseline),
      drift: rupeeDrift(onBaseline),
    };
  }, [model, inputs, people, startYear, fcSet, stopOverride, spendKind]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const missing = neverLoaded(sources, projectionInputs(inputs));
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={onRetry}>
        The plan isn&rsquo;t worked out, rather than worked out without them.
      </Withheld>
    );
  }

  const editor = editing && (
    <LifePlanEditor
      householdId={household?.id}
      household={household}
      members={members}
      memberLife={data.memberLife ?? []}
      assumptions={assumptions}
      categories={categories}
      spendByCategory={model.stopping.byCategory}
      incomes={data.independenceIncome ?? []}
      costs={data.afterWorkCosts ?? []}
      scenario="baseline"
      section={editing}
      onRowsChanged={data.reload}
      onClose={() => setEditing(null)}
      onSaved={async () => {
        setEditing(null);
        setStopOverride(null);
        setSpendKind(null);
        // The editor also marks which categories stop when work does, and
        // categories are the household's records rather than the plan's, so
        // both are read again.
        await Promise.all([data.reload(), onReload?.()]);
      }}
    />
  );
  const tools = (
    <Tools>
      <button type="button" className="ds-btn" onClick={() => setEditing('people')}>
        Edit plan
      </button>
    </Tools>
  );

  // What the start leaves out, and balances never entered, counted as 0
  // (Planning audit, 3.15).
  const { incomplete, unentered } = model.startGaps;
  const provisional = unentered.length > 0 ? `${unentered.length} balance${unentered.length === 1 ? '' : 's'} not entered, counted as 0` : null;

  if (!inputs.ready) {
    return (
      <>
        {tools}
        <NotEnoughToProject inputs={inputs} startNetWorth={model.startNetWorth} incomplete={incomplete} provisional={provisional} />
        {editor}
      </>
    );
  }

  if (!people.length) {
    return (
      <>
        {tools}
        <EmptyState
          title="Set up the plan"
          body="The plan follows the household year by year, to the end of the longest life expectancy: saving while you work, each goal in its year, then spending once work stops. It needs each person's birth year and the age to plan to."
          action={{ label: 'Add who it is for', onClick: () => setEditing('people') }}
        />
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
        {tools}
        <EmptyState
          title="The plan has run its course"
          body={`It plans for ${people.map((p) => `${p.name} to ${p.lifeExpectancy}`).join(' and ')}, and everyone is past that age now. Plan to a later age to see the years ahead.`}
          action={{ label: 'Plan to a later age', onClick: () => setEditing('people') }}
        />
        {editor}
      </>
    );
  }

  const { basis, result, need, earliest, extra, mostSpend, range, band, stress, drift } = worked;
  const { endYear, sets, selected, inflationPct, postNominal, savedStop, stopYear, spendOptions, spendChoice, survivorPct, goals, incomes, inflows } = basis;
  const aed = (v) => `${money.code} ${money.fmt(v)}`;
  const agesText = (year) => agesLabel(agesIn(people, year));
  // While working the pot can be below zero: debt the saving is repaying
  // (lib/lifePlan.js). Said as what is owed, never as money held.
  // Figures are in dirhams without the code, as the prototype draws them;
  // the AED note above says so when the display currency is another.
  const potText = (value) => (value < 0 ? `${money.fmt(value)} still owed` : money.fmtBalance(value));
  const rows = result.rows;
  const shortRow = result.shortYear !== null ? rows.find((r) => r.year === result.shortYear) : null;
  const anyIncome = incomes.length > 0 || inflows.length > 0;
  const uncounted = incomesWithoutRate([...(data.independenceIncome ?? []), ...(data.afterWorkCosts ?? [])], household);
  const short = shortAtStop({ result, need });

  async function makeThePlan() {
    setSaving(true);
    setSaveError('');
    const { error } = await supabase.from('planning_assumptions').upsert({ household_id: household.id, retirement_year: stopYear }, { onConflict: 'household_id' });
    setSaving(false);
    if (error) {
      setSaveError(`The stop year wasn't saved: ${error.message}`);
      return;
    }
    setStopOverride(null);
    await data.reload();
  }

  // Where the year comes from: the one saved, one being tried, or the one
  // assumed until a year is chosen, never the zero-margin earliest year,
  // which is a lever below (Planning audit, 3.12).
  const trying = stopOverride !== null && stopYear !== savedStop;
  const yearSource = trying
    ? savedStop !== null
      ? `trying it: your plan says ${savedStop}`
      : 'trying it: no year saved yet'
    : savedStop !== null
      ? 'your plan'
      : basis.stopAssumed && stopYear === basis.stopAssumed.birthYear + DEFAULT_STOP_AGE
        ? `assumed: the year ${basis.stopAssumed.name} turns ${DEFAULT_STOP_AGE}`
        : 'assumed until you choose a year';

  // What the plan assumes beyond the rates, behind their (i): the Life plan's
  // Assumptions paragraph.
  const assumptionsText = [
    `${selected.label}: ${selected.nominalPct.toFixed(1)}% a year before work stops and ${postNominal.toFixed(1)}% after, less ${inflationPct.toFixed(1)}% inflation.`,
    `Saving is ${money.code} ${money.fmtBalance(inputs.monthlySaving)} a month${inputs.source === 'budget' ? ', your savings target in the budget' : `, the average of the last ${inputs.monthCount} ended months`}, kept the same in today's money until work stops.`,
    basis.cashPot > 0 && `The ${aed(basis.cashPot)} held in cash and deposits today stays cash at ${basis.cashNominal.toFixed(1)}% a year; the rest earns the return.`,
    loansText(basis.loans, basis.owedOnLoans, aed),
    people.length > 1 && survivorPct !== 100 && `Once one person remains, spending is ${survivorPct}% of the couple's.`,
    costsText(basis.costs, aed),
    incomes.length > 0 && `${incomes.length} source${incomes.length === 1 ? '' : 's'} of other income count from ${stopYear}.`,
    inflows.length > 0 &&
      `${inflows.map((i) => `${i.name} (${i.year})`).join(', ')} ${inflows.length === 1 ? 'is' : 'are'} added in ${inflows.length === 1 ? 'its' : 'their'} year, converted at today's rate.`,
    'No tax is taken out.',
  ]
    .filter(Boolean)
    .join(' ');

  const warnings = [
    leftOut.length > 0 && { key: 'left', text: leftOutText(leftOut), action: { label: 'Add them', onClick: () => setEditing('people') } },
    (incomplete || provisional) && {
      key: 'start',
      text: [incomplete && `The start ${incomplete}.`, provisional && `Provisional: ${provisional}.`].filter(Boolean).join(' '),
      action: { label: 'Open Net worth', href: '/wealth' },
    },
    uncounted.length > 0 && {
      key: 'rate',
      text: `${uncounted.map((r) => r.name).join(', ')} ${uncounted.length === 1 ? 'is' : 'are'} not counted: no AED/INR rate is set yet.`,
      action: { label: 'Open Settings', href: '/settings' },
    },
  ].filter(Boolean);

  const activeIdx = Math.min(activeYear ?? Math.max(0, rows.findIndex((r) => r.year === (result.shortYear ?? stopYear))), rows.length - 1);
  const active = rows[activeIdx];
  const goalsTotal = goals.reduce((s, g) => s + g.amount, 0);
  const verdict = (r) => (
    <Chip key={r.key} tone={r.lasts ? 'pos' : 'neg'}>
      {`${r.label}: ${r.lasts ? `lasts to ${r.endYear}` : `${r.shortWorking ? 'short' : 'runs out'} ${r.shortYear}`}`}
    </Chip>
  );

  return (
    <div className="pl">
      {tools}
      <PlanStrip
        inputs={inputs}
        householdId={household?.id}
        assumptions={assumptions}
        onSaved={data.reload}
        money={money}
        scenarios={SCENARIOS.map((key) => ({ key, label: sets[key].label }))}
        scenario={fcSet}
        onScenario={setFcSet}
        spendOptions={spendOptions}
        spendKey={spendChoice.key}
        onSpend={setSpendKind}
        rates={`${selected.nominalPct.toFixed(1)}% return · ${inflationPct.toFixed(1)}% inflation`}
        assumptionsText={assumptionsText}
        householdOnly={householdOnly}
      />

      <h2 className="pl-band-h">When can we stop?</h2>
      <section className="ds-card pl-stop" aria-label="When can we stop?">
        {(warnings.length > 0 || saveError) && (
          <div className="pl-warns">
            {warnings.map((w) => (
              <WarningRow key={w.key} action={w.action}>
                {w.text}
              </WarningRow>
            ))}
            {saveError && (
              <WarningRow tone="neg">
                <span role="alert">{saveError}</span>
              </WarningRow>
            )}
          </div>
        )}
        <div className="pl-stop-grid">
          <div className="pl-stop-l">
            <div>
              <div className="pl-label">Stopping in</div>
              <div className="ds-hero pl-stop-year">{stopYear}</div>
              <div className="pl-sub">
                {agesText(stopYear)} · {yearSource}
              </div>
            </div>
            <div className="pl-verdicts">{range.map(verdict)}</div>
            <dl className="pl-figs">
              <dt>
                <span>{`Pot in ${stopYear}`}</span>
              </dt>
              <dd>{potText(result.potAtStop ?? 0)}</dd>
              <dt>
                <span>Needed then</span>
                <InfoButton about="Needed then">{`What the pot must hold in ${stopYear} to last to ${endYear}${anyIncome ? ', with other income counted' : ''}.`}</InfoButton>
              </dt>
              <dd>{need === null ? '—' : money.fmt(need)}</dd>
              <dt>
                <span>Goals on the way</span>
              </dt>
              <dd>{money.fmt(goalsTotal)}</dd>
              {result.lasts ? (
                <>
                  <dt>
                    <span>{`Left in ${endYear}`}</span>
                  </dt>
                  <dd className="ds-pos">{money.fmtBalance(result.left)}</dd>
                </>
              ) : (
                <>
                  <dt>
                    <span>Short by</span>
                  </dt>
                  <dd className="ds-neg">{short === null ? '—' : money.fmt(short)}</dd>
                </>
              )}
            </dl>
            <div className="pl-stop-row">
              <div className="pl-stepper">
                <span className="pl-sub">Stop working</span>
                <MonthStepper
                  label={String(stopYear)}
                  unit="year"
                  onPrev={() => setStopOverride(stopYear - 1)}
                  onNext={() => setStopOverride(stopYear + 1)}
                  prevDisabled={stopYear <= startYear}
                  nextDisabled={stopYear >= endYear}
                />
              </div>
              {stopYear !== savedStop && (
                <div className="pl-unsaved">
                  <Chip tone="warn">Not saved</Chip>
                  <span className="pl-grow" />
                  {stopOverride !== null && (
                    <button type="button" className="ds-link" onClick={() => setStopOverride(null)}>
                      Reset
                    </button>
                  )}
                  <button type="button" className="ds-btn ds-btn-sm" onClick={makeThePlan} disabled={saving}>
                    {saving ? 'Saving…' : 'Make this the plan'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="pl-stop-r">
            <div className="ds-card-head">
              <div className="ds-card-title">
                <h3>The pot, year by year</h3>
                <InfoButton about="The pot, year by year">
                  Today&rsquo;s money, at the start of each year, on the scenario chosen above. The grey band runs from Conservative to Optimistic. A diamond marks a goal the pot pays in
                  its year.
                </InfoButton>
              </div>
              <ul className="ds-legend pl-legend">
                <li>
                  <span className="ds-swatch pl-sw-working" />
                  Working
                </li>
                <li>
                  <span className="ds-swatch pl-sw-after" />
                  After work
                </li>
                <li>
                  <span className="ds-swatch pl-sw-range" />
                  Range
                </li>
              </ul>
            </div>
            <div className="ds-card-body">
              <PlanBars
                years={rows.map((r, i) => ({
                  key: r.year,
                  year: r.year,
                  value: r.start,
                  after: !r.working,
                  low: band.low[i],
                  high: band.high[i],
                  goal: r.goals.length ? r.goals.map((g) => g.name).join(', ') : null,
                }))}
                stopYear={stopYear}
                runsOutYear={!result.lasts && !shortRow?.working ? result.shortYear : null}
                height={250}
                formatTick={money.fmtCompact}
                activeIndex={activeIdx}
                onActiveChange={setActiveYear}
                ariaLabel={`The pot at the start of each year from ${startYear} to ${endYear}, work stopping in ${stopYear}. Use the arrow keys to move between years.`}
              />
              <div className="pl-readout">
                <span className="ds-fig">{active.year}</span>
                <span>{agesText(active.year)}</span>
                <span>
                  Pot <b>{money.fmtBalance(active.start)}</b>
                </span>
                <span>
                  Range <b>{money.fmtCompact(band.low[activeIdx])}</b> to <b>{money.fmtCompact(band.high[activeIdx])}</b>
                </span>
                {active.working ? (
                  <span>
                    Saved <b>{money.fmtBalance(active.saving)}</b>
                  </span>
                ) : (
                  <span>
                    Spent <b>{money.fmt(active.spend)}</b>
                  </span>
                )}
                {active.income > 0 && (
                  <span>
                    Other income <b>{money.fmt(active.income)}</b>
                  </span>
                )}
                {active.goals.length > 0 && (
                  <span>
                    {active.goals.map((g) => g.name).join(', ')} <b>{money.fmt(active.goalOutflow)}</b>
                  </span>
                )}
                {active.short > 0 && <span className="ds-neg">Short by {money.fmt(active.short)}</span>}
              </div>
            </div>
          </div>
        </div>
        <Fold label="Year by year">
          <table className="ds-table pl-years">
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Ages</th>
                <th scope="col" className="pl-num">
                  Pot at start
                </th>
                <th scope="col">
                  <span className="om-sr">Where the plan is</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {yearRows(result, { startYear, stopYear }).map((r) => (
                <tr key={r.year}>
                  <td className="pl-mono">{r.year}</td>
                  <td className="pl-ink2">{agesText(r.year)}</td>
                  <td className="pl-num">{money.fmtBalance(r.start)}</td>
                  <td>
                    {r.status === 'stop' ? (
                      <Chip tone="accent">Work stops</Chip>
                    ) : r.status === 'empty' ? (
                      <Chip tone="neg">Nothing left</Chip>
                    ) : (
                      <span className="ds-muted">{r.status === 'working' ? 'Working' : 'After work'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fold>
        <Fold label="Goals on the timeline">
          {openGoals.length === 0 ? (
            <p className="ds-muted pl-none">No goals yet. A goal with a date is paid out of the pot in its year.</p>
          ) : (
            <div className="pl-goals">
              {openGoals.map((g) => {
                const chip = timelineChip(g, { now, result });
                return (
                  <Link key={g.id} className="pl-goal" to={tabHref('/planning', 'goals', { goal: g.id })}>
                    <span className="pl-goal-name">{g.name}</span>
                    <span className="pl-num">{money.fmt(Number(g.target_amount))}</span>
                    <Chip tone={chip.tone}>{chip.label}</Chip>
                  </Link>
                );
              })}
            </div>
          )}
        </Fold>
      </section>

      <h2 className="pl-band-h">What would it take?</h2>
      <Levers
        result={result}
        shortRow={shortRow}
        earliest={earliest}
        extra={extra}
        mostSpend={mostSpend}
        stopYear={stopYear}
        endYear={endYear}
        costs={basis.costs}
        scenarioLabel={selected.label}
        agesText={agesText}
        money={money}
        onTry={setStopOverride}
      />

      <h2 className="pl-band-h">What could go wrong?</h2>
      <PlanRisks stress={stress} drift={drift} money={money} />

      {editor}
    </div>
  );
}

// What would make the money last (design/prototype leversCard): stop later,
// save more or spend less, each found by the plan's own solver. When it
// already lasts, how early work could stop. A goal the pot can't pay while
// still working is its own answer: stopping later doesn't help.
function Levers({ result, shortRow, earliest, extra, mostSpend, stopYear, endYear, costs, scenarioLabel, agesText, money, onTry }) {
  const aed = (v) => money.fmt(v);
  const tryButton = (year) => (
    <button type="button" className="ds-btn ds-btn-sm" onClick={() => onTry(year)}>
      Try
    </button>
  );
  if (result.lasts) {
    return (
      <section className="ds-card pl-levers" aria-label="What would it take?">
        <div className="pl-lasts">
          <Chip tone="pos">{`Lasts to ${endYear}`}</Chip>
          <span className="pl-ink2">{`Nothing more is needed on ${scenarioLabel}.`}</span>
          <span className="pl-grow" />
          <span className="ds-muted">Left at the end</span>
          <span className="pl-fig-s">{money.fmtBalance(result.left)}</span>
        </div>
        {earliest !== null && earliest < stopYear && (
          <div className="pl-earliest">
            <span className="ds-muted">{`Could stop as early as ${earliest} (${agesText(earliest)}), with nothing to spare`}</span>
            {tryButton(earliest)}
          </div>
        )}
      </section>
    );
  }
  if (shortRow?.working) {
    return (
      <section className="ds-card pl-levers" aria-label="What would it take?">
        <p className="pl-goal-short">
          {`The pot is ${aed(shortRow.short)} short for ${shortRow.goals.map((g) => g.name).join(', ')} in ${shortRow.year}. Move it later or make it smaller`}
          {extra !== null && <span className="ds-muted">{` · or save ${aed(extra / 12)} more a month from now`}</span>}
        </p>
      </section>
    );
  }
  return (
    <section className="ds-card pl-levers" aria-label="What would it take?">
      <KpiStrip
        items={[
          {
            label: 'Stop in',
            value: earliest !== null ? String(earliest) : '—',
            sub:
              earliest !== null ? (
                <span className="pl-kpi-try">
                  <span>{agesText(earliest)}</span>
                  {tryButton(earliest)}
                </span>
              ) : (
                'No stop year makes it last'
              ),
          },
          {
            label: 'or save',
            value:
              extra !== null ? (
                <>
                  {aed(extra / 12)} <span className="pl-unit">more a month</span>
                </>
              ) : (
                '—'
              ),
            sub: extra !== null ? `from now until ${stopYear}` : 'Saving alone is not enough',
          },
          {
            label: 'or spend at most',
            value:
              mostSpend !== null ? (
                <>
                  {aed(mostSpend)} <span className="pl-unit">a year</span>
                </>
              ) : (
                '—'
              ),
            sub: mostSpend !== null ? `after ${stopYear}${costs.length ? ', besides the costs that start then' : ''}` : 'No level of spending lasts',
          },
        ]}
      />
    </section>
  );
}
