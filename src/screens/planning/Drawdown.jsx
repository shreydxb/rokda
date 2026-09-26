import { useMemo, useState } from 'react';
import { startingNetWorth } from '../overviewMath';
import { drawdownPath, fiTarget, forecastInputs, potForWithdrawal, realReturn, scenarioSets, sustainableWithdrawal } from '../../lib/forecast';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { LineChart } from '../../charts/Charts';

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
  const target = fiTarget(inputs.annualSpend, selected.swrPct);
  const pot = potKind === 'today' ? startNetWorth : target;

  const { path, lastsYears } = drawdownPath({ start: pot, annualWithdrawal: spend, rate, maxYears: MAX_YEARS });
  // Show the run-out and a few empty years after it, not decades of zero.
  const shownYears = lastsYears === null ? MAX_YEARS : Math.min(MAX_YEARS, Math.max(10, lastsYears + 5));
  const shown = path.slice(0, shownYears + 1);
  const activeIdx = activeYear ?? (lastsYears !== null ? Math.min(lastsYears, shownYears) : shownYears);
  const active = shown[activeIdx];

  const maxSpend = sustainableWithdrawal({ start: pot, rate, years: lastFor });
  const potNeeded = potForWithdrawal({ annualWithdrawal: spend, rate, years: lastFor });
  const withdrawalRate = pot > 0 ? spend / pot : null;

  return (
    <div>
      <section className="pl-hero" style={{ marginTop: 22 }}>
        <div className="ov-kicker">How long it lasts</div>
        <div className="ov-hero fig">
          {pot <= 0 ? 'Nothing to draw on' : lastsYears === null ? `${MAX_YEARS}+ years` : `${lastsYears} year${lastsYears === 1 ? '' : 's'}`}
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10, lineHeight: 1.6 }}>
          {pot <= 0
            ? 'Net worth today is not above zero, so there is no pot to spend from yet.'
            : lastsYears === null
              ? `Spending ${money.code} ${money.fmt(spend)} a year from ${money.code} ${money.fmt(pot)} never runs it down: growth at ${(rate * 100).toFixed(1)}% real keeps up with the spending.`
              : `Spending ${money.code} ${money.fmt(spend)} a year from ${money.code} ${money.fmt(pot)}, at ${(rate * 100).toFixed(1)}% real, runs out in year ${lastsYears + 1}.`}
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
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Withdrawal rate</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{withdrawalRate === null ? '—' : `${(withdrawalRate * 100).toFixed(1)}%`}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>Of the starting pot, in the first year</div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Spent in total</div>
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
            Spent <b className="fig">{money.fmt(active.withdrawn)}</b>
          </span>
          <span>
            Earned <b className="fig">{money.fmt(active.growth)}</b>
          </span>
          {active.year > 0 && active.withdrawn < spend - 1e-3 && <span className="ov-neg">{active.withdrawn > 0 ? 'Only partly covered' : 'Nothing left'}</span>}
        </div>
        <details className="ch-table">
          <summary>Year by year, as a table</summary>
          <div className="ch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  <th scope="col">Spent</th>
                  <th scope="col">Earned</th>
                  <th scope="col">Left</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p, i) => (
                  <tr key={p.year} data-active={i === activeIdx}>
                    <td className="fig">{p.year}</td>
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
    </div>
  );
}
