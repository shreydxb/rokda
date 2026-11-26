import { useMemo } from 'react';
import { useNow } from '../../lib/useNow';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { goalStatuses } from '../../lib/goals';
import { assumption } from '../../lib/planningDefaults';
import { debtOrder, debtsWithAccounts, minimumOnlyPayoff, orderDebts, simulatePayoffPlan } from '../../lib/debt';
import { cashReserve } from '../../lib/monthlyCheck';
import { planningModel } from '../../lib/planningModel';
import { neverLoaded } from '../../lib/loadState';
import { DEBT_INPUTS, DEBT_PLAN_INPUTS, GOALS_INPUTS, projectionInputs } from './planningSources';

// The Plan's figures: the stop year, the goals for the next 3 years, the
// debts and when they clear, the monthly check, and what needs a decision.
// Worked out once here for Planning -> Plan and for Overview's Plan strip
// (the revamp, phase 3), which show the same figures; it composes the goal,
// debt and life-plan outputs Goals, Debt payoff and the Life plan already
// compute -- no new financial math lives here.
export function usePlanFigures({ household = null, members, me, accounts, transactions, recurring = [], holdings, budgets = [], categories = [], data, sources }) {
  const { goals, goalContributions, goalAllocations, assumptions } = data;
  // At their linked accounts' balances, as Debt payoff shows them.
  const debts = useMemo(() => debtsWithAccounts(data.debts, accounts ?? []), [data.debts, accounts]);
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const now = useNow(data?.loadedAt);

  // Same rows the Goals tab shows, linked accounts and holdings included.
  // This card used to leave them out, so for a goal funded from an account it
  // showed less saved, and more goals behind, than the tab it links to.
  const goalInflation = assumption(assumptions, 'inflation_pct');
  // Each with its one status (Planning audit, 1.5), which the decisions below
  // read.
  const goalRows = useMemo(
    () =>
      goalStatuses({
        goals,
        contributions: goalContributions,
        allocations: goalAllocations ?? [],
        accounts: accounts ?? [],
        holdings: holdings ?? [],
        scopeMemberId,
        now,
        inflationPct: goalInflation,
      }),
    [goals, goalContributions, goalAllocations, accounts, holdings, scopeMemberId, now, goalInflation]
  );
  // The card leads with the next 3 years, in cash, as Goals does: the total
  // of every goal let an undated house drown the bar out (Planning audit, 1.5).
  const nearGoals = goalRows.filter((r) => r.kind === 'near');
  const nearCash = nearGoals.reduce((s, r) => s + r.cash, 0);
  const nearCost = nearGoals.reduce((s, r) => s + r.cost, 0);

  const debtsInView = useMemo(() => debts.filter((d) => scopeMemberId === null || d.is_shared || d.owner_member_id === scopeMemberId), [debts, scopeMemberId]);
  const visibleDebts = useMemo(
    () =>
      debtsInView.map((d) => {
        const factor = scopeMemberId === null || !d.is_shared ? 1 : 0.5;
        return { ...d, balance: Number(d.balance) * factor, original_amount: d.original_amount != null ? Number(d.original_amount) * factor : null };
      }),
    [debtsInView, scopeMemberId]
  );
  const totalOwed = visibleDebts.reduce((s, d) => s + Number(d.balance), 0);

  // At the minimums, each debt in view clears on its own date, whoever is
  // looking: a shared debt's half balance and half minimum clear together.
  const atMinimums = useMemo(() => minimumOnlyPayoff(debtsInView), [debtsInView]);
  // A committed extra payment is the household's, so its projection is shown
  // only with both of you selected, as Debt payoff does. In one partner's
  // view this card showed a household date that Debt payoff refused to show.
  // In the order chosen on Debt payoff; this always used avalanche.
  const orderedFull = useMemo(() => orderDebts(debts, debtOrder(assumptions)), [debts, assumptions]);
  const extraPayment = assumptions?.debt_extra_payment != null ? Number(assumptions.debt_extra_payment) : null;
  const canProjectDebt = scopeMemberId === null && extraPayment !== null && extraPayment > 0 && debts.length > 0;
  const debtPlan = useMemo(() => (canProjectDebt ? simulatePayoffPlan(orderedFull, extraPayment) : null), [canProjectDebt, orderedFull, extraPayment]);

  // The planning model, built in one place for every tab (lib/planningModel.js;
  // Planning audit, 3.12): the start, the basis, what stops, the loans, and
  // the Life plan's answer on the saved plan and on the budget's figures.
  const { memberLife, independenceIncome, afterWorkCosts, debts: debtRows } = data;
  const model = useMemo(
    () =>
      planningModel({
        accounts,
        holdings,
        transactions,
        recurring,
        budgets,
        categories,
        data: { assumptions, goals, memberLife, independenceIncome, afterWorkCosts, debts: debtRows },
        members: members ?? [],
        household,
        now,
      }),
    [accounts, holdings, transactions, recurring, budgets, categories, assumptions, goals, memberLife, independenceIncome, afterWorkCosts, debtRows, members, household, now]
  );
  const { inputs: forecast } = model;
  // Balances nobody has entered count as 0 in every projection here, so each
  // one is provisional until they are (Planning audit, 1.1); what the start
  // leaves out is said beside the answer. Household-wide, as the projections
  // are, and worked out once with the model for every tab (3.15).
  const { unentered, incomplete: basisIncomplete } = model.startGaps;
  const provisional = unentered.length > 0 ? `Provisional: ${unentered.length} balance${unentered.length === 1 ? '' : 's'} not entered, counted as 0` : null;
  // With ages set, the Life plan answers when work can stop, and only it does:
  // the 25x target of money that lasts forever, decades later, used to answer
  // here until ages were set, and went with Forecast (Planning audit, 3.15).
  const stop = useMemo(() => model.stop(), [model]);

  // What rests on records that never arrived is withheld rather than worked
  // out from an empty placeholder: with goals and debts unread, this page
  // said "All clear" and moved the stop year (lib/loadState.js, neverLoaded).
  const goalsMissing = neverLoaded(sources, GOALS_INPUTS);
  const debtsMissing = neverLoaded(sources, DEBT_INPUTS);
  const debtPlanMissing = neverLoaded(sources, DEBT_PLAN_INPUTS);
  const answerMissing = neverLoaded(sources, projectionInputs(forecast));
  const accountsMissing = neverLoaded(sources, ['household', 'accounts']);

  // The money the household keeps rather than spends is the reserve's target.
  const keptCost = useMemo(
    () =>
      goalStatuses({
        goals,
        contributions: goalContributions,
        allocations: goalAllocations ?? [],
        accounts: accounts ?? [],
        holdings: holdings ?? [],
        scopeMemberId: null,
        now,
        inflationPct: goalInflation,
      })
        .filter((r) => r.kind === 'kept')
        .reduce((sum, r) => sum + r.cost, 0),
    [goals, goalContributions, goalAllocations, accounts, holdings, now, goalInflation]
  );
  const reserve = useMemo(
    () => cashReserve({ accounts: accounts ?? [], monthlySpend: forecast.ready ? forecast.avgMonthlySpend : null, keptCost }),
    [accounts, forecast, keptCost]
  );
  // The reserve is months of the plan's spending, read from the records: with
  // them unread it said "Needs the plan's monthly spending" (the review of
  // the whole revamp).
  const reserveMissing = [...new Set([...accountsMissing, ...goalsMissing, ...neverLoaded(sources, ['transactions'])])];

  // Checks that change what you do. "N goals behind pace" and the nudge to
  // commit an extra debt payment went (Planning audit, 1.1): the first counted
  // what was logged to a goal in the last 90 days, so goals with no date, or
  // fed through a linked account, read as behind while Goals called them
  // covered; the second pressed for prepaying a loan before any cash reserve
  // was in place. The goal checks are Goals' own rule now (1.5): a goal due
  // within 3 years short of cash, and a goal with no date, which no plan pays.
  // A goal whose planned monthly amount covers it by its date is settled, so
  // it is not raised (2.7).
  const shortOfCash = goalRows.filter((r) => r.kind === 'near' && (r.state === 'saving' || r.state === 'due') && !r.plan?.enough);

  return { goals, debts, scopeMemberId, now, goalRows, nearGoals, nearCash, nearCost, visibleDebts, totalOwed, atMinimums, canProjectDebt, debtPlan, forecast, unentered, basisIncomplete, provisional, stop, goalsMissing, debtsMissing, debtPlanMissing, answerMissing, accountsMissing, keptCost, reserve, reserveMissing, shortOfCash, assumptions };
}
