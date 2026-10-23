// Said wherever the numbers come from the budget rather than from what the
// household has actually spent (forecastInputs source 'budget'), so a plan
// never passes for a record. Forecast, Drawdown and the Plan summary share it
// and say the same thing.
export default function BudgetBasis({ inputs }) {
  if (inputs?.source !== 'budget') return null;
  const has = inputs.monthCount;
  return (
    <div className="pl-basis" role="note">
      <div>
        <b>From your budget, for now.</b> Spending here is your monthly spending budget and saving is your savings target, averaged
        over {inputs.budgetMonths} budgeted month{inputs.budgetMonths === 1 ? '' : 's'}. Actual spending takes over once three months
        have finished · {has === 0 ? 'none yet' : `${has} so far`}.
      </div>
    </div>
  );
}

// Once three months have ended, the records take over from the budget, and
// the budget used to drop out of view, though it is the plan as the household
// wrote it down. The Life plan says what each gives (Planning audit, 1.2).
// `recorded` and `budget` are each { inputs, earliest, result }; amounts are
// a month, in today's money.
export function BudgetBeside({ recorded, budget, stopYear, money }) {
  if (!budget) return null;
  const amount = (v) => `${money.code} ${money.fmt(v)}`;
  const year = (y) => (y === null ? 'no year' : y);
  const onBudget = budget.result.lasts ? 'lasts' : `runs short in ${budget.result.shortYear}`;
  return (
    <div className="pl-basis" role="note">
      <div>
        <b>Your budget beside the records.</b> The last {recorded.inputs.monthCount} ended months average spending {amount(recorded.inputs.avgMonthlySpend)} and
        saving {amount(recorded.inputs.monthlySaving)} a month; your budget plans spending {amount(budget.inputs.avgMonthlySpend)} and saving{' '}
        {amount(budget.inputs.monthlySaving)}. The earliest year work can stop is {year(recorded.earliest)} on the months and{' '}
        {year(budget.earliest)} on the budget. Stopping in {stopYear}, the money {onBudget} on the budget. Everything below uses the recorded months.
      </div>
    </div>
  );
}
