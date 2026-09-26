import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatPct } from '../../lib/money';
import { incompleteNote, netWorthSummary, startingNetWorth } from '../overviewMath';
import { isArchived } from '../../lib/accounts';
import { unconfirmedAccounts } from '../../lib/balance';
import { closedMonths, crossingYear, fiTarget, forecastInputs, independenceTarget, projectYears, realReturn, requiredAnnualSaving, goalAt, scenarioSets } from '../../lib/forecast';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import ForecastAssumptionsEditor from './ForecastAssumptionsEditor';
import { ChartLegend, ColumnChart } from '../../charts/Charts';

const DEFAULTS = { nominal_return_pct: 6.0, inflation_pct: 2.5, safe_withdrawal_pct: 4.0 };
const HORIZON_YEARS = 30;
const SOLVE_MAX_YEARS = 60;

// Fixed order, so each part keeps its colour whatever the numbers do.
const PARTS = [
  { key: 'start', label: 'Net worth today', color: 'var(--series-1)' },
  { key: 'saved', label: 'Saving from here on', color: 'var(--series-2)' },
  { key: 'growth', label: 'Growth', color: 'var(--series-3)' },
];

function yearsDelta(fromYear, toYear) {
  if (fromYear === null || toYear === null) return null;
  return toYear - fromYear;
}

function deltaLabel(years) {
  if (years === null) return null;
  if (years === 0) return 'no change';
  return `${years > 0 ? '+' : '−'}${Math.abs(years)} yr${Math.abs(years) === 1 ? '' : 's'}`;
}

// `holdings` is passed in explicitly rather than read off the planning data
// object, which never had a holdings field: reading `data.holdings` crashed
// with no accounts and silently dropped holdings from net worth with
// accounts (QA-03).
export default function Forecast({ household, accounts = [], transactions = [], holdings = [], data, loading }) {
  const navigate = useNavigate();
  const householdId = household?.id;
  const { assumptions } = data;
  const [mode, setMode] = useState('real');
  const [fcSet, setFcSet] = useState('baseline');
  const [editing, setEditing] = useState(false);
  // Which projected year the chart and its readout are on; null follows the
  // default (the crossing year, or the end of the horizon).
  const [activeYear, setActiveYear] = useState(null);
  // The year the "what it would take" line solves for; null is the default.
  const [solveYear, setSolveYear] = useState(null);
  // Every figure on this screen follows the display currency, not only the
  // hero: a USD hero above AED detail lines read as two different targets.
  const money = useMoneyDisplay(household);

  const now = useMemo(() => new Date(), []);
  const startYear = now.getFullYear();

  const startNetWorth = useMemo(() => startingNetWorth(accounts, holdings), [accounts, holdings]);
  // A projection resting on balances nobody has confirmed is still worth
  // showing -- it is the household's best available picture -- but it must not
  // present itself as settled. Same call Overview makes about net worth
  // (QA-02), so the two screens agree about the same doubt rather than one
  // withholding what the other displays.
  const basisProvisional = useMemo(
    () => unconfirmedAccounts((accounts ?? []).filter((a) => !isArchived(a))).length > 0,
    [accounts],
  );
  // A different kind of doubt again, and the one this screen used to miss
  // entirely (QA #4). "Provisional" means a number nobody has re-checked
  // lately. This means a number that is not in the basis AT ALL: an account
  // in another currency with no AED conversion is skipped by
  // startingNetWorth, so a household with AED 100 in savings and an
  // unconverted foreign loan projected from 100 with no hint that a debt was
  // dropped. Confirming that loan's balance does nothing about it, which is
  // why the provisional flag never fired.
  //
  // A holding that has never been valued is the same kind of gap: it is not in
  // the basis either (SHR-292). Both counts come from the one household-wide
  // summary startingNetWorth itself uses, so the note and the figure agree.
  const basisGaps = useMemo(() => {
    const s = netWorthSummary(accounts ?? [], null, holdings ?? []);
    return { accounts: s.unvalued, holdings: s.unpricedHoldings };
  }, [accounts, holdings]);
  const basisIncomplete = incompleteNote(basisGaps, { capitalised: false, sentence: false });
  const monthCount = closedMonths(transactions, now).size;
  const inputs = useMemo(() => forecastInputs(transactions, startNetWorth, now), [transactions, startNetWorth, now]);

  const nominalPct = assumptions?.nominal_return_pct != null ? Number(assumptions.nominal_return_pct) : DEFAULTS.nominal_return_pct;
  const inflationPct = assumptions?.inflation_pct != null ? Number(assumptions.inflation_pct) : DEFAULTS.inflation_pct;
  const leanSpend = assumptions?.lean_annual_spend != null ? Number(assumptions.lean_annual_spend) : null;
  const hasBaseline = !!assumptions?.baseline_set_at;

  const sets = scenarioSets(assumptions, DEFAULTS);
  const selected = sets[fcSet] ?? sets.baseline;
  const selNominalPct = selected.nominalPct;
  const selInflationPct = selected.inflationPct;
  const selSwrPct = selected.swrPct;

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  if (!inputs.ready) {
    return (
      <div style={{ marginTop: 34, borderTop: '1px solid var(--rule)', paddingTop: 40, maxWidth: 660 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink3)', fontFamily: "'IBM Plex Mono',monospace" }}>
          Not enough to project
        </div>
        <div className="fig" style={{ fontSize: 26, marginTop: 13, lineHeight: 1.3 }}>
          A forecast needs something to forecast from.
        </div>
        <div className="ov-muted" style={{ fontSize: 13.5, marginTop: 13, lineHeight: 1.75 }}>
          Every figure here is derived from recorded spend and a starting valuation. With neither, an independence target would be a
          number invented by the app, so none is shown.
        </div>
        <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '12px 0', borderTop: '1px solid var(--rule)', fontSize: 13.5 }}>
            <span>Annual spend</span>
            <span className="ov-muted">{monthCount >= 3 ? 'known' : `needs three closed months · has ${monthCount}`}</span>
          </div>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '12px 0', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)', fontSize: 13.5 }}
          >
            <span>Starting net worth</span>
            <span className="ov-muted">
              {startNetWorth === null
                ? 'needs one account valuation'
                : basisIncomplete
                  ? `incomplete · ${basisIncomplete}`
                  : basisProvisional
                    ? 'provisional · balances not confirmed'
                    : 'known'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
          <button type="button" className="om-btn" style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }} onClick={() => navigate('/wealth')}>
            Add an account
          </button>
          <button type="button" className="om-btn" onClick={() => navigate('/money')}>
            Record spending
          </button>
        </div>
      </div>
    );
  }

  const rate = mode === 'real' ? realReturn(selNominalPct, selInflationPct) : selNominalPct / 100;
  const annualSaving = inputs.monthlySaving * 12;
  // Lasting income (from day one, for good) does what spending less would, so
  // it comes off both targets. The same function feeds Drawdown and the Plan
  // summary.
  const incomes = data.independenceIncome ?? [];
  const { target, lastingIncome, otherCount } = independenceTarget(inputs.annualSpend, selSwrPct, incomes);
  const leanTarget = leanSpend ? fiTarget(Math.max(0, leanSpend - lastingIncome), selSwrPct) : null;
  // The target is spend ÷ the withdrawal rate, so the multiple follows the
  // rate: 25× only at 4%. It used to say 25× whatever the rate was.
  const spendMultiple = Number((100 / selSwrPct).toFixed(1));
  const targetShown = mode === 'real' ? target : Math.round(target * (1 + selInflationPct / 100) ** HORIZON_YEARS);

  const fireYear = crossingYear({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct: selInflationPct, goal: target });
  const leanYear = leanTarget ? crossingYear({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct: selInflationPct, goal: leanTarget }) : null;

  const baselineRate = hasBaseline ? (mode === 'real' ? realReturn(Number(assumptions.baseline_nominal_return_pct), selInflationPct) : Number(assumptions.baseline_nominal_return_pct) / 100) : null;
  const baselineSaving = hasBaseline ? Number(assumptions.baseline_monthly_saving) * 12 : null;
  const planYear = hasBaseline
    ? crossingYear({ startYear, startNetWorth, annualSaving: baselineSaving, rate: baselineRate, mode, inflationPct: selInflationPct, goal: target })
    : null;
  const aheadBy = yearsDelta(fireYear, planYear);

  // "Assumed vs actual" compares the saved baseline against today's actuals
  // under the household's own inflation assumption, whichever scenario is
  // being viewed -- so its reference year is computed on that same basis.
  // Measuring the effects against planYear (built on the viewed scenario's
  // inflation) reported a return effect under Conservative even with the
  // return unchanged.
  const liveRate = mode === 'real' ? realReturn(nominalPct, inflationPct) : nominalPct / 100;
  const baselineRateLive = hasBaseline
    ? mode === 'real'
      ? realReturn(Number(assumptions.baseline_nominal_return_pct), inflationPct)
      : Number(assumptions.baseline_nominal_return_pct) / 100
    : null;
  const planYearLive = hasBaseline
    ? crossingYear({ startYear, startNetWorth, annualSaving: baselineSaving, rate: baselineRateLive, mode, inflationPct, goal: target })
    : null;
  const savingEffectYear = hasBaseline
    ? crossingYear({ startYear, startNetWorth, annualSaving, rate: baselineRateLive, mode, inflationPct, goal: target })
    : null;
  const savingEffect = yearsDelta(planYearLive, savingEffectYear);
  const returnEffectYear = hasBaseline
    ? crossingYear({ startYear, startNetWorth, annualSaving: baselineSaving, rate: liveRate, mode, inflationPct, goal: target })
    : null;
  const returnEffect = yearsDelta(planYearLive, returnEffectYear);

  const pct = target > 0 ? startNetWorth / target : 0;

  // Yearly, not every third year: the crossing year is shown to the year, so
  // the chart has to be able to show that year too.
  const path = projectYears({ startNetWorth, annualSaving, rate, mode, inflationPct: selInflationPct, years: HORIZON_YEARS });
  const targetPath = path.map((p) => goalAt(p.yearsOut, target, mode, selInflationPct));
  const crossIdx = fireYear !== null && fireYear - startYear <= HORIZON_YEARS ? fireYear - startYear : null;
  const shownIdx = activeYear ?? crossIdx ?? HORIZON_YEARS;
  const shown = path[shownIdx];
  const shownTarget = targetPath[shownIdx];
  const columns = path.map((p) => ({ key: p.yearsOut, label: String(startYear + p.yearsOut), values: [p.start, p.saved, p.growth] }));

  // The other direction: pick a year, get the monthly saving it takes. Starts
  // three years ahead of the projected date, the question most people ask
  // first; with no date in reach it starts twenty years out.
  const defaultSolveYear = fireYear !== null ? Math.max(startYear + 1, Math.min(startYear + SOLVE_MAX_YEARS, fireYear - 3)) : startYear + 20;
  const solveFor = solveYear ?? defaultSolveYear;
  const requiredAnnual = requiredAnnualSaving({ startNetWorth, rate, mode, inflationPct: selInflationPct, goal: target, years: solveFor - startYear });
  // Rounded up to a whole unit so the figure shown really does cross in that
  // year rather than a hair short of it.
  const requiredMonthly = requiredAnnual === null ? null : Math.ceil(requiredAnnual / 12);
  const extraMonthly = requiredMonthly === null ? null : requiredMonthly - inputs.monthlySaving;

  const scenarios = [
    (() => {
      const bump = Math.max(500, Math.round((inputs.monthlySaving * 0.25) / 100) * 100) || 1000;
      const yr = crossingYear({ startYear, startNetWorth, annualSaving: annualSaving + bump * 12, rate, mode, inflationPct: selInflationPct, goal: target });
      const d = yearsDelta(fireYear, yr);
      return { name: `Save ${money.code} ${money.fmt(bump)} more a month`, note: 'Redirect any budget underspend instead of letting it drift', deltaYears: d, delta: deltaLabel(d) };
    })(),
    (() => {
      const lowerNominal = Math.max(0, selNominalPct - 2);
      const lowerRate = mode === 'real' ? realReturn(lowerNominal, selInflationPct) : lowerNominal / 100;
      const yr = crossingYear({ startYear, startNetWorth, annualSaving, rate: lowerRate, mode, inflationPct: selInflationPct, goal: target });
      const d = yearsDelta(fireYear, yr);
      return { name: `Markets return ${lowerNominal.toFixed(1)}% instead of ${selNominalPct.toFixed(1)}%`, note: 'A long flat stretch — the main risk to the date', deltaYears: d, delta: deltaLabel(d) };
    })(),
    (() => {
      const higherNominal = selNominalPct + 2;
      const higherRate = mode === 'real' ? realReturn(higherNominal, selInflationPct) : higherNominal / 100;
      const yr = crossingYear({ startYear, startNetWorth, annualSaving, rate: higherRate, mode, inflationPct: selInflationPct, goal: target });
      const d = yearsDelta(fireYear, yr);
      return { name: `Markets return ${higherNominal.toFixed(1)}% instead of ${selNominalPct.toFixed(1)}%`, note: 'The upside case, same contributions', deltaYears: d, delta: deltaLabel(d) };
    })(),
    ...(leanTarget
      ? [
          {
            name: 'Retire on essentials only',
            note: `Target drops to ${money.code} ${money.fmt(leanTarget)}`,
            deltaYears: yearsDelta(fireYear, leanYear),
            delta: deltaLabel(yearsDelta(fireYear, leanYear)),
          },
        ]
      : []),
  ];

  return (
    <div>
      <section className="pl-hero" style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div className="ov-kicker">Independence target</div>
            <div className="ov-hero fig">
              <span className="ov-hero-currency">{money.code}</span> {money.fmt(targetShown)}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10 }}>
              {mode === 'real'
                ? `${spendMultiple}× today's spend of ${money.fmt(inputs.annualSpend)} a year, in today's money`
                : `${spendMultiple}× spend, grown to ${startYear + HORIZON_YEARS} at ${selInflationPct.toFixed(1)}% inflation`}
              {lastingIncome > 0 && `, less ${money.fmt(lastingIncome)} a year of lasting other income`}
              {otherCount > 0 && ` · ${otherCount} other income source${otherCount === 1 ? '' : 's'} counted on Drawdown`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              ['real', "Today's money"],
              ['nominal', 'Nominal'],
            ].map(([key, label]) => (
              <button key={key} type="button" className="om-seg" data-active={mode === key} onClick={() => setMode(key)}>
                {label}
              </button>
            ))}
            <button type="button" className="om-btn" onClick={() => setEditing(true)}>
              Edit assumptions
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: 26,
            paddingBottom: 18,
            borderBottom: '1px solid var(--rule)',
          }}
        >
          <span style={{ fontSize: 11.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink3)', marginRight: 6 }}>Scenario</span>
          {Object.values(sets).map((s) => (
            <button key={s.key} type="button" className="om-seg" data-active={fcSet === s.key} onClick={() => setFcSet(s.key)}>
              {s.label}
            </button>
          ))}
          <span className="ov-muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
            {selected.meta}
          </span>
        </div>

        <div style={{ marginTop: 20, border: '1px solid var(--rule2)', borderRadius: 3, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13.5 }}>Based on these assumptions</div>
            <button type="button" className="om-link" style={{ fontSize: 11.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => setEditing(true)}>
              Edit →
            </button>
          </div>
          <div className="ov-quality-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', marginTop: 14 }}>
            {[
              ['Investment return', `${selNominalPct.toFixed(1)}% nominal`],
              ['Inflation', `${selInflationPct.toFixed(1)}%`],
              ['Safe withdrawal rate', `${selSwrPct.toFixed(1)}%`],
              ['Monthly saving', `${money.fmtBalance(inputs.monthlySaving)} (actual)`],
              ['Annual spend', `${money.fmt(inputs.annualSpend)} (actual)`],
              ['Horizon shown', `${HORIZON_YEARS} years`],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink3)' }}>{label}</div>
                <div className="fig" style={{ fontSize: 13.5, marginTop: 5 }}>{value}</div>
              </div>
            ))}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 15, lineHeight: 1.7, maxWidth: '84ch' }}>
            {fcSet === 'baseline' &&
              'Change any one of these and every figure on this page moves. Dates are shown to the year, never the month: a single percentage point on the return assumption shifts the independence year by roughly two to three years, so a precise date would be false precision.'}
            {fcSet === 'custom' &&
              (sets.custom.meta.startsWith('Not set')
                ? "This scenario hasn't been edited yet, so it's shown identical to Baseline. Edit assumptions while Custom is selected to save your own numbers."
                : "This scenario is your own and isn't the household baseline. Figures below follow it, but nothing is compared against plan until Baseline is edited to match.")}
            {(fcSet === 'conservative' || fcSet === 'optimistic') &&
              `A ${selected.label.toLowerCase()} reading of the same balance sheet. Only the return and inflation assumptions differ from Baseline — monthly saving and spend are unchanged. Dates are shown to the year, never the month.`}
          </div>
        </div>

        <div style={{ marginTop: 26 }}>
          <div style={{ position: 'relative', height: 8, background: 'var(--rule)' }}>
            <div style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)' }} />
            {leanTarget && (
              <div style={{ position: 'absolute', left: `${Math.min(100, (leanTarget / target) * 100).toFixed(1)}%`, top: -5, bottom: -5, width: 1, background: 'var(--ink2)' }} />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: 'var(--ink3)', flexWrap: 'wrap', gap: 12 }}>
            <span>
              <span style={{ color: 'var(--ink)' }}>{formatPct(pct)}</span> of the way there · {money.fmtBalance(startNetWorth)} today
              {basisIncomplete && ` · incomplete, ${basisIncomplete}`}
              {basisProvisional && ' · provisional, some balances are unconfirmed'}
            </span>
            {leanTarget && (
              <span>
                Lean number {money.fmt(leanTarget)} marked · essentials only, reached {leanYear ?? 'beyond this projection'}
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="fc-kpis">
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Independent by</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>
            {fireYear ?? '60+ yrs out'}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>{fireYear ? `${fireYear - startYear} years from now` : 'Beyond what a 60-year projection shows'}</div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Against baseline</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6, color: aheadBy > 0 ? 'var(--pos)' : aheadBy < 0 ? 'var(--neg)' : 'var(--ink)' }}>
            {aheadBy !== null ? deltaLabel(aheadBy) : '—'}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {hasBaseline ? `Baseline assumptions, applied to today's numbers, cross in ${planYear ?? '60+ yrs'}` : 'No baseline saved yet — set assumptions once to start comparing'}
          </div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>{mode === 'real' ? 'Real return assumed' : 'Nominal return assumed'}</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{(rate * 100).toFixed(1)}%</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {mode === 'real' ? `${selNominalPct.toFixed(1)}% nominal less ${selInflationPct.toFixed(1)}% inflation` : `Before inflation of ${selInflationPct.toFixed(1)}%`}
          </div>
        </div>
        <div className="fc-kpi">
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Saving now</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{money.fmtBalance(inputs.monthlySaving)}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>A month, averaged over the last {inputs.monthCount} closed months</div>
        </div>
      </div>

      <section style={{ marginTop: 34 }}>
        <div className="ov-kicker">What it would take</div>
        <div className="fc-solve">
          <span>To be independent by</span>
          <span className="fc-solve-year">
            <button
              type="button"
              className="fc-solve-step"
              aria-label="One year earlier"
              disabled={solveFor <= startYear + 1}
              onClick={() => setSolveYear(solveFor - 1)}
            >
              −
            </button>
            <span className="fig" aria-live="polite">
              {solveFor}
            </span>
            <button
              type="button"
              className="fc-solve-step"
              aria-label="One year later"
              disabled={solveFor >= startYear + SOLVE_MAX_YEARS}
              onClick={() => setSolveYear(solveFor + 1)}
            >
              +
            </button>
          </span>
          <span className="fc-solve-answer">
            {requiredMonthly === 0 ? (
              <>growth on today's net worth gets there with no further saving</>
            ) : (
              <>
                save{' '}
                <b className="fig">
                  {money.code} {money.fmt(requiredMonthly)}
                </b>{' '}
                a month
                <span className="ov-muted">
                  {' · '}
                  {extraMonthly > 0
                    ? `${money.fmt(extraMonthly)} more than the ${money.fmtBalance(inputs.monthlySaving)} you save now`
                    : extraMonthly < 0
                      ? `${money.fmt(-extraMonthly)} less than you save now`
                      : 'exactly what you save now'}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6, maxWidth: '84ch' }}>
          Same assumptions as everything above, solved the other way round: from a chosen year back to the monthly saving, in today's
          money.
        </div>
      </section>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 40, gap: 16, flexWrap: 'wrap' }}>
        <div className="ov-kicker">Projection</div>
        <div className="ov-muted" style={{ fontSize: 11.5 }}>
          {mode === 'real' ? "Inflation stripped out · net worth in what it buys today" : `Nominal ${money.code} · bigger numbers, each one buying less`}
        </div>
      </div>

      <section>
        <ColumnChart
          columns={columns}
          series={PARTS}
          reference={{ values: targetPath, label: 'Target' }}
          height={220}
          formatTick={money.fmtCompact}
          labelEvery={5}
          activeIndex={shownIdx}
          onActiveChange={setActiveYear}
          ariaLabel={`Projected net worth by year, ${startYear} to ${startYear + HORIZON_YEARS}, split into today's net worth, saving and growth, against the target. Use the arrow keys to move between years.`}
        />
        <div className="ov-chart-readout">
          <span className="fig">{startYear + shownIdx}</span>
          <span>
            Projected <b className="fig">{money.fmtBalance(shown.value)}</b>
          </span>
          {PARTS.map((part) => (
            <span key={part.key} className="ch-key">
              <i className="ch-swatch" style={{ background: part.color }} />
              {part.label} <b className="fig">{money.fmtBalance(shown[part.key])}</b>
            </span>
          ))}
          <span className={shown.value >= shownTarget ? 'ov-pos' : undefined}>
            {shown.value >= shownTarget ? 'Past the target' : `${formatPct(shown.value / shownTarget)} of the target`}
          </span>
        </div>
        <ChartLegend
          items={[
            ...PARTS.map((part) => ({ label: part.label, color: part.color })),
            {
              label: `Target ${money.code} ${money.fmt(target)}${mode === 'real' ? '' : ' today, grown with inflation'} · crossed ${fireYear ?? 'beyond this projection'}${
                hasBaseline ? ` · baseline crosses ${planYear ?? 'beyond this projection'}` : ''
              }`,
              color: 'var(--ink2)',
              kind: 'line',
            },
          ]}
        />
        <details className="ch-table">
          <summary>Year by year, as a table</summary>
          <div className="ch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  {PARTS.map((part) => (
                    <th key={part.key} scope="col">
                      {part.label}
                    </th>
                  ))}
                  <th scope="col">Projected</th>
                  <th scope="col">Target</th>
                </tr>
              </thead>
              <tbody>
                {path.map((p, i) => (
                  <tr key={p.yearsOut} data-active={i === shownIdx}>
                    <td className="fig">{startYear + p.yearsOut}</td>
                    {PARTS.map((part) => (
                      <td key={part.key} className="fig">
                        {money.fmtBalance(p[part.key])}
                      </td>
                    ))}
                    <td className="fig">{money.fmtBalance(p.value)}</td>
                    <td className="fig ov-muted">{money.fmt(targetPath[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <div className="fc-g2">
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, gap: 14 }}>
            <div className="ov-kicker">Assumed vs actual</div>
            {hasBaseline && <div className="ov-muted" style={{ fontSize: 11.5 }}>Since baseline was set</div>}
          </div>
          {!hasBaseline ? (
            <div className="ov-muted" style={{ fontSize: 12.5 }}>Save assumptions once to start tracking planned vs actual.</div>
          ) : (
            <div className="mn-list">
              <div className="mn-row" style={{ cursor: 'default', display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'baseline' }}>
                  <div className="mn-row-main">
                    <div>Monthly saving</div>
                    <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>Baseline vs the last {inputs.monthCount} months, actual</div>
                  </div>
                  <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
                    <span className="ov-muted fig">{money.fmtBalance(assumptions.baseline_monthly_saving)}</span>
                    <span className={`fig ${inputs.monthlySaving >= Number(assumptions.baseline_monthly_saving) ? 'ov-pos' : 'ov-neg'}`}>
                      {money.fmtBalance(inputs.monthlySaving)}
                    </span>
                  </div>
                </div>
                <div className={`ov-muted ${savingEffect < 0 ? 'ov-pos' : savingEffect > 0 ? 'ov-neg' : ''}`} style={{ fontSize: 11.5, marginTop: 5 }}>
                  {savingEffect === null
                    ? '—'
                    : savingEffect === 0
                      ? 'No effect on the independence year'
                      : `${savingEffect < 0 ? 'Pulls the date forward' : 'Pushes the date back'} ${Math.abs(savingEffect)} yr${Math.abs(savingEffect) === 1 ? '' : 's'}`}
                </div>
              </div>
              <div className="mn-row" style={{ cursor: 'default', display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'baseline' }}>
                  <div className="mn-row-main">
                    <div>Investment return</div>
                    <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>Baseline vs current assumption</div>
                  </div>
                  <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
                    <span className="ov-muted fig">{Number(assumptions.baseline_nominal_return_pct).toFixed(1)}%</span>
                    <span className="fig">{nominalPct.toFixed(1)}%</span>
                  </div>
                </div>
                <div className={`ov-muted ${returnEffect < 0 ? 'ov-pos' : returnEffect > 0 ? 'ov-neg' : ''}`} style={{ fontSize: 11.5, marginTop: 5 }}>
                  {returnEffect === null
                    ? '—'
                    : returnEffect === 0
                      ? 'No effect on the independence year'
                      : `${returnEffect < 0 ? 'Pulls the date forward' : 'Pushes the date back'} ${Math.abs(returnEffect)} yr${Math.abs(returnEffect) === 1 ? '' : 's'}`}
                </div>
              </div>
              <div className="mn-row" style={{ cursor: 'default' }}>
                <div className="mn-row-main">
                  <div>Household inflation</div>
                  <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>No price index is tracked, so an actual figure isn't shown</div>
                </div>
                <span className="ov-muted">not tracked</span>
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="ov-kicker" style={{ marginBottom: 14 }}>
            If things change
          </div>
          {scenarios.map((s) => (
            <div key={s.name} className="mn-row" style={{ cursor: 'default', display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'baseline' }}>
                <div style={{ fontSize: 13.5 }}>{s.name}</div>
                <div
                  className={`fig ${s.deltaYears < 0 ? 'ov-pos' : s.deltaYears > 0 ? 'ov-neg' : ''}`}
                  style={{ fontSize: 12.5 }}
                >
                  {s.delta ?? '—'}
                </div>
              </div>
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{s.note}</div>
            </div>
          ))}
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.6 }}>
            Each line moves one assumption and holds the rest. {mode === 'real' ? 'Inflation is already stripped out, so these are years of real spending power.' : ''}
          </div>
        </div>
      </div>

      {editing && (
        <ForecastAssumptionsEditor
          householdId={householdId}
          assumptions={assumptions}
          currentMonthlySaving={inputs.monthlySaving}
          scenario={fcSet}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await data.reload();
          }}
        />
      )}
    </div>
  );
}
