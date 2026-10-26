import { andList } from '../../lib/words';

// The rupee drift case (Planning audit, 4.19): the plan on Baseline with the
// rupee losing ground against the dirham every year, beside the plan as it is
// (lib/lifePlan.js, rupeeDrift). Shown only when something is set in rupees:
// what the pot holds in them, other income or a cost.
export default function RupeeDrift({ drift, scenarioLabel, agesText, money, shown }) {
  const { steady, weaker, rupees, stopYear, endYear } = drift;
  const pct = `${Math.round(drift.drift * 100)}%`;
  const what = [
    rupees.held > 0 && `${money.code} ${money.fmt(rupees.held)} held in rupees (${Math.round(rupees.share * 100)}% of what the plan starts from)`,
    rupees.incomes > 0 && `${rupees.incomes} source${rupees.incomes === 1 ? '' : 's'} of income in rupees`,
    rupees.costs > 0 && `${rupees.costs} cost${rupees.costs === 1 ? '' : 's'} in rupees`,
  ].filter(Boolean);
  const effects = [
    rupees.incomes > 0 && `income in rupees is worth less`,
    rupees.costs > 0 && `costs in rupees cost less`,
    rupees.held > 0 && `what is held in rupees loses value`,
  ].filter(Boolean);
  const cases = [
    { key: 'steady', label: 'The rupee as it is', outcome: steady },
    { key: 'weaker', label: `The rupee ${pct} weaker a year`, outcome: weaker },
  ];
  const earliestText =
    weaker.earliest === steady.earliest
      ? steady.earliest === null
        ? null
        : `The earliest year work can stop stays ${steady.earliest}.`
      : weaker.earliest === null
        ? 'With the rupee weaker, no stop year lasts with the plan as it is.'
        : `The earliest year work can stop moves from ${steady.earliest ?? 'none'} to ${weaker.earliest} (${agesText(weaker.earliest)}).`;
  const lessLeft = steady.lasts && weaker.lasts ? steady.left - weaker.left : null;

  return (
    <section style={{ marginTop: 40 }} aria-labelledby="lp-drift-head">
      <div className="ov-kicker" id="lp-drift-head">
        If the rupee weakens
      </div>
      <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch', marginTop: 8 }}>
        Here the rupee loses {pct} of its value against the dirham every year from this one, about its pace against the dollar, and so the dirham,
        over the past twenty years, with nothing in rupees making up for it. The plan counts {andList(what)}: {andList(effects)}. Stopping in{' '}
        {stopYear}, on Baseline
        {scenarioLabel !== 'Baseline' ? ` whichever scenario is chosen above` : ''}.
      </div>

      <div className="fc-kpis lp-drift" role="group" aria-label="The rupee">
        {cases.map(({ key, label, outcome }) => (
          <div key={key} className="fc-kpi">
            <div style={{ fontSize: 12, color: 'var(--ink2)' }}>{label}</div>
            <div className={`fig lp-fall-figure ${outcome.lasts ? '' : 'ov-neg'}`}>{outcome.lasts ? `Lasts to ${endYear}` : `Runs out in ${outcome.shortYear}`}</div>
            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>
              {outcome.lasts ? `${money.code} ${money.fmtBalance(shown(outcome.left, endYear + 1))} left at the end` : `${endYear - outcome.shortYear + 1} years before the plan ends`}
            </div>
          </div>
        ))}
      </div>

      <div className="ov-muted" style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: '84ch', marginTop: 14 }}>
        {lessLeft !== null && lessLeft > 0 && `${money.code} ${money.fmtBalance(shown(lessLeft, endYear + 1))} less at the end. `}
        {earliestText}
      </div>
    </section>
  );
}
