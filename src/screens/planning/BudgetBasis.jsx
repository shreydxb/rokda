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
