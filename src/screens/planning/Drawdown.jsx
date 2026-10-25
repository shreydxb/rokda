import { useMemo, useState } from 'react';
import { drawdownPath, incomesFromStop, independenceTarget, MARKET_FALL, marketReturns, potForWithdrawal, realReturn, scenarioSets, sustainableWithdrawal } from '../../lib/forecast';
import { agesIn, agesLabel, lifePlanHandover, planEndYear } from '../../lib/lifePlan';
import { planningModel } from '../../lib/planningModel';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { LineChart } from '../../charts/Charts';
import BasisLine from './BasisLine';
import LifePlanEditor from './LifePlanEditor';
import { describeIncome, nativeAmountLabel } from '../../lib/planRows';
import AssumptionsBar from './AssumptionsBar';
import { neverLoaded } from '../../lib/loadState';
import { projectionInputs } from './planningSources';
import Withheld from './Withheld';

const MAX_YEARS = 60;
const RETURN_STEP = 0.5;
// The year the market fall starts in, for each choice. The same fall early or
// late: the difference between them is the order of returns and nothing else.
const MARKETS = [
  { key: 'steady', label: 'Steady', fallYear: null },
  { key: 'early', label: 'Fall in year 1', fallYear: 1 },
  { key: 'late', label: 'Fall in year 10', fallYear: 10 },
];
const pct = (r) => `${Math.round(Math.abs(r) * 100)}%`;
// A year's return, signed with the same minus the money figures use.
const returnText = (r) => `${r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(1)}%`;
const FALL_WORDS = `${pct(MARKET_FALL[0])} then ${pct(MARKET_FALL[1])}`;
const lastsText = (years) => (years === null ? `${MAX_YEARS}+ years` : `${years} year${years === 1 ? '' : 's'}`);

// "How long will it last": the spending side of independence, on the same
// basis as Forecast -- the same recorded spend, the same scenarios, the same
// target -- so the two tabs describe one plan from either end. Every figure is
// in today's money: the yearly spend keeps its buying power, the pot grows at
// the real return.
//
// Once the Life plan exists, this is its stress test: it starts where the
// plan leaves the household on the day work stops -- that pot, that spending,
// the years to the plan's end, the same later income -- and asks what a
// market fall or a lower return would do to it. The Life plan answers whether
// the money lasts; this screen answers how much room there is.
//
// The controls are what-ifs; nothing here is saved. The scenario is shared
// with Forecast and Life plan when Planning passes it (AssumptionsBar); the
// rest are held on this screen only.
export default function Drawdown({ household, members = [], accounts = [], transactions = [],
  recurring = [], holdings = [], budgets = [], categories = [], data, sources, onRetry, loading, onReload, onOpenTab, scenario, onScenario }) {
  const { assumptions } = data;
  const money = useMoneyDisplay(household);
  const now = useMemo(() => new Date(), []);
  const [localSet, setLocalSet] = useState('baseline');
  const fcSet = scenario ?? localSet;
  const setFcSet = onScenario ?? setLocalSet;
  // The plan's one drawer, open at one of its sections, or null (Planning
  // audit, 3.13): the growth figures and other income are edited there.
  const [editing, setEditing] = useState(null);
  const [potChoice, setPotKind] = useState(null); // 'plan' | 'target' | 'today'; null follows the plan when there is one
  const [spendChoice, setSpendKind] = useState(null); // 'plan' | 'actual' | 'lean'; null as above
  const [returnOffset, setReturnOffset] = useState(0); // pp added to the scenario's nominal return
  const [lastForChoice, setLastFor] = useState(null); // null: the years the plan needs, or 40
  const [market, setMarket] = useState('steady');
  const [activeYear, setActiveYear] = useState(null);
  // Every row is listed here; the sums below count only income timed from the
  // year work stops, in AED. A sum paid in a set year (a policy maturity) is
  // placed by the Life plan, which runs by calendar year.
  const incomeRows = data.independenceIncome ?? [];
  const incomes = incomesFromStop(incomeRows, household);

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
  const { startNetWorth, plan, inputs, stopping } = model;
  // Where the Life plan leaves the household when work stops, on this
  // screen's scenario. Null until someone's age is set.
  const handover = useMemo(() => {
    const { people } = model;
    // A plan everyone has outlived has no stop year to hand over.
    if (!people.length || !inputs.ready || planEndYear(people) < now.getFullYear()) return null;
    return { ...lifePlanHandover(model.basis({ fcSet })), people };
  }, [model, inputs, now, fcSet]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const missing = neverLoaded(sources, projectionInputs(inputs));
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={onRetry}>
        How long the money lasts isn&rsquo;t worked out, rather than worked out without them.
      </Withheld>
    );
  }

  if (!inputs.ready) {
    return (
      <div className="ov-empty" style={{ marginTop: 22 }}>
        <div className="ov-empty-kicker">Not enough to project</div>
        <div className="ov-empty-body">
          How long money lasts depends on what the household spends and holds: three finished months of recorded spending, or a
          monthly budget until then, and an account valuation. The same inputs Forecast needs.
        </div>
        <div className="ov-empty-actions">
          <button type="button" className="om-btn" onClick={() => onOpenTab?.('forecast')}>
            Open Forecast
          </button>
        </div>
      </div>
    );
  }

  const sets = scenarioSets(assumptions);
  const selected = sets[fcSet] ?? sets.baseline;
  const nominalPct = Math.max(0, selected.nominalPct + returnOffset);
  const rate = realReturn(nominalPct, selected.inflationPct);
  const leanSpend = assumptions?.lean_annual_spend != null ? Number(assumptions.lean_annual_spend) : null;
  const potKind = potChoice ?? (handover ? 'plan' : 'target');
  const spendKind = spendChoice ?? (handover ? 'plan' : 'actual');
  const fromPlan = potKind === 'plan' && handover;
  const spend = spendKind === 'plan' && handover ? handover.spend : spendKind === 'lean' && leanSpend ? leanSpend : inputs.annualSpend;
  // The same target Forecast and the Plan summary show, lasting income and all.
  const { target } = independenceTarget(inputs.annualSpend, selected.swrPct, incomes);
  const pot = fromPlan ? handover.pot : potKind === 'today' ? startNetWorth : target;
  // From the plan, the income is the plan's from its stop year on, the
  // policy maturities that land after it included.
  const drawIncomes = fromPlan ? handover.incomes : incomes;
  const lastFor = lastForChoice ?? (handover ? Math.min(MAX_YEARS, handover.years) : 40);

  const base = { start: pot, annualWithdrawal: spend, rate, maxYears: MAX_YEARS, incomes: drawIncomes };
  const outcomes = MARKETS.map((m) => ({ ...m, ...drawdownPath({ ...base, returns: marketReturns(rate, m.fallYear, MAX_YEARS) }) }));
  const chosen = outcomes.find((o) => o.key === market);
  const steady = outcomes[0];
  const returns = marketReturns(rate, chosen.fallYear, MAX_YEARS);
  const { path, lastsYears } = chosen;
  // Show the run-out and a few empty years after it, not decades of zero.
  const shownYears = lastsYears === null ? MAX_YEARS : Math.min(MAX_YEARS, Math.max(10, lastsYears + 5));
  const shown = path.slice(0, shownYears + 1);
  // A year picked on a longer chart (before switching market or pot) is held
  // to the end of this one.
  const activeIdx = Math.min(activeYear ?? (lastsYears !== null ? lastsYears : shownYears), shownYears);
  const active = shown[activeIdx];

  const maxSpend = sustainableWithdrawal({ start: pot, rate, years: lastFor, incomes: drawIncomes, returns });
  const potNeeded = potForWithdrawal({ annualWithdrawal: spend, rate, years: lastFor, incomes: drawIncomes, returns });
  const fallWhen = chosen.fallYear ? ` A fall of ${FALL_WORDS} after inflation starts in year ${chosen.fallYear}.` : '';
  // What the pot itself pays out in the first year, after other income.
  const withdrawalRate = pot > 0 ? path[1].withdrawn / pot : null;
  const incomeTotal = path.reduce((s, p) => s + p.income, 0);

  return (
    <div>
      <BasisLine inputs={inputs} householdId={household?.id} assumptions={assumptions} onSaved={data.reload} money={money} />
      <AssumptionsBar
        sets={sets}
        scenario={fcSet}
        onScenario={setFcSet}
        growth={[`${selected.swrPct.toFixed(1)}% withdrawal rate`]}
        onEdit={() => setEditing('growth')}
        spending={
          <div className="dd-segs" role="group" aria-label="Spending">
            {handover && (
              <button type="button" className="om-seg" data-active={spendKind === 'plan'} aria-pressed={spendKind === 'plan'} onClick={() => setSpendKind('plan')}>
                Life plan · {money.fmtCompact(handover.spend)} a year
              </button>
            )}
            <button type="button" className="om-seg" data-active={spendKind === 'actual'} aria-pressed={spendKind === 'actual'} onClick={() => setSpendKind('actual')}>
              {inputs.source === 'budget' ? 'Budgeted' : "Today's"} · {money.fmtCompact(inputs.annualSpend)} a year
            </button>
            {leanSpend ? (
              <button type="button" className="om-seg" data-active={spendKind === 'lean'} aria-pressed={spendKind === 'lean'} onClick={() => setSpendKind('lean')}>
                Essentials · {money.fmtCompact(leanSpend)} a year
              </button>
            ) : null}
          </div>
        }
      />
      <section className="pl-hero" style={{ marginTop: 22 }}>
        <div className="ov-kicker">How long it lasts</div>
        <div className="ov-hero fig">
          {pot <= 0 && !drawIncomes.length ? 'Nothing to draw on' : lastsText(lastsYears)}
        </div>
        {fromPlan && (
          <div className="dd-from-plan" style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.6 }}>
            From your Life plan: work stops in <b className="fig">{handover.stopYear}</b> ({agesLabel(agesIn(handover.people, handover.stopYear))}) with{' '}
            {money.code} {money.fmt(pot)}, and has to last {handover.years} years, to {handover.endYear}.{' '}
            {lastsYears === null || lastsYears >= handover.years
              ? `At a steady ${(rate * 100).toFixed(1)}% it does; the fall below shows how much room that leaves.`
              : `At ${(rate * 100).toFixed(1)}% here it runs out ${handover.years - lastsYears} year${handover.years - lastsYears === 1 ? '' : 's'} early.`}{' '}
            {onOpenTab && (
              <button type="button" className="om-link" style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }} onClick={() => onOpenTab('life')}>
                Open Life plan
              </button>
            )}
          </div>
        )}
        <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10, lineHeight: 1.6 }}>
          {pot <= 0 && !drawIncomes.length
            ? 'Net worth today is not above zero, so there is no pot to spend from yet.'
            : lastsYears === null
              ? `Spending ${money.code} ${money.fmt(spend)} a year from ${money.code} ${money.fmt(pot)} never runs it down: growth at ${(rate * 100).toFixed(1)}% real keeps up with the spending.`
              : `Spending ${money.code} ${money.fmt(spend)} a year from ${money.code} ${money.fmt(pot)}, at ${(rate * 100).toFixed(1)}% real, runs out in year ${lastsYears + 1}.`}
          {pot > 0 || drawIncomes.length ? fallWhen : ''}
          {drawIncomes.length > 0 && ` Other income of ${money.code} ${money.fmt(incomeTotal)} over ${MAX_YEARS} years is spent before the pot.`}
        </div>

        <div className="dd-controls">
          <div className="dd-control">
            <span className="dd-label">Start from</span>
            <div className="dd-segs" role="group" aria-label="Start from">
              {handover && (
                <button type="button" className="om-seg" data-active={potKind === 'plan'} aria-pressed={potKind === 'plan'} onClick={() => setPotKind('plan')}>
                  Life plan, {handover.stopYear} · {money.fmtCompact(handover.pot)}
                </button>
              )}
              <button type="button" className="om-seg" data-active={potKind === 'target'} aria-pressed={potKind === 'target'} onClick={() => setPotKind('target')}>
                Your target · {money.fmtCompact(target)}
              </button>
              <button type="button" className="om-seg" data-active={potKind === 'today'} aria-pressed={potKind === 'today'} onClick={() => setPotKind('today')}>
                Stopping today · {money.fmtCompact(startNetWorth)}
              </button>
            </div>
          </div>
          <div className="dd-control">
            <span className="dd-label">Markets</span>
            <div className="dd-segs" role="group" aria-label="Markets">
              {MARKETS.map((m) => (
                <button key={m.key} type="button" className="om-seg" data-active={market === m.key} aria-pressed={market === m.key} onClick={() => setMarket(m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="dd-control">
            <span className="dd-label">Return after independence</span>
            <span className="fc-solve-year">
              <button type="button" className="fc-solve-step" aria-label="Lower return" disabled={nominalPct <= 0} onClick={() => setReturnOffset(returnOffset - RETURN_STEP)}>
                −
              </button>
              <span className="fig" aria-live="polite">
                {nominalPct.toFixed(1)}%
              </span>
              <button type="button" className="fc-solve-step" aria-label="Higher return" onClick={() => setReturnOffset(returnOffset + RETURN_STEP)}>
                +
              </button>
            </span>
            <span className="ov-muted" style={{ fontSize: 11.5 }}>
              nominal · {(rate * 100).toFixed(1)}% after {selected.inflationPct.toFixed(1)}% inflation
              {returnOffset !== 0 && ` · ${returnOffset > 0 ? '+' : '−'}${Math.abs(returnOffset).toFixed(1)} vs ${selected.label}`}
            </span>
          </div>
        </div>
      </section>

      <div className="fc-kpis">
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Drawn from the pot</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{withdrawalRate === null ? '—' : `${(withdrawalRate * 100).toFixed(1)}%`}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>Of the starting pot, in the first year{drawIncomes.length ? ', after other income' : ''}</div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Taken from the pot</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmt(path.reduce((s, p) => s + p.withdrawn, 0))}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {lastsYears === null ? `Over ${MAX_YEARS} years, with the pot still there` : 'Before the pot runs out'}
          </div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Earned by the pot</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmtBalance(path.reduce((s, p) => s + p.growth, 0))}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            Growth on what was left each year{chosen.fallYear ? ', less what the fall took' : ''}
          </div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Left after {MAX_YEARS} years</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmt(path[MAX_YEARS].balance)}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>In today's money</div>
        </div>
      </div>

      <section style={{ marginTop: 34 }}>
        <div className="ov-kicker">Make it last</div>
        <div className="fc-solve">
          <span className="fc-solve-year">
            <button type="button" className="fc-solve-step" aria-label="Five years fewer" disabled={lastFor <= 5} onClick={() => setLastFor(lastFor - 5)}>
              −
            </button>
            <span className="fig" aria-live="polite">
              {lastFor} yrs
            </span>
            <button type="button" className="fc-solve-step" aria-label="Five years more" disabled={lastFor >= MAX_YEARS} onClick={() => setLastFor(lastFor + 5)}>
              +
            </button>
          </span>
          <span className="fc-solve-answer">
            spend at most{' '}
            <b className="fig">
              {money.code} {money.fmt(maxSpend)}
            </b>{' '}
            a year from this pot{chosen.fallYear ? `, even with the fall in year ${chosen.fallYear}` : ''}
            <span className="ov-muted">
              {' · or, to keep spending '}
              {money.fmt(spend)}, start with {money.code} {money.fmt(potNeeded)}
            </span>
          </span>
        </div>
      </section>

      <section style={{ marginTop: 40 }}>
        <div className="ov-section-head">
          <div className="ov-kicker">Other income once working stops</div>
          <button type="button" className="om-btn" onClick={() => setEditing('income')}>
            Edit in the plan
          </button>
        </div>
        {incomeRows.length === 0 ? (
          <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch' }}>
            None added. Rent from a property, part-time or consulting work, or a one-off sum such as an end-of-service gratuity
            would all go here, and each one is spent before the pot is touched.
          </div>
        ) : (
          <div className="mn-list">
            {incomeRows.map((row) => (
              <div key={row.id} className="mn-row" style={{ cursor: 'default' }}>
                <div className="mn-row-main">
                  <div>{row.name}</div>
                  <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>
                    {describeIncome(row, household)}
                  </div>
                </div>
                <div className="fig mn-row-amt">
                  {nativeAmountLabel(row) ?? money.fmt(Number(row.amount))}
                  <span className="ov-muted" style={{ fontSize: 11.5 }}>
                    {row.kind === 'lump_sum' ? ' once' : ' a year'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: 40 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div className="ov-kicker">What is left each year</div>
          <div className="ov-muted" style={{ fontSize: 11.5 }}>
            Today's money · spending taken at the start of each year
          </div>
        </div>
        <LineChart
          points={shown.map((p) => ({ key: p.year, label: `Yr ${p.year}`, value: p.balance }))}
          reference={chosen.fallYear ? { values: steady.path.map((p) => p.balance), label: 'Steady' } : null}
          color="var(--series-1)"
          height={200}
          formatTick={money.fmtCompact}
          labelEvery={shownYears > 30 ? 10 : 5}
          activeIndex={activeIdx}
          onActiveChange={setActiveYear}
          ariaLabel={`What is left of the pot each year of drawing on it, over ${shownYears} years${chosen.fallYear ? `, with a market fall in year ${chosen.fallYear} and the steady path for comparison` : ''}. Use the arrow keys to move between years.`}
        />
        <div className="ov-chart-readout">
          <span className="fig">Year {active.year}</span>
          <span>
            Left <b className="fig">{money.fmt(active.balance)}</b>
          </span>
          <span>
            From the pot <b className="fig">{money.fmt(active.withdrawn)}</b>
          </span>
          {drawIncomes.length > 0 && (
            <span>
              Other income <b className="fig">{money.fmt(active.income)}</b>
            </span>
          )}
          <span>
            Earned <b className="fig">{money.fmtBalance(active.growth)}</b>
          </span>
          {chosen.fallYear && active.year > 0 && (
            <span>
              Return <b className="fig">{returnText(active.rate)}</b>
            </span>
          )}
          {lastsYears !== null && active.year > lastsYears && <span className="ov-neg">Not fully covered</span>}
        </div>
        <details className="ch-table">
          <summary>Year by year, as a table</summary>
          <div className="ch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  {drawIncomes.length > 0 && <th scope="col">Other income</th>}
                  <th scope="col">From the pot</th>
                  <th scope="col">Earned</th>
                  {chosen.fallYear && <th scope="col">Return</th>}
                  <th scope="col">Left</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p, i) => (
                  <tr key={p.year} data-active={i === activeIdx}>
                    <td className="fig">{p.year}</td>
                    {drawIncomes.length > 0 && <td className="fig">{money.fmt(p.income)}</td>}
                    <td className="fig">{money.fmt(p.withdrawn)}</td>
                    <td className="fig">{money.fmtBalance(p.growth)}</td>
                    {chosen.fallYear && <td className="fig">{p.year === 0 ? '' : returnText(p.rate)}</td>}
                    <td className="fig">{money.fmt(p.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      {(pot > 0 || drawIncomes.length > 0) && (
        <section style={{ marginTop: 40 }}>
          <div className="ov-kicker">The same fall, early or late</div>
          <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch', marginTop: 8 }}>
            A steady return every year is an assumption, not a forecast. Here the pot loses {FALL_WORDS} after inflation over two
            years, about what mixed investments lost in a bad stretch such as 2008, and earns the steady return otherwise. The fall
            is the same both times; only when it comes differs.
          </div>
          <div className="fc-kpis dd-markets">
            {outcomes.map((o) => (
              <button key={o.key} type="button" className="fc-kpi dd-market" data-active={market === o.key} aria-pressed={market === o.key} onClick={() => setMarket(o.key)}>
                <div style={{ fontSize: 12, color: 'var(--ink2)' }}>{o.label}</div>
                <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>
                  {lastsText(o.lastsYears)}
                </div>
                <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>{marketNote(o, steady)}</div>
              </button>
            ))}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 14 }}>
            No tax is taken out.
            {fromPlan &&
              ` Spending stays the same every year here: the Life plan's lower spending once one person remains${
                handover.costsAtStop > 0 ? ', the rise in the costs that start when work stops (counted here at what they come to then)' : ''
              }${handover.goalsAfter.length ? `, and ${handover.goalsAfter.map((g) => `${g.name} (${g.year})`).join(', ')},` : ''} are counted there, not here.`}
          </div>
        </section>
      )}

      {editing && (
        <LifePlanEditor
          householdId={household?.id}
          household={household}
          members={members}
          memberLife={data.memberLife ?? []}
          assumptions={assumptions}
          categories={categories}
          spendByCategory={stopping.byCategory}
          incomes={incomeRows}
          costs={data.afterWorkCosts ?? []}
          budgetMonthlySaving={plan?.monthlySaving ?? null}
          scenario={fcSet}
          section={editing}
          onRowsChanged={data.reload}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await Promise.all([data.reload(), onReload?.()]);
          }}
        />
      )}
    </div>
  );
}

// What a market choice did, against the steady path.
function marketNote(o, steady) {
  if (!o.fallYear) return 'The return every year';
  if (steady.lastsYears !== null && steady.lastsYears < o.fallYear - 1) return `The pot is gone before year ${o.fallYear}`;
  if (o.lastsYears === steady.lastsYears) return 'No shorter than steady';
  if (o.lastsYears === null) return `Still ${MAX_YEARS}+ years`;
  if (steady.lastsYears === null) return `Down from ${MAX_YEARS}+ years`;
  const lost = steady.lastsYears - o.lastsYears;
  return `${lost} year${lost === 1 ? '' : 's'} shorter than steady`;
}
