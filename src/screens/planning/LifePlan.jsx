import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { startingNetWorth } from '../overviewMath';
import { annualSpendByCategory, budgetPlan, forecastInputs, spendThatStops } from '../../lib/forecast';
import { agesIn, agesLabel, earliestStop, extraSavingNeeded, lifePlan, lifePlanBasis, maxRetirementSpend, planPeople, potNeededAt } from '../../lib/lifePlan';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { ChartLegend, ColumnChart } from '../../charts/Charts';
import BudgetBasis from './BudgetBasis';
import LifePlanEditor from './LifePlanEditor';

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
export default function LifePlan({
  household,
  members = [],
  accounts = [],
  transactions = [],
  holdings = [],
  budgets = [],
  categories = [],
  data,
  loading,
  onOpenTab,
}) {
  const { assumptions } = data;
  const money = useMoneyDisplay(household);
  const now = useMemo(() => new Date(), []);
  const startYear = now.getFullYear();
  const [editing, setEditing] = useState(false);
  const [fcSet, setFcSet] = useState('baseline');
  const [stopOverride, setStopOverride] = useState(null);
  const [spendKind, setSpendKind] = useState(null); // null follows the saved plan
  const [mode, setMode] = useState('real');
  const [activeYear, setActiveYear] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const startNetWorth = useMemo(() => startingNetWorth(accounts, holdings), [accounts, holdings]);
  const plan = useMemo(() => budgetPlan(budgets, categories, now), [budgets, categories, now]);
  const inputs = useMemo(() => forecastInputs(transactions, startNetWorth, now, plan), [transactions, startNetWorth, now, plan]);
  const stopping = useMemo(() => spendThatStops({ inputs, transactions, budgets, categories, now }), [inputs, transactions, budgets, categories, now]);

  // The people planned for: members with a birth year and an age to plan to.
  const people = useMemo(() => planPeople(members, data.memberLife ?? []), [members, data.memberLife]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const editor = editing && (
    <LifePlanEditor
      householdId={household?.id}
      members={members}
      memberLife={data.memberLife ?? []}
      assumptions={assumptions}
      categories={categories}
      spendByCategory={annualSpendByCategory({ inputs, transactions, budgets, categories, now })}
      onClose={() => setEditing(false)}
      onSaved={async () => {
        setEditing(false);
        setStopOverride(null);
        setSpendKind(null);
        await data.reload();
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

  const basis = lifePlanBasis({
    people,
    assumptions,
    inputs,
    startNetWorth,
    goals: data.goals ?? [],
    incomes: data.independenceIncome ?? [],
    household,
    stopping,
    startYear,
    fcSet,
    stopOverride,
    spendKind,
  });
  const { endYear, sets, selected, inflationPct, postNominal, savedStop, stopYear, spendOptions, spendChoice, survivorPct, goals, incomes, inflows, args } = basis;
  const anyIncome = incomes.length > 0 || inflows.length > 0;
  const result = lifePlan(args);
  const need = potNeededAt(args);
  const earliest = earliestStop(args);
  const extra = result.lasts ? 0 : extraSavingNeeded(args);
  const mostSpend = maxRetirementSpend(args);

  // Today's money, or grown with inflation to the year it happens -- the way
  // an adviser's sheets show it.
  const inflation = inflationPct / 100;
  const shown = (value, year) => (mode === 'nominal' ? value * (1 + inflation) ** (year - startYear) : value);
  const agesText = (year) => agesLabel(agesIn(people, year));

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
    heroText = `Stopping work in ${stopYear} (${agesText(stopYear)}) with ${money.code} ${money.fmt(shown(result.potAtStop, stopYear))} by then, and spending ${spendText} after, the money lasts to ${endYear}, the year ${lastPerson.name} turns ${lastPerson.lifeExpectancy}, with ${money.code} ${money.fmtBalance(shown(result.left, endYear + 1))} left.`;
  } else if (shortRow.working) {
    const names = shortRow.goals.map((g) => g.name).join(', ');
    heroText = names
      ? `${names} in ${result.shortYear} needs ${money.code} ${money.fmt(shown(shortRow.goalOutflow, shortRow.year))}; the pot will hold ${money.code} ${money.fmt(shown(shortRow.start, shortRow.year))} by then, before that year's saving.`
      : `Spending more than is earned while working uses up the pot in ${result.shortYear}.`;
  } else {
    heroText = `Stopping work in ${stopYear} (${agesText(stopYear)}) with ${money.code} ${money.fmt(shown(result.potAtStop, stopYear))} by then, and spending ${spendText} after, the money runs out in ${result.shortYear} (${agesText(result.shortYear)}), ${endYear - result.shortYear + 1} year${endYear - result.shortYear + 1 === 1 ? '' : 's'} before the plan ends.`;
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
      <section className="pl-hero" style={{ marginTop: 22 }}>
        <div className="ov-section-head">
          <div className="ov-kicker">Life plan</div>
          <button type="button" className="om-btn" onClick={() => setEditing(true)}>
            Edit plan
          </button>
        </div>
        <div className={`ov-hero fig ${result.lasts ? '' : 'ov-neg'}`}>{heroFigure}</div>
        <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10, lineHeight: 1.6, maxWidth: '92ch' }}>{heroText}</div>

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
          <div className="dd-control">
            <span className="dd-label">Spending after</span>
            <div className="dd-segs">
              {spendOptions.map((o) => (
                <button key={o.key} type="button" className="om-seg" data-active={spendChoice.key === o.key} onClick={() => setSpendKind(o.key)}>
                  {o.label} · {money.fmtCompact(o.value)} a year
                </button>
              ))}
            </div>
          </div>
          {spendChoice.key === 'less' && (
            <div className="ov-muted lp-stops" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
              Leaves out {stopping.categories.map((c) => `${c.name} ${money.fmtCompact(c.annual)}`).join(', ')} a year, expected to have stopped by then.{' '}
              <button type="button" className="om-link" style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }} onClick={() => setEditing(true)}>
                Change
              </button>
            </div>
          )}
          <div className="dd-control">
            <span className="dd-label">Scenario</span>
            <div className="dd-segs">
              {Object.values(sets).map((s) => (
                <button key={s.key} type="button" className="om-seg" data-active={fcSet === s.key} onClick={() => setFcSet(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="dd-control">
            <span className="dd-label">Show</span>
            <div className="dd-segs">
              <button type="button" className="om-seg" data-active={mode === 'real'} onClick={() => setMode('real')}>
                Today&rsquo;s money
              </button>
              <button type="button" className="om-seg" data-active={mode === 'nominal'} onClick={() => setMode('nominal')}>
                Future money
              </button>
            </div>
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
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmt(shown(result.potAtStop ?? 0, stopYear))}</div>
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
              {shortRow.goals.length ? (
                <>
                  The pot is <b className="fig">{money.code} {money.fmt(shown(shortRow.short, shortRow.year))}</b> short for{' '}
                  {shortRow.goals.map((g) => g.name).join(', ')} in {shortRow.year}. Move it later or make it smaller
                </>
              ) : (
                <>Spending more than is earned empties the pot in {shortRow.year}</>
              )}
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
            Pot <b className="fig">{money.fmt(shown(active.start, active.year))}</b>
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
        <details className="ch-table">
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
                {rows.map((r, i) => {
                  const notes = [
                    r.year === stopYear && 'Work stops',
                    r.year === firstForOne && 'Planning for one',
                    r.short > 0 && `Short by ${money.fmt(shown(r.short, r.year))}`,
                  ].filter(Boolean);
                  return (
                    <tr key={r.year} data-active={i === activeIdx}>
                      <td className="fig">{r.year}</td>
                      <td>{agesText(r.year)}</td>
                      <td className="fig">{money.fmt(shown(r.start, r.year))}</td>
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
