import { useMemo, useState } from 'react';
import { startingNetWorth } from '../overviewMath';
import { drawdownPath, forecastInputs, independenceTarget, potForWithdrawal, realReturn, scenarioSets, sustainableWithdrawal } from '../../lib/forecast';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { LineChart } from '../../charts/Charts';
import IncomeEditor from './IncomeEditor';

const DEFAULTS = { nominal_return_pct: 6.0, inflation_pct: 2.5, safe_withdrawal_pct: 4.0 };
const MAX_YEARS = 60;
const RETURN_STEP = 0.5;

// "How long will it last": the spending side of independence, on the same
// basis as Forecast -- the same recorded spend, the same scenarios, the same
// target -- so the two tabs describe one plan from either end. Every figure is
// in today's money: the yearly spend keeps its buying power, the pot grows at
// the real return.
//
// The controls are what-ifs held on this screen only; nothing here is saved.
export default function Drawdown({ household, accounts = [], transactions = [], holdings = [], data, loading, onOpenTab }) {
  const { assumptions } = data;
  const money = useMoneyDisplay(household);
  const now = useMemo(() => new Date(), []);
  const [fcSet, setFcSet] = useState('baseline');
  const [potKind, setPotKind] = useState('target'); // 'target' | 'today'
  const [spendKind, setSpendKind] = useState('actual'); // 'actual' | 'lean'
  const [returnOffset, setReturnOffset] = useState(0); // pp added to the scenario's nominal return
  const [lastFor, setLastFor] = useState(40);
  const [activeYear, setActiveYear] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | an income row
  const incomes = data.independenceIncome ?? [];

  const startNetWorth = useMemo(() => startingNetWorth(accounts, holdings), [accounts, holdings]);
  const inputs = useMemo(() => forecastInputs(transactions, startNetWorth, now), [transactions, startNetWorth, now]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  if (!inputs.ready) {
    return (
      <div className="ov-empty" style={{ marginTop: 22 }}>
        <div className="ov-empty-kicker">Not enough to project</div>
        <div className="ov-empty-body">
          How long money lasts depends on what the household spends and holds. Both come from recorded activity and account
          valuations, the same inputs Forecast needs.
        </div>
        <div className="ov-empty-actions">
          <button type="button" className="om-btn" onClick={() => onOpenTab?.('forecast')}>
            Open Forecast
          </button>
        </div>
      </div>
    );
  }

  const sets = scenarioSets(assumptions, DEFAULTS);
  const selected = sets[fcSet] ?? sets.baseline;
  const nominalPct = Math.max(0, selected.nominalPct + returnOffset);
  const rate = realReturn(nominalPct, selected.inflationPct);
  const leanSpend = assumptions?.lean_annual_spend != null ? Number(assumptions.lean_annual_spend) : null;
  const spend = spendKind === 'lean' && leanSpend ? leanSpend : inputs.annualSpend;
  // The same target Forecast and the Plan summary show, lasting income and all.
  const { target } = independenceTarget(inputs.annualSpend, selected.swrPct, incomes);
  const pot = potKind === 'today' ? startNetWorth : target;

  const { path, lastsYears } = drawdownPath({ start: pot, annualWithdrawal: spend, rate, maxYears: MAX_YEARS, incomes });
  // Show the run-out and a few empty years after it, not decades of zero.
  const shownYears = lastsYears === null ? MAX_YEARS : Math.min(MAX_YEARS, Math.max(10, lastsYears + 5));
  const shown = path.slice(0, shownYears + 1);
  const activeIdx = activeYear ?? (lastsYears !== null ? Math.min(lastsYears, shownYears) : shownYears);
  const active = shown[activeIdx];

  const maxSpend = sustainableWithdrawal({ start: pot, rate, years: lastFor, incomes });
  const potNeeded = potForWithdrawal({ annualWithdrawal: spend, rate, years: lastFor, incomes });
  // What the pot itself pays out in the first year, after other income.
  const withdrawalRate = pot > 0 ? path[1].withdrawn / pot : null;
  const incomeTotal = path.reduce((s, p) => s + p.income, 0);

  return (
    <div>
      <section className="pl-hero" style={{ marginTop: 22 }}>
        <div className="ov-kicker">How long it lasts</div>
        <div className="ov-hero fig">
          {pot <= 0 && !incomes.length ? 'Nothing to draw on' : lastsYears === null ? `${MAX_YEARS}+ years` : `${lastsYears} year${lastsYears === 1 ? '' : 's'}`}
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10, lineHeight: 1.6 }}>
          {pot <= 0 && !incomes.length
            ? 'Net worth today is not above zero, so there is no pot to spend from yet.'
            : lastsYears === null
              ? `Spending ${money.code} ${money.fmt(spend)} a year from ${money.code} ${money.fmt(pot)} never runs it down: growth at ${(rate * 100).toFixed(1)}% real keeps up with the spending.`
              : `Spending ${money.code} ${money.fmt(spend)} a year from ${money.code} ${money.fmt(pot)}, at ${(rate * 100).toFixed(1)}% real, runs out in year ${lastsYears + 1}.`}
          {incomes.length > 0 && ` Other income of ${money.code} ${money.fmt(incomeTotal)} over ${MAX_YEARS} years is spent before the pot.`}
        </div>

        <div className="dd-controls">
          <div className="dd-control">
            <span className="dd-label">Start from</span>
            <div className="dd-segs">
              <button type="button" className="om-seg" data-active={potKind === 'target'} onClick={() => setPotKind('target')}>
                Your target · {money.fmtCompact(target)}
              </button>
              <button type="button" className="om-seg" data-active={potKind === 'today'} onClick={() => setPotKind('today')}>
                Stopping today · {money.fmtCompact(startNetWorth)}
              </button>
            </div>
          </div>
          <div className="dd-control">
            <span className="dd-label">Spending</span>
            <div className="dd-segs">
              <button type="button" className="om-seg" data-active={spendKind === 'actual'} onClick={() => setSpendKind('actual')}>
                Today's · {money.fmtCompact(inputs.annualSpend)} a year
              </button>
              {leanSpend ? (
                <button type="button" className="om-seg" data-active={spendKind === 'lean'} onClick={() => setSpendKind('lean')}>
                  Essentials · {money.fmtCompact(leanSpend)} a year
                </button>
              ) : null}
            </div>
          </div>
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
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>Of the starting pot, in the first year{incomes.length ? ', after other income' : ''}</div>
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
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmt(path.reduce((s, p) => s + p.growth, 0))}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>Growth on what was left each year</div>
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
            a year from this pot
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
          <button type="button" className="om-btn" onClick={() => setEditing('new')}>
            + Income
          </button>
        </div>
        {incomes.length === 0 ? (
          <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch' }}>
            None added. Rent from a property, part-time or consulting work, or a one-off sum such as an end-of-service gratuity
            would all go here, and each one is spent before the pot is touched.
          </div>
        ) : (
          <div className="mn-list">
            {incomes.map((row) => (
              <button key={row.id} type="button" className="mn-row" onClick={() => setEditing(row)}>
                <div className="mn-row-main">
                  <div>{row.name}</div>
                  <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>
                    {describeIncome(row)}
                  </div>
                </div>
                <div className="fig mn-row-amt">
                  {money.fmt(Number(row.amount))}
                  <span className="ov-muted" style={{ fontSize: 11.5 }}>
                    {row.kind === 'lump_sum' ? ' once' : ' a year'}
                  </span>
                </div>
              </button>
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
          color="var(--series-1)"
          height={200}
          formatTick={money.fmtCompact}
          labelEvery={shownYears > 30 ? 10 : 5}
          activeIndex={activeIdx}
          onActiveChange={setActiveYear}
          ariaLabel={`What is left of the pot each year of drawing on it, over ${shownYears} years. Use the arrow keys to move between years.`}
        />
        <div className="ov-chart-readout">
          <span className="fig">Year {active.year}</span>
          <span>
            Left <b className="fig">{money.fmt(active.balance)}</b>
          </span>
          <span>
            From the pot <b className="fig">{money.fmt(active.withdrawn)}</b>
          </span>
          {incomes.length > 0 && (
            <span>
              Other income <b className="fig">{money.fmt(active.income)}</b>
            </span>
          )}
          <span>
            Earned <b className="fig">{money.fmt(active.growth)}</b>
          </span>
          {lastsYears !== null && active.year > lastsYears && <span className="ov-neg">Not fully covered</span>}
        </div>
        <details className="ch-table">
          <summary>Year by year, as a table</summary>
          <div className="ch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  {incomes.length > 0 && <th scope="col">Other income</th>}
                  <th scope="col">From the pot</th>
                  <th scope="col">Earned</th>
                  <th scope="col">Left</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p, i) => (
                  <tr key={p.year} data-active={i === activeIdx}>
                    <td className="fig">{p.year}</td>
                    {incomes.length > 0 && <td className="fig">{money.fmt(p.income)}</td>}
                    <td className="fig">{money.fmt(p.withdrawn)}</td>
                    <td className="fig">{money.fmt(p.growth)}</td>
                    <td className="fig">{money.fmt(p.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 14, lineHeight: 1.65, maxWidth: '84ch' }}>
          A steady return every year is an assumption, not a forecast. Real markets fall in some years, and a fall early in drawdown
          shortens how long a pot lasts more than the same fall later. No tax is taken out.
        </div>
      </section>

      {editing && (
        <IncomeEditor
          row={editing === 'new' ? null : editing}
          householdId={household?.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await data.reload();
          }}
        />
      )}
    </div>
  );
}

function describeIncome(row) {
  const start = Number(row.starts_after_years) || 0;
  if (row.kind === 'lump_sum') return start === 0 ? 'One-off, in the first year of independence' : `One-off, ${start} year${start === 1 ? '' : 's'} in`;
  const from = start === 0 ? 'From the first year' : `From ${start} year${start === 1 ? '' : 's'} in`;
  const lasts = row.lasts_years == null ? 'for good' : `for ${row.lasts_years} year${Number(row.lasts_years) === 1 ? '' : 's'}`;
  const lowersTarget = start === 0 && row.lasts_years == null ? ' · lowers the target' : '';
  return `${from}, ${lasts}${lowersTarget}`;
}
