import { useState } from 'react';
import { LineChart } from '../../charts/Charts';
import { MARKET_FALL } from '../../lib/forecast';

const pct = (r) => `${Math.round(Math.abs(r) * 100)}%`;
const FALL_WORDS = `${pct(MARKET_FALL[0])} then ${pct(MARKET_FALL[1])}`;
// A year's return, signed with the same minus the money figures use.
const returnText = (r) => `${r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(1)}%`;

// The Life plan's stress test (Planning audit, 3.14): the same market fall
// after work stops, early or late, put through the plan itself on Baseline
// (lib/lifePlan.js, stressTest). It was Drawdown's, on a simpler drawdown of
// its own that left out spending for one and goals after work stops, so the
// two could disagree. Each outcome picks the path the chart draws, against
// the steady one.
export default function StressTest({ stress, scenarioLabel, agesText, money, shown }) {
  const [chosenKey, setChosenKey] = useState('early');
  const [activeYear, setActiveYear] = useState(null);
  const { outcomes, endYear, stopYear, firstDraw } = stress;
  const steady = outcomes[0];
  const chosen = outcomes.find((o) => o.key === chosenKey) ?? outcomes[outcomes.length - 1];
  const early = outcomes.find((o) => o.key === 'early');
  const rows = chosen.rows;
  const activeIdx = Math.min(activeYear ?? Math.max(0, rows.findIndex((r) => r.year === (chosen.shortYear ?? chosen.fallYear ?? stopYear))), rows.length - 1);
  const active = rows[activeIdx];
  const yearsShort = (o) => endYear - o.shortYear + 1;

  return (
    <section style={{ marginTop: 40 }} aria-labelledby="lp-stress-head">
      <div className="ov-kicker" id="lp-stress-head">
        If markets fall
      </div>
      <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch', marginTop: 8 }}>
        A steady return is an assumption, not a forecast. Here the pot loses {FALL_WORDS} after inflation over two years, about what a
        mixed pot like the one assumed after work stops lost in a bad stretch such as 2008, and earns Baseline&rsquo;s return otherwise.
        The fall is the same both times; only when it comes differs.
        {scenarioLabel !== 'Baseline' && ` This is on Baseline whichever scenario is chosen above: a fall on top of ${scenarioLabel} would count caution twice.`}
      </div>

      <div className="fc-kpis lp-falls" role="group" aria-label="Market falls">
        {outcomes.map((o) => (
          <button key={o.key} type="button" className="fc-kpi lp-fall" data-active={o.key === chosen.key} aria-pressed={o.key === chosen.key} onClick={() => setChosenKey(o.key)}>
            <div style={{ fontSize: 12, color: 'var(--ink2)' }}>
              {o.label}
              {o.fallYear !== null && <span className="ov-muted"> · {o.fallYear}</span>}
            </div>
            <div className={`fig lp-fall-figure ${o.lasts ? '' : 'ov-neg'}`}>{o.lasts ? `Lasts to ${endYear}` : `Runs out in ${o.shortYear}`}</div>
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
              {o.lasts
                ? `${money.code} ${money.fmtBalance(shown(o.left, endYear + 1))} left at the end`
                : o.fallYear !== null && o.shortYear < o.fallYear
                  ? 'The money runs out before the fall comes'
                  : `${yearsShort(o)} year${yearsShort(o) === 1 ? '' : 's'} before the plan ends`}
            </div>
          </button>
        ))}
      </div>

      <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch', marginTop: 14 }}>
        {early &&
          (early.lasts
            ? `Stopping in ${stopYear} weathers a fall the year work stops.`
            : early.earliest !== null
              ? `To weather a fall the year work stops, stop in ${early.earliest} (${agesText(early.earliest)}), with nothing to spare.`
              : 'No stop year weathers a fall the year work stops with the plan as it is.')}
        {firstDraw &&
          firstDraw.share !== null &&
          ` In ${firstDraw.year}, the first year without work, the pot pays ${money.code} ${money.fmt(shown(firstDraw.drawn, firstDraw.year))} towards spending after other income: ${(firstDraw.share * 100).toFixed(1)}% of what it holds.`}
      </div>

      <LineChart
        points={rows.map((r) => ({ key: r.year, label: String(r.year), value: shown(r.start, r.year) }))}
        reference={chosen.key === 'steady' ? null : { values: steady.rows.map((r) => shown(r.start, r.year)), label: 'Steady' }}
        height={180}
        formatTick={money.fmtCompact}
        labelEvery={10}
        activeIndex={activeIdx}
        onActiveChange={setActiveYear}
        ariaLabel={`${chosen.key === 'steady' ? 'At a steady return' : `With a market fall in ${chosen.fallYear}, against the steady path`}: the pot at the start of each year from ${stopYear}, when work stops, to ${endYear}. Use the arrow keys to move between years.`}
      />
      <div className="ov-chart-readout">
        <span className="fig">{active.year}</span>
        <span>{agesText(active.year)}</span>
        <span>
          Pot <b className="fig">{money.fmtBalance(shown(active.start, active.year))}</b>
        </span>
        <span>
          Return <b className="fig">{returnText(active.rate)}</b> after inflation
        </span>
        {active.short > 0 && <span className="ov-neg">Short by {money.fmt(shown(active.short, active.year))}</span>}
      </div>
    </section>
  );
}
