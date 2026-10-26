import { useId, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import { cashPerMonth, goalStatuses, isDone } from '../../lib/goals';
import { assumption } from '../../lib/planningDefaults';
import { debtOrder, debtsWithAccounts, minimumOnlyPayoff, minimumOnlyText, orderDebts, payoffMonthLabel, simulatePayoffPlan } from '../../lib/debt';
import { andList } from '../../lib/words';
import { tabHref } from '../../lib/activityLink';
import { reviewMonth, reviewMonthParam } from '../../lib/monthlyReview';
import { cashReserve, savingCheck } from '../../lib/monthlyCheck';
import { agesLabel, DEFAULT_STOP_AGE, leftOutText, rangeText, spendAfterText } from '../../lib/lifePlan';
import { planningModel } from '../../lib/planningModel';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { DEBT_INPUTS, DEBT_PLAN_INPUTS, GOALS_INPUTS, projectionInputs } from './planningSources';
import BasisLine from './BasisLine';


// When the debts in view clear. With a committed extra payment, on the
// household's plan; otherwise at the minimum payments, which is the date the
// household is on until it commits more. "No payoff date set" used to stand
// in for this whenever no extra payment was saved, though the minimums alone
// clear a loan on a date (Planning audit, 1.1).
function payoffText({ atMinimums, withExtra, now }) {
  if (atMinimums.owed === 0) return 'Nothing owed';
  if (withExtra !== undefined) {
    return withExtra ? `Clears about ${payoffMonthLabel(withExtra.months, now)} with the extra payment` : "Doesn't clear within 50 years with the extra payment";
  }
  return minimumOnlyText(atMinimums, now);
}

// Composes the same goal, debt and life-plan outputs Goals, Debt payoff and
// the Life plan already compute — no new financial math lives here, just a
// next-action read.
// Plan is in dirhams, as Goals and Debt payoff are (Planning.jsx, AedNote).
const AED = { code: 'AED', fmt: (v) => formatMoney(v) };
const aed = (v) => `AED ${formatMoney(v)}`;

export default function PlanSummary({ household = null, members, me, accounts, transactions, recurring = [], holdings, budgets = [], categories = [], data, sources, onRetry, loading, onOpenTab }) {
  const { goals, goalContributions, goalAllocations, assumptions } = data;
  // At their linked accounts' balances, as Debt payoff shows them.
  const debts = useMemo(() => debtsWithAccounts(data.debts, accounts ?? []), [data.debts, accounts]);
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const now = useMemo(() => new Date(), []);

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
  const goalsElsewhere = [
    ['later', 'later'],
    ['kept', 'kept'],
    ['undated', 'with no date'],
  ]
    .map(([kind, words]) => [goalRows.filter((r) => r.kind === kind).length, words])
    .filter(([n]) => n > 0)
    .map(([n, words]) => `${n} ${words}`);

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
  // Paid down so far, over the debts whose original amount is known -- the
  // same per-debt "paid down" the Debt payoff tab draws, summed.
  const withOriginal = visibleDebts.filter((d) => d.original_amount > 0);
  const originalTotal = withOriginal.reduce((s, d) => s + d.original_amount, 0);
  const paidDown = originalTotal > 0 ? Math.max(0, 1 - withOriginal.reduce((s, d) => s + d.balance, 0) / originalTotal) : null;

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
  // The same answer on the budget's figures stays beside it while the records
  // are the basis (1.2).
  const stop = useMemo(() => model.stop(), [model]);
  const budgetStop = useMemo(() => model.stop({ budget: true }), [model]);

  // What rests on records that never arrived is withheld rather than worked
  // out from an empty placeholder: with goals and debts unread, this page
  // said "All clear" and moved the stop year (lib/loadState.js, neverLoaded).
  const goalsMissing = neverLoaded(sources, GOALS_INPUTS);
  const debtsMissing = neverLoaded(sources, DEBT_INPUTS);
  const debtPlanMissing = neverLoaded(sources, DEBT_PLAN_INPUTS);
  const answerMissing = neverLoaded(sources, projectionInputs(forecast));
  const accountsMissing = neverLoaded(sources, ['household', 'accounts']);
  // Each item below is offered only when what it rests on loaded; the rest
  // are named once as not checked, never folded into "All clear".
  const unchecked = [...new Set([...goalsMissing, ...debtsMissing, ...debtPlanMissing, ...answerMissing, ...accountsMissing])];

  // The monthly check (Planning audit, 2.11): the checks Review and the cash
  // cover already make, not a fourth. It is the household's whoever is shown,
  // as the review is: a month's saving and the cash to hand are shared.
  // Saving is the month just ended, the one Review opens on; a running month
  // has its pay still to come.
  const checkMonth = useMemo(() => reviewMonth(null, now), [now]);
  const saving = useMemo(() => savingCheck(checkMonth, { transactions, budgets, categories }, now), [checkMonth, transactions, budgets, categories, now]);
  const savingMissing = neverLoaded(sources, ['transactions', 'budgets', 'categories']);
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
  const reserveMissing = [...new Set([...accountsMissing, ...goalsMissing])];

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
  const cashSchedule = cashPerMonth(shortOfCash);
  const noDate = goalRows.filter((r) => r.kind === 'undated');
  const actions = [
    goalsMissing.length === 0 && shortOfCash.length > 0 && {
      key: 'goals-cash',
      text: `Due within 3 years and short of cash, with no plan that covers ${shortOfCash.length === 1 ? 'it' : 'them'}: ${andList(shortOfCash.map((r) => r.goal.name))}, ${formatMoney(
        shortOfCash.reduce((s, r) => s + r.remaining, 0)
      )} still to set aside${cashSchedule ? ` (${formatMoney(cashSchedule.now)} a month now${cashSchedule.planned != null ? `, ${formatMoney(cashSchedule.planned)} planned` : ''})` : ''}.`,
      tab: 'goals',
      cta: 'Open Goals',
    },
    goalsMissing.length === 0 && noDate.length > 0 && {
      key: 'goals-undated',
      text: `No date, so no plan pays for ${noDate.length === 1 ? 'it' : 'them'}: ${andList(noDate.map((r) => `${r.goal.name} (${formatMoney(r.cost)})`))}.`,
      tab: 'goals',
      cta: 'Open Goals',
    },
    accountsMissing.length === 0 && unentered.length > 0 && {
      key: 'balances',
      text: `${unentered.length === 1 ? 'Balance' : 'Balances'} not entered: ${andList(unentered.slice(0, 3).map((a) => a.name))}${
        unentered.length > 3 ? ` and ${unentered.length - 3} more` : ''
      }. Every figure here counts ${unentered.length === 1 ? 'it' : 'them'} as 0.`,
      href: tabHref('/wealth', 'accounts'),
      cta: 'Open Accounts',
    },
    answerMissing.length === 0 && !forecast.ready && {
      key: 'projection',
      text:
        forecast.why === 'no-budget'
          ? 'The stop year needs a monthly budget, the basis you chose'
          : !forecast.hasNetWorth
            ? 'The stop year needs a starting account valuation'
            : `The stop year needs three ended months of records or a budget · has ${forecast.monthCount}`,
      tab: 'life',
      cta: 'Open Life plan',
    },
  ].filter(Boolean);

  const isEmpty = goals.length === 0 && debts.length === 0 && !forecast.ready && unchecked.length === 0;

  // What the stop year rests on that isn't a record, each said once under it
  // (Planning audit, 1.1). A year nobody chose was called "your plan's".
  const stopCaveats = (stop) =>
    [
      budgetStop && { text: `On your budget's figures rather than the recorded months: ${rangeText(budgetStop.range.slice(0, 1), aed)}.` },
      stop.stopAssumed && {
        text: `${stop.stopYear} is assumed${
          stop.stopYear === stop.stopAssumed.birthYear + DEFAULT_STOP_AGE ? `, the year ${stop.stopAssumed.name} turns ${DEFAULT_STOP_AGE},` : ''
        } until you choose a year on the Life plan.`,
      },
      provisional && { text: `${provisional}.` },
      stop.leftOut.length > 0 && { text: leftOutText(stop.leftOut), warn: true },
      scopeMemberId !== null && { text: "The household's year, whoever is selected." },
    ].filter(Boolean);

  // The answer to when work can stop: the Life plan's year once ages are set,
  // with what it assumes about spending (SHR-324), and before that what it
  // needs.
  const answerCard = answerMissing.length > 0 ? (
    <SummaryCard label="Stop working" figure="—" note={`${couldntLoad(answerMissing)} No year is worked out without them.`} cta="Life plan" onClick={() => onOpenTab('life')} />
  ) : (
    stop ? (
      <SummaryCard
        label="Stop working"
        // The Life plan's year with its range, not the zero-margin earliest
        // year (Planning audit, 3.12).
        figure={String(stop.stopYear)}
        note={`${agesLabel(stop.stopAges)} · ${rangeText(stop.range, aed)} · ${spendAfterText(stop, aed)}${basisIncomplete ? ` · incomplete, ${basisIncomplete}` : ''}${
          forecast.source === 'budget' ? ' · from your budget' : ''
        }`}
        caveats={stopCaveats(stop)}
        cta="Life plan"
        onClick={() => onOpenTab('life')}
      />
    ) : (
      // Until each person's birth year and age to plan to are set there is no
      // year to give, and the card says what it needs (Planning audit, 3.15).
      <SummaryCard
        label="Stop working"
        figure="—"
        note={
          forecast.ready
            ? `Set each person's birth year and the age to plan to, and this gives the year work can stop, with its range${basisIncomplete ? ` · incomplete, ${basisIncomplete}` : ''}`
            : 'Not enough to project yet: the Life plan says what it needs.'
        }
        caveats={forecast.ready && provisional ? [{ text: `${provisional}.` }] : []}
        cta="Life plan"
        onClick={() => onOpenTab('life')}
      />
    )
  );

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  if (isEmpty) {
    return (
      <div className="ov-empty" style={{ marginTop: 22 }}>
        <div className="ov-empty-kicker">Nothing to plan yet</div>
        <div className="ov-empty-body">
          Add a goal, a debt, or a few months of activity and accounts, and this page will summarize where each stands.
        </div>
        <div className="ov-empty-actions">
          <button type="button" className="om-btn ov-btn-primary" onClick={() => onOpenTab('goals')}>
            Add a goal
          </button>
          <button type="button" className="om-btn" onClick={() => onOpenTab('debt')}>
            Add a debt
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {answerMissing.length === 0 && <BasisLine inputs={forecast} householdId={household?.id} assumptions={assumptions} onSaved={data.reload} money={AED} />}
      <section className="ov-quality-grid" style={{ marginTop: 22, rowGap: 26 }}>
        {(stop || answerMissing.length > 0) && answerCard}
        <SummaryCard
          label="Goals"
          figure={goalsMissing.length === 0 && nearGoals.length > 0 ? formatMoney(nearCash) : '—'}
          progress={goalsMissing.length === 0 && nearGoals.length > 0 && nearCost > 0 ? nearCash / nearCost : null}
          note={
            goalsMissing.length > 0
              ? couldntLoad(goalsMissing)
              : goalRows.length > 0
                ? [nearGoals.length > 0 ? `of ${formatMoney(nearCost)} in cash for the next 3 years` : 'Nothing due within 3 years', ...goalsElsewhere].join(' · ')
                : goals.some(isDone)
                  ? 'Every goal is done'
                  : 'No goals yet'
          }
          cta="Goals"
          onClick={() => onOpenTab('goals')}
        />
        <SummaryCard
          label="Debt payoff"
          figure={debtsMissing.length === 0 && visibleDebts.length > 0 ? `−${formatMoney(totalOwed)}` : '—'}
          progress={debtsMissing.length === 0 ? paidDown : null}
          progressLabel={debtsMissing.length === 0 && paidDown !== null ? `${formatPct(paidDown)} paid down` : null}
          note={
            debtsMissing.length > 0
              ? couldntLoad(debtsMissing)
              : visibleDebts.length === 0
              ? 'No debts on record'
              : debtPlanMissing.length > 0
                ? `${couldntLoad(debtPlanMissing)} No payoff date is worked out.`
              : `${payoffText({ atMinimums, withExtra: canProjectDebt ? debtPlan : undefined, now })}${visibleDebts.some((d) => !d.inNetWorth) ? ' · not all in net worth' : ''}`
          }
          cta="Debt payoff"
          onClick={() => onOpenTab('debt')}
        />
        {!stop && answerMissing.length === 0 && answerCard}
      </section>

      <MonthlyCheck
        month={checkMonth}
        saving={saving}
        savingMissing={savingMissing}
        reserve={reserve}
        reserveMissing={reserveMissing}
      />

      <section style={{ marginTop: 40 }}>
        <div className="ov-section-head">
          <div className="ov-kicker">What needs a decision</div>
          <div className="ov-muted">
            {unchecked.length > 0 ? (actions.length ? `${actions.length} open · not all checked` : 'Not all checked') : actions.length ? `${actions.length} open` : 'All clear'}
          </div>
        </div>
        {actions.length === 0 && unchecked.length === 0 ? (
          <div className="ov-allclear">
            <span className="ov-dot-pos" />
            <span>All clear — nothing here needs a decision.</span>
          </div>
        ) : (
          <div className="ov-attn-list">
            {actions.map((a) => (
              <div key={a.key} className="ov-attn-row">
                <div className="ov-attn-main">
                  <span>{a.text}</span>
                </div>
                {a.href ? (
                  <Link className="om-btn ov-attn-btn" to={a.href}>
                    {a.cta}
                  </Link>
                ) : (
                  <button type="button" className="om-btn ov-attn-btn" onClick={() => onOpenTab(a.tab)}>
                    {a.cta}
                  </button>
                )}
              </div>
            ))}
            {unchecked.length > 0 && (
              <div className="ov-attn-row">
                <div className="ov-attn-main">
                  <span>{couldntLoad(unchecked)} What rests on them isn&rsquo;t checked.</span>
                </div>
                {onRetry && (
                  <button type="button" className="om-btn ov-attn-btn" onClick={onRetry}>
                    Try again
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

const months = (m) => `${m.toFixed(1)} month${m.toFixed(1) === '1.0' ? '' : 's'}`;

// Saving in the month just ended against the budget's target, and the cash
// reserve in months of the plan's spending against what the kept goals hold
// (Planning audit, 2.11). Each line says what it couldn't check.
function MonthlyCheck({ month, saving, savingMissing, reserve, reserveMissing }) {
  const name = new Date(month.year, month.month - 1, 1).toLocaleDateString('en-GB', { month: 'long' });
  const savingText =
    savingMissing.length > 0
      ? `${couldntLoad(savingMissing)} Saving in ${name} isn\u2019t checked.`
      : !saving
        ? `Saving in ${name}: the budget sets no savings target for it to be checked against.`
        : `Saving in ${name}: ${saving.saved < 0 ? '\u2212' : ''}${formatMoney(saving.saved)} against a target of ${formatMoney(saving.target)}, ${saving.short > 0 ? `${formatMoney(saving.short)} short` : 'on target'}.`;

  let reserveText;
  if (reserveMissing.length > 0) {
    reserveText = `${couldntLoad(reserveMissing)} The cash reserve isn\u2019t worked out.`;
  } else {
    reserveText = `Cash reserve: ${formatMoney(reserve.liquid)} in current, savings and cash accounts`;
    if (reserve.months !== null) reserveText += `, about ${months(reserve.months)} of spending`;
    if (reserve.target === null) reserveText += '; no kept goal, like an emergency fund, sets a target for it';
    else {
      const held = `the ${formatMoney(reserve.target)} your kept goals hold${reserve.targetMonths !== null ? ` (${months(reserve.targetMonths)})` : ''}`;
      reserveText += reserve.liquid >= reserve.target ? `, which covers ${held}` : `, short of ${held}`;
    }
    reserveText += '.';
    if (reserve.months === null) reserveText += ' Months of spending need three ended months or a budget.';
    if (reserve.unvalued > 0) reserveText += ` ${reserve.unvalued === 1 ? 'One account has' : `${reserve.unvalued} accounts have`} no AED value and count as nothing.`;
  }

  return (
    <section style={{ marginTop: 40 }} aria-label="Monthly check">
      <div className="ov-section-head">
        <div className="ov-kicker">Monthly check</div>
        <div className="ov-muted">For the household</div>
      </div>
      <div className="ov-attn-list">
        <div className="ov-attn-row">
          <div className="ov-attn-main">
            <span>{savingText}</span>
          </div>
          <Link className="om-btn ov-attn-btn" to={tabHref('/money', 'review', { month: reviewMonthParam(month.year, month.month) })}>
            Open Review
          </Link>
        </div>
        <div className="ov-attn-row">
          <div className="ov-attn-main">
            <span>{reserveText}</span>
          </div>
          <Link className="om-btn ov-attn-btn" to={tabHref('/wealth', 'accounts')}>
            Open Accounts
          </Link>
        </div>
      </div>
    </section>
  );
}

// A real button: it was a div that answered Enter but not Space, and was
// read out as one run of text (Planning audit, 0b-F). It is named by where it
// goes and described by its figure and note.
function SummaryCard({ label, figure, note, cta, onClick, progress = null, progressLabel = null, caveats = [] }) {
  const id = useId();
  return (
    <button type="button" className="pl-card" onClick={onClick} aria-label={`${label}: open ${cta}`} aria-describedby={`${id}-figure ${id}-note${caveats.length ? ` ${id}-caveats` : ''}`}>
      <span className="ov-quality-row">
        <span className="ov-kicker" style={{ marginBottom: 0 }}>{label}</span>
        <span className="ov-link">{cta} →</span>
      </span>
      <span className="fig pl-card-figure" id={`${id}-figure`}>
        {figure}
      </span>
      {progress !== null && (
        <span className="bud-bar pl-card-bar" aria-hidden="true">
          <span className="bud-bar-spent" style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
        </span>
      )}
      <span className="ov-muted ov-quality-note pl-card-note" id={`${id}-note`}>
        {note}
        {progressLabel && ` · ${progressLabel}`}
      </span>
      {caveats.length > 0 && (
        <span className="pl-card-caveats" id={`${id}-caveats`}>
          {caveats.map((c) => (
            <span key={c.text} className={`pl-card-caveat ${c.warn ? 'ov-warn' : 'ov-muted'}`}>
              {c.text}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
