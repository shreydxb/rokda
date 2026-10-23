import { useState } from 'react';
import { monthKeyLabel } from '../../lib/forecast';
import BasisEditor from './BasisEditor';

// The basis a projection rests on, said in one line wherever one is worked
// out, with a way to change it (Planning audit, 2.9): the budget or the
// recorded months, why those, and from which month the records count. A plan
// never passes for a record, nor the records for the plan. `inputs` is
// forecastInputs'; amounts are a month, in today's money. Nothing is said
// before there is anything to go on, unless a basis was chosen.
export default function BasisLine({ inputs, householdId, assumptions, onSaved, money }) {
  const [editing, setEditing] = useState(false);
  if (!inputs || (!inputs.ready && !inputs.basis)) return null;
  const amount = (v) => `${money.code} ${money.fmt(v)}`;
  const since = inputs.recordsFrom ? ` since ${monthKeyLabel(inputs.recordsFrom)}` : '';
  const n = inputs.monthCount;
  const ended = `the last ${n} ended month${n === 1 ? '' : 's'}${since}`;
  const figures = `spending ${amount(inputs.avgMonthlySpend)} and saving ${amount(inputs.monthlySaving)} a month`;
  const Figures = figures[0].toUpperCase() + figures.slice(1);
  const budgeted = `${inputs.budgetMonths} budgeted month${inputs.budgetMonths === 1 ? '' : 's'}`;

  let lead;
  let text;
  if (!inputs.ready) {
    lead = 'No basis yet.';
    text =
      inputs.basis === 'budget'
        ? `You chose your budget, but no month has a spending budget, and fewer than three months have ended${since} to stand in.`
        : `You chose recorded months, and ${n === 0 ? 'none have' : `${n} of three have`} ended${since}; no month has a spending budget to stand in until then.`;
  } else if (inputs.source === 'budget') {
    lead = inputs.why === 'chosen' ? 'Your budget, as you chose.' : 'Your budget, for now.';
    text = `${Figures}, from your spending budget and savings target over ${budgeted}.`;
    if (inputs.why !== 'chosen') {
      text += ` ${inputs.basis === 'recorded' ? 'You chose recorded months; they' : 'Recorded months'} take over once three have ended${since} · ${n === 0 ? 'none yet' : `${n} so far`}.`;
    }
  } else if (inputs.why === 'no-budget') {
    lead = 'Recorded months, for now.';
    text = `You chose your budget, but no month has a spending budget, so ${ended} stand in: ${figures}.`;
  } else {
    lead = inputs.why === 'chosen' ? 'Recorded months, as you chose.' : 'Recorded months.';
    text = `The average of ${ended}: ${figures}.${inputs.why === 'chosen' ? '' : ' No basis is chosen, so the records took over from your budget once three months had ended.'}`;
  }

  return (
    <>
      <div className="pl-basis" role="note" aria-label="Planning basis">
        <div>
          <b>{lead}</b> {text}
        </div>
        {householdId && (
          <button type="button" className="om-btn" onClick={() => setEditing(true)}>
            Change basis
          </button>
        )}
      </div>
      {editing && (
        <BasisEditor
          householdId={householdId}
          assumptions={assumptions}
          recordedMonths={inputs.recordedMonths ?? []}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onSaved?.();
          }}
        />
      )}
    </>
  );
}

// Where the plan rests on the recorded months, the budget used to drop out of
// view, though it is the plan as the household wrote it down. The Life plan
// says what each gives (Planning audit, 1.2).
// `recorded` and `budget` are each { inputs, earliest, result }; amounts are
// a month, in today's money. The recorded figures are the basis line's, just
// above, so they are not said twice.
export function BudgetBeside({ recorded, budget, stopYear, money }) {
  if (!budget) return null;
  const amount = (v) => `${money.code} ${money.fmt(v)}`;
  const year = (y) => (y === null ? 'no year' : y);
  const onBudget = budget.result.lasts ? 'lasts' : `runs short in ${budget.result.shortYear}`;
  return (
    <div className="pl-basis" role="note">
      <div>
        <b>Your budget beside the records.</b> Your budget plans spending {amount(budget.inputs.avgMonthlySpend)} and saving{' '}
        {amount(budget.inputs.monthlySaving)} a month. The earliest year work can stop is {year(recorded.earliest)} on the recorded months and{' '}
        {year(budget.earliest)} on the budget. Stopping in {stopYear}, the money {onBudget} on the budget. Everything below uses the recorded
        months; choose your budget under Change basis to plan on it instead.
      </div>
    </div>
  );
}
