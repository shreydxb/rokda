import { useState } from 'react';
import { ChartLegend, ColumnChart } from '../../charts/Charts';

// Fixed order, so each part keeps its colour whatever the numbers do.
const PARTS = [
  { key: 'saved', label: 'Saved that year', color: 'var(--series-1)' },
  { key: 'earned', label: 'Earned that year', color: 'var(--series-3)' },
];

// The Life plan's working years split into what each year's saving adds and
// what the pot earns (Planning audit, 3.15). It was Forecast's projection,
// split the same way, and showed what that tab was best at: for the first
// couple of decades, saving moves the plan more than the return does. Here it
// is the Life plan's own years, goals paid and all, so it cannot drift from
// the pot beside it. Each year's two flows rather than running totals, so a
// goal paid from the pot takes nothing from either.
export default function SavingAndGrowth({ rows, agesText, money, shown }) {
  const [activeYear, setActiveYear] = useState(null);
  const crossing = rows.find((r) => r.growth > r.saving);
  const activeIdx = Math.min(activeYear ?? Math.max(0, crossing ? rows.indexOf(crossing) : rows.length - 1), rows.length - 1);
  const active = rows[activeIdx];
  const first = rows[0].year;
  const last = rows[rows.length - 1].year;

  return (
    <>
      <p style={{ fontSize: 13.5, color: 'var(--ink2)', lineHeight: 1.6, maxWidth: '84ch', margin: '10px 0 0' }}>
        {!crossing
          ? `Saving adds more than the pot earns in every year until work stops.`
          : crossing.year === first
            ? `The pot already earns more each year than you save.`
            : `Saving adds more than the pot earns each year until ${crossing.year - 1}; from ${crossing.year} the pot earns more.`}
      </p>
      <ColumnChart
        columns={rows.map((r) => ({ key: r.year, label: String(r.year), values: [shown(r.saving, r.year), shown(Math.max(0, r.growth), r.year)] }))}
        series={PARTS}
        height={220}
        formatTick={money.fmtCompact}
        labelEvery={5}
        activeIndex={activeIdx}
        onActiveChange={setActiveYear}
        ariaLabel={`What each year's saving adds and what the pot earns, from ${first} to ${last}, the last year of work. Use the arrow keys to move between years.`}
      />
      <div className="ov-chart-readout">
        <span className="fig">{active.year}</span>
        <span>{agesText(active.year)}</span>
        <span>
          Saved <b className="fig">{money.fmtBalance(shown(active.saving, active.year))}</b>
        </span>
        <span>
          Earned <b className="fig">{money.fmtBalance(shown(Math.max(0, active.growth), active.year))}</b>
        </span>
      </div>
      <ChartLegend items={PARTS.map((p) => ({ label: p.label, color: p.color }))} />
    </>
  );
}
