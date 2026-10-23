import { realReturn } from '../../lib/forecast';

// The assumptions a planning view runs on, in the same place and the same
// words on Forecast, Life plan and Drawdown (SHR-325): the scenario, today's
// or future money, growth, and the spending the view is built on.
//
// Return, inflation and the withdrawal rate are the household's saved
// assumptions, shared by every planning view and edited in one place. The
// scenario and the money shown are a look for now: chosen on any of the three
// tabs, they hold on all of them until changed, and are never saved.
//
// `onMode` is left out by a view that only shows today's money; `spending` is
// the view's own description or control of the spending it uses; `growth`
// lists what else the view's figures depend on, beyond return and inflation.
export default function AssumptionsBar({ sets, scenario, onScenario, mode = 'real', onMode = null, growth = [], spending, onEdit }) {
  const selected = sets[scenario] ?? sets.baseline;
  const real = realReturn(selected.nominalPct, selected.inflationPct) * 100;
  return (
    <section className="pl-assumptions" aria-label="Assumptions">
      <div className="dd-control">
        <span className="dd-label">Scenario</span>
        <div className="dd-segs" role="group" aria-label="Scenario">
          {Object.values(sets).map((s) => (
            <button key={s.key} type="button" className="om-seg" data-active={scenario === s.key} aria-pressed={scenario === s.key} onClick={() => onScenario(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dd-control">
        <span className="dd-label">Show</span>
        {onMode ? (
          <div className="dd-segs" role="group" aria-label="Show">
            <button type="button" className="om-seg" data-active={mode === 'real'} aria-pressed={mode === 'real'} onClick={() => onMode('real')}>
              Today&rsquo;s money
            </button>
            <button type="button" className="om-seg" data-active={mode === 'nominal'} aria-pressed={mode === 'nominal'} onClick={() => onMode('nominal')}>
              Future money
            </button>
          </div>
        ) : (
          <span className="pl-assumptions-value">Today&rsquo;s money</span>
        )}
      </div>
      <div className="dd-control">
        <span className="dd-label">Growth</span>
        <span className="pl-assumptions-value fig">
          {selected.nominalPct.toFixed(1)}% return · {selected.inflationPct.toFixed(1)}% inflation · {real.toFixed(1)}% after inflation
          {growth.map((g) => ` · ${g}`).join('')}
        </span>
        {onEdit && (
          <button type="button" className="om-btn" onClick={onEdit}>
            Edit assumptions
          </button>
        )}
      </div>
      <div className="dd-control">
        <span className="dd-label">Spending</span>
        {spending}
      </div>
      <p className="ov-muted pl-assumptions-note">
        {scenario === 'baseline'
          ? 'Your saved assumptions. Return, inflation and the withdrawal rate are shared by Forecast, Life plan and Drawdown, and edited in one place.'
          : `The ${selected.label} scenario (${selected.meta.toLowerCase()}), shown on every planning tab until you switch back. It isn't saved.`}
        {onMode && mode === 'nominal' ? ' Future money: amounts grown with inflation to the year they happen.' : ''}
      </p>
    </section>
  );
}
