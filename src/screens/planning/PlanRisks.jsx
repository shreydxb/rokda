import { useState } from 'react';
import { MARKET_FALL } from '../../lib/forecast';
import { andList } from '../../lib/words';
import { Card, Chip, Fold, InfoButton } from '../../design-system/kit';
import { TrendLine } from '../../design-system/charts';

// Plan's "What could go wrong?" (the revamp, phase 6; design/prototype
// stressCard): a market fall the year work stops, and the rupee weakening
// against the dirham, each against the steady plan and both on Baseline,
// where a fall on top of Conservative would count caution twice (Planning
// audit, 3.14 and 4.19). Each says its verdict and one line; how it is
// tested is behind its (i), and its path behind "Show the path".

const pct = (r) => `${Math.round(Math.abs(r) * 100)}%`;
const FALL_WORDS = `${pct(MARKET_FALL[0])} then ${pct(MARKET_FALL[1])}`;

const verdictText = (o, endYear) => (o.lasts ? `Lasts to ${endYear}` : `Runs out ${o.shortYear}`);
const steadyText = (o, endYear) => (o.lasts ? `lasts to ${endYear}` : `runs out ${o.shortYear}`);

export default function PlanRisks({ stress, drift, money }) {
  const steady = stress.outcomes.find((o) => o.key === 'steady');
  const fall = stress.outcomes.find((o) => o.key === 'early');
  return (
    <div className="pl-risks">
      {fall ? (
        <RiskCard
          title="If markets fall"
          info={`The pot loses ${FALL_WORDS} after inflation over the two years from the year work stops, about what a mixed pot lost in a bad stretch such as 2008, then earns Baseline's return. Always on Baseline, so caution is not counted twice.${
            fall.lasts ? '' : fall.earliest !== null ? ` To weather it, work would stop in ${fall.earliest}.` : ' No stop year weathers it with the plan as it is.'
          }`}
          hit={fall}
          steady={steady}
          endYear={stress.endYear}
          line={`A two-year fall from ${stress.stopYear} · steady plan ${steadyText(steady, stress.endYear)}`}
          legend="With the fall"
          chartLabel={`With a market fall in ${fall.fallYear}, against the steady plan: the pot at the start of each year from ${stress.stopYear} to ${stress.endYear}. Use the arrow keys to move between years.`}
          money={money}
        />
      ) : (
        <Card title="If markets fall">
          <p className="ds-muted pl-none">The plan ends before a fall could come.</p>
        </Card>
      )}
      {drift && <RupeeCard drift={drift} money={money} />}
    </div>
  );
}

function RupeeCard({ drift, money }) {
  const { rupees } = drift;
  const what = [
    rupees.held > 0 && `${money.code} ${money.fmt(rupees.held)} held in rupees (${Math.round(rupees.share * 100)}% of what the plan starts from)`,
    rupees.incomes > 0 && `${rupees.incomes} source${rupees.incomes === 1 ? '' : 's'} of income in rupees`,
    rupees.costs > 0 && `${rupees.costs} cost${rupees.costs === 1 ? '' : 's'} in rupees`,
  ].filter(Boolean);
  const effects = [
    rupees.incomes > 0 && 'income in rupees is worth less',
    rupees.costs > 0 && 'costs in rupees cost less',
    rupees.held > 0 && 'what is held in rupees loses value',
  ].filter(Boolean);
  return (
    <RiskCard
      title="If the rupee weakens"
      info={`The rupee loses ${pct(drift.drift)} of its value against the dirham every year from this one, about its pace against the dollar, and so the dirham, over the past twenty years, with nothing in rupees making up for it. The plan counts ${andList(what)}: ${andList(effects)}. Always on Baseline.`}
      hit={drift.weaker}
      steady={drift.steady}
      endYear={drift.endYear}
      line={`Rupees lose ${pct(drift.drift)} a year against the dirham · steady plan ${steadyText(drift.steady, drift.endYear)}`}
      legend="With a weaker rupee"
      chartLabel={`With the rupee ${pct(drift.drift)} weaker a year, against the steady plan: the pot at the start of each year from ${drift.stopYear} to ${drift.endYear}. Use the arrow keys to move between years.`}
      money={money}
    />
  );
}

function RiskCard({ title, info, hit, steady, endYear, line, legend, chartLabel, money }) {
  const [active, setActive] = useState(null);
  const rows = hit.rows;
  const at = active === null ? null : rows[active];
  const steadyAt = at ? steady.rows.find((r) => r.year === at.year) : null;
  return (
    <Card
      title={title}
      info={<InfoButton about={title}>{info}</InfoButton>}
      right={<Chip tone={hit.lasts ? 'pos' : 'neg'}>{verdictText(hit, endYear)}</Chip>}
      className="pl-risk"
    >
      <p className="ds-muted pl-risk-line">{line}</p>
      <Fold label="Show the path">
        <TrendLine
          points={rows.map((r) => ({ key: r.year, label: String(r.year), value: r.start }))}
          compare={steady.rows.map((r) => r.start)}
          height={130}
          activeIndex={active}
          onActiveChange={setActive}
          ariaLabel={chartLabel}
        />
        <div className="pl-readout" aria-live="polite">
          {at ? (
            <>
              <span className="ds-fig">{at.year}</span>
              <span>
                {legend} <b>{money.fmtCompact(at.start)}</b>
              </span>
              {steadyAt && (
                <span>
                  Steady <b>{money.fmtCompact(steadyAt.start)}</b>
                </span>
              )}
            </>
          ) : (
            <ul className="ds-legend pl-legend">
              <li>
                <span className="ds-swatch pl-sw-working" />
                {legend}
              </li>
              <li>
                <span className="ds-swatch pl-sw-steady" />
                Steady
              </li>
            </ul>
          )}
        </div>
      </Fold>
    </Card>
  );
}
