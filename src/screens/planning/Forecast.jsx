import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney, formatPct } from '../../lib/money';
import { netWorthSummary } from '../overviewMath';
import { closedMonths, crossingYear, fiTarget, forecastInputs, projectSeries, realReturn, goalAt } from '../../lib/forecast';
import ForecastAssumptionsEditor from './ForecastAssumptionsEditor';

const DEFAULTS = { nominal_return_pct: 6.0, inflation_pct: 2.5, safe_withdrawal_pct: 4.0 };
const HORIZON_YEARS = 30;
const STEP = 3;

function yearsDelta(fromYear, toYear) {
  if (fromYear === null || toYear === null) return null;
  return toYear - fromYear;
}

function deltaLabel(years) {
  if (years === null) return null;
  if (years === 0) return 'no change';
  return `${years > 0 ? '+' : '−'}${Math.abs(years)} yr${Math.abs(years) === 1 ? '' : 's'}`;
}

export default function Forecast({ householdId, accounts, transactions, data, loading }) {
  const navigate = useNavigate();
  const { assumptions } = data;
  const [mode, setMode] = useState('real');
  const [editing, setEditing] = useState(false);

  const now = useMemo(() => new Date(), []);
  const startYear = now.getFullYear();

  const startNetWorth = accounts.length > 0 ? netWorthSummary(accounts, null).netWorth : null;
  const monthCount = closedMonths(transactions, now).size;
  const inputs = useMemo(() => forecastInputs(transactions, startNetWorth, now), [transactions, startNetWorth, now]);

  const nominalPct = assumptions?.nominal_return_pct != null ? Number(assumptions.nominal_return_pct) : DEFAULTS.nominal_return_pct;
  const inflationPct = assumptions?.inflation_pct != null ? Number(assumptions.inflation_pct) : DEFAULTS.inflation_pct;
  const swrPct = assumptions?.safe_withdrawal_pct != null ? Number(assumptions.safe_withdrawal_pct) : DEFAULTS.safe_withdrawal_pct;
  const leanSpend = assumptions?.lean_annual_spend != null ? Number(assumptions.lean_annual_spend) : null;
  const hasBaseline = !!assumptions?.baseline_set_at;

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
            <span className="ov-muted">{startNetWorth !== null ? 'known' : 'needs one account valuation'}</span>
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

  const rate = mode === 'real' ? realReturn(nominalPct, inflationPct) : nominalPct / 100;
  const annualSaving = inputs.monthlySaving * 12;
  const target = fiTarget(inputs.annualSpend, swrPct);
  const leanTarget = leanSpend ? fiTarget(leanSpend, swrPct) : null;
  const targetShown = mode === 'real' ? target : Math.round(target * (1 + inflationPct / 100) ** HORIZON_YEARS);

  const fireYear = crossingYear({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct, goal: target });
  const leanYear = leanTarget ? crossingYear({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct, goal: leanTarget }) : null;

  const baselineRate = hasBaseline ? (mode === 'real' ? realReturn(Number(assumptions.baseline_nominal_return_pct), inflationPct) : Number(assumptions.baseline_nominal_return_pct) / 100) : null;
  const baselineSaving = hasBaseline ? Number(assumptions.baseline_monthly_saving) * 12 : null;
  const planYear = hasBaseline
    ? crossingYear({ startYear, startNetWorth, annualSaving: baselineSaving, rate: baselineRate, mode, inflationPct, goal: target })
    : null;
  const aheadBy = yearsDelta(fireYear, planYear);

  const pct = target > 0 ? startNetWorth / target : 0;

  const series = projectSeries({ startYear, startNetWorth, annualSaving, rate, mode, inflationPct, horizonYears: HORIZON_YEARS, step: STEP });
  const planSeries = hasBaseline
    ? projectSeries({ startYear, startNetWorth, annualSaving: baselineSaving, rate: baselineRate, mode, inflationPct, horizonYears: HORIZON_YEARS, step: STEP })
    : null;
  const targetLine = series.map((p) => goalAt(p.yearsOut, target, mode, inflationPct));
  const maxValue = Math.max(...series.map((p) => p.value), ...targetLine, ...(planSeries?.map((p) => p.value) ?? []), 1);

  const scenarios = [
    (() => {
      const bump = Math.max(500, Math.round((inputs.monthlySaving * 0.25) / 100) * 100) || 1000;
      const yr = crossingYear({ startYear, startNetWorth, annualSaving: annualSaving + bump * 12, rate, mode, inflationPct, goal: target });
      const d = yearsDelta(fireYear, yr);
      return { name: `Save AED ${formatMoney(bump)} more a month`, note: 'Redirect any budget underspend instead of letting it drift', deltaYears: d, delta: deltaLabel(d) };
    })(),
    (() => {
      const lowerNominal = Math.max(0, nominalPct - 2);
      const lowerRate = mode === 'real' ? realReturn(lowerNominal, inflationPct) : lowerNominal / 100;
      const yr = crossingYear({ startYear, startNetWorth, annualSaving, rate: lowerRate, mode, inflationPct, goal: target });
      const d = yearsDelta(fireYear, yr);
      return { name: `Markets return ${lowerNominal.toFixed(1)}% instead of ${nominalPct.toFixed(1)}%`, note: 'A long flat stretch — the main risk to the date', deltaYears: d, delta: deltaLabel(d) };
    })(),
    (() => {
      const higherNominal = nominalPct + 2;
      const higherRate = mode === 'real' ? realReturn(higherNominal, inflationPct) : higherNominal / 100;
      const yr = crossingYear({ startYear, startNetWorth, annualSaving, rate: higherRate, mode, inflationPct, goal: target });
      const d = yearsDelta(fireYear, yr);
      return { name: `Markets return ${higherNominal.toFixed(1)}% instead of ${nominalPct.toFixed(1)}%`, note: 'The upside case, same contributions', deltaYears: d, delta: deltaLabel(d) };
    })(),
    ...(leanTarget
      ? [
          {
            name: 'Retire on essentials only',
            note: `Target drops to ${formatMoney(leanTarget)}`,
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
              <span className="ov-hero-currency">AED</span> {formatMoney(targetShown)}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--ink2)', marginTop: 10 }}>
              {mode === 'real'
                ? `25× today's spend of ${formatMoney(inputs.annualSpend)} a year, in today's money`
                : `25× spend, grown to ${startYear + HORIZON_YEARS} at ${inflationPct.toFixed(1)}% inflation`}
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

        <div style={{ marginTop: 26 }}>
          <div style={{ position: 'relative', height: 8, background: 'var(--rule)' }}>
            <div style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)' }} />
            {leanTarget && (
              <div style={{ position: 'absolute', left: `${Math.min(100, (leanTarget / target) * 100).toFixed(1)}%`, top: -5, bottom: -5, width: 1, background: 'var(--ink2)' }} />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: 'var(--ink3)', flexWrap: 'wrap', gap: 12 }}>
            <span>
              <span style={{ color: 'var(--ink)' }}>{formatPct(pct)}</span> of the way there · {formatMoney(startNetWorth)} today
            </span>
            {leanTarget && (
              <span>
                Lean number {formatMoney(leanTarget)} marked · essentials only, reached {leanYear ?? 'beyond this projection'}
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="ov-quality-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 32 }}>
        <div style={{ paddingRight: 24, borderRight: '1px solid var(--rule)' }}>
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Independent by</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>
            {fireYear ?? '60+ yrs out'}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>{fireYear ? `${fireYear - startYear} years from now` : 'Beyond what a 60-year projection shows'}</div>
        </div>
        <div style={{ padding: '0 24px', borderRight: '1px solid var(--rule)' }}>
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Against baseline</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6, color: aheadBy > 0 ? 'var(--pos)' : aheadBy < 0 ? 'var(--neg)' : 'var(--ink)' }}>
            {aheadBy !== null ? deltaLabel(aheadBy) : '—'}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {hasBaseline ? `Baseline assumptions, applied to today's numbers, cross in ${planYear ?? '60+ yrs'}` : 'No baseline saved yet — set assumptions once to start comparing'}
          </div>
        </div>
        <div style={{ padding: '0 24px', borderRight: '1px solid var(--rule)' }}>
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>{mode === 'real' ? 'Real return assumed' : 'Nominal return assumed'}</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{(rate * 100).toFixed(1)}%</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {mode === 'real' ? `${nominalPct.toFixed(1)}% nominal less ${inflationPct.toFixed(1)}% inflation` : `Before inflation of ${inflationPct.toFixed(1)}%`}
          </div>
        </div>
        <div style={{ paddingLeft: 24 }}>
          <div style={{ fontSize: 12, color: 'var(--ink2)' }}>Saving now</div>
          <div className="fig" style={{ fontSize: 28, marginTop: 6 }}>{formatMoney(inputs.monthlySaving)}</div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>A month, averaged over the last {inputs.monthCount} closed months</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 40, gap: 16, flexWrap: 'wrap' }}>
        <div className="ov-kicker">Projection</div>
        <div className="ov-muted" style={{ fontSize: 11.5 }}>
          {mode === 'real' ? 'Inflation stripped out · bars are net worth in what it buys today' : 'Nominal AED · bigger numbers, each one buying less'}
        </div>
      </div>

      <section style={{ marginTop: 18 }}>
        <div className="ov-chart">
          {series.map((p, i) => {
            const hit = p.value >= targetLine[i];
            return (
              <div key={p.year} className="ov-col" data-active={hit}>
                <div className="ov-col-bars">
                  <span className="ov-bar-inc" style={{ height: `${Math.max(2, (p.value / maxValue) * 100)}%`, opacity: hit ? 1 : 0.65 }} />
                </div>
                <div className="ov-col-label">{p.year}</div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 20, marginTop: 16, fontSize: 11.5, color: 'var(--ink2)', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 9, height: 9, background: 'var(--accent)', display: 'block' }} />
            Projected net worth, {mode === 'real' ? "today's money" : 'nominal AED'}
          </span>
          <span className="ov-muted">Target {formatMoney(target)} · crosses {fireYear ?? 'beyond this projection'}</span>
          {hasBaseline && <span className="ov-muted">Baseline crosses {planYear ?? 'beyond this projection'}</span>}
        </div>
      </section>

      <div className="ov-g2" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,1fr)', gap: 44, marginTop: 44 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, gap: 14 }}>
            <div className="ov-kicker">Assumed vs actual</div>
            {hasBaseline && <div className="ov-muted" style={{ fontSize: 11.5 }}>Since baseline was set</div>}
          </div>
          {!hasBaseline ? (
            <div className="ov-muted" style={{ fontSize: 12.5 }}>Save assumptions once to start tracking planned vs actual.</div>
          ) : (
            <div className="mn-list">
              <div className="mn-row" style={{ cursor: 'default' }}>
                <div className="mn-row-main">
                  <div>Monthly saving</div>
                  <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>Baseline vs the last {inputs.monthCount} months, actual</div>
                </div>
                <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
                  <span className="ov-muted fig">{formatMoney(assumptions.baseline_monthly_saving)}</span>
                  <span className={`fig ${inputs.monthlySaving >= Number(assumptions.baseline_monthly_saving) ? 'ov-pos' : 'ov-neg'}`}>
                    {formatMoney(inputs.monthlySaving)}
                  </span>
                </div>
              </div>
              <div className="mn-row" style={{ cursor: 'default' }}>
                <div className="mn-row-main">
                  <div>Investment return</div>
                  <div className="ov-muted" style={{ marginTop: 3, fontSize: 11.5 }}>Baseline vs current assumption</div>
                </div>
                <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
                  <span className="ov-muted fig">{Number(assumptions.baseline_nominal_return_pct).toFixed(1)}%</span>
                  <span className="fig">{nominalPct.toFixed(1)}%</span>
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

      <section style={{ marginTop: 44, paddingBottom: 40 }}>
        <div className="ov-kicker" style={{ marginBottom: 12 }}>
          Based on these assumptions
        </div>
        <div className="ov-quality-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
          {[
            ['Investment return', `${nominalPct.toFixed(1)}% nominal`],
            ['Inflation', `${inflationPct.toFixed(1)}%`],
            ['Safe withdrawal rate', `${swrPct.toFixed(1)}%`],
            ['Monthly saving', `${formatMoney(inputs.monthlySaving)} (actual)`],
            ['Annual spend', `${formatMoney(inputs.annualSpend)} (actual)`],
            ['Horizon shown', `${HORIZON_YEARS} years`],
          ].map(([label, value]) => (
            <div key={label}>
              <div style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink3)' }}>{label}</div>
              <div className="fig" style={{ fontSize: 13.5, marginTop: 5 }}>{value}</div>
            </div>
          ))}
        </div>
        <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 15, lineHeight: 1.7, maxWidth: '84ch' }}>
          Change any one of these and every figure on this page moves. Dates are shown to the year, never the month: a single
          percentage point on the return assumption shifts the independence year by roughly two to three years, so a precise date
          would be false precision.
        </div>
      </section>

      {editing && (
        <ForecastAssumptionsEditor
          householdId={householdId}
          assumptions={assumptions}
          currentMonthlySaving={inputs.monthlySaving}
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
