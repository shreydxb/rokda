import { useId, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import { scopedGoalRows } from '../../lib/goals';
import { assumption } from '../../lib/planningDefaults';
import { debtOrder, debtsWithAccounts, minimumOnlyPayoff, minimumOnlyText, orderDebts, payoffMonthLabel, simulatePayoffPlan } from '../../lib/debt';
import { andList } from '../../lib/words';
import { isArchived } from '../../lib/accounts';
import { unconfirmedAccounts } from '../../lib/balance';
import { tabHref } from '../../lib/activityLink';
import { budgetInputs, budgetPlan, crossingYear, forecastInputs, incomesFromStop, independenceTarget, realReturn, spendThatStops } from '../../lib/forecast';
import { agesLabel, DEFAULT_STOP_AGE, leftOutText, lifePlanStop, noStopText, spendAfterText } from '../../lib/lifePlan';
import { incompleteNote, netWorthSummary, startingNetWorth } from '../overviewMath';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { DEBT_INPUTS, DEBT_PLAN_INPUTS, GOALS_INPUTS, projectionInputs } from './planningSources';


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

// Composes the same goal/debt/forecast outputs Goals, DebtPayoff and Forecast
// already compute — no new financial math lives here, just a next-action read.
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
  const goalRows = useMemo(
    () =>
      scopedGoalRows({
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
  const goalsSaved = goalRows.reduce((s, r) => s + r.progress.saved, 0);
  const goalsTarget = goalRows.reduce((s, r) => s + r.progress.target, 0);

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

  // Balances nobody has entered count as 0 in every projection here, so each
  // one is provisional until they are (Planning audit, 1.1). Household-wide,
  // as the projections are; Forecast and Net worth apply the same rule.
  const unentered = useMemo(() => unconfirmedAccounts((accounts ?? []).filter((a) => !isArchived(a))), [accounts]);
  const provisional = unentered.length > 0 ? `Provisional: ${unentered.length} balance${unentered.length === 1 ? '' : 's'} not entered, counted as 0` : null;

  // The same basis Forecast projects from, not a rule of this card's own:
  // "any account or holding exists" let a household whose only holding had
  // never been valued start from that holding's placeholder 0 (SHR-292).
  const startNetWorth = useMemo(() => startingNetWorth(accounts, holdings), [accounts, holdings]);
  const basisIncomplete = useMemo(() => {
    const s = netWorthSummary(accounts, null, holdings);
    return incompleteNote({ accounts: s.unvalued, holdings: s.unpricedHoldings }, { capitalised: false, sentence: false });
  }, [accounts, holdings]);
  // The same inputs Forecast and Drawdown use, the budget standing in included.
  const plan = useMemo(() => budgetPlan(budgets, categories, now), [budgets, categories, now]);
  const forecast = useMemo(() => forecastInputs(transactions, startNetWorth, now, plan, recurring), [transactions, startNetWorth, now, plan, recurring]);
  const stopping = useMemo(() => spendThatStops({ inputs: forecast, transactions, budgets, categories, now }), [forecast, transactions, budgets, categories, now]);
  const nominalPct = assumption(assumptions, 'nominal_return_pct');
  const inflationPct = assumption(assumptions, 'inflation_pct');
  const swrPct = assumption(assumptions, 'safe_withdrawal_pct');
  const fireTarget = forecast.ready ? independenceTarget(forecast.annualSpend, swrPct, incomesFromStop(data.independenceIncome ?? [], household)).target : null;
  const fireYear = forecast.ready
    ? crossingYear({
        startYear: now.getFullYear(),
        startNetWorth,
        annualSaving: forecast.monthlySaving * 12,
        rate: realReturn(nominalPct, inflationPct),
        mode: 'real',
        inflationPct,
        goal: fireTarget,
      })
    : null;
  // With ages set, the Life plan answers when work can stop: the first year
  // its money lasts to the end. The 25x target above is money that lasts
  // forever, decades later, and used to be the only answer here.
  const stopFrom = useMemo(
    () => (inputs, spendStopping) =>
      lifePlanStop({
        members: members ?? [],
        memberLife: data.memberLife ?? [],
        assumptions,
        inputs,
        startNetWorth,
        goals: goals ?? [],
        incomes: data.independenceIncome ?? [],
        household,
        stopping: spendStopping,
        startYear: now.getFullYear(),
        now,
      }),
    [members, data.memberLife, assumptions, startNetWorth, goals, data.independenceIncome, household, now]
  );
  const stop = useMemo(() => stopFrom(forecast, stopping), [stopFrom, forecast, stopping]);
  // The same answer on the budget's figures, once three ended months have
  // taken over from it: the budget used to drop out of view then, though it
  // is the plan the household wrote down (Planning audit, 1.2).
  const budgetBasis = useMemo(() => (forecast.source === 'actual' ? budgetInputs(plan, startNetWorth, forecast.monthCount) : null), [forecast, plan, startNetWorth]);
  const budgetStop = useMemo(() => {
    if (!budgetBasis) return null;
    return stopFrom(budgetBasis, spendThatStops({ inputs: budgetBasis, transactions, budgets, categories, now }));
  }, [stopFrom, budgetBasis, transactions, budgets, categories, now]);

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

  // Checks that change what you do. "N goals behind pace" and the nudge to
  // commit an extra debt payment went (Planning audit, 1.1): the first counted
  // what was logged to a goal in the last 90 days, so goals with no date, or
  // fed through a linked account, read as behind while Goals called them
  // covered; the second pressed for prepaying a loan before any cash reserve
  // was in place. The goal check returns with Goals' 3-year rule.
  const actions = [
    accountsMissing.length === 0 && unentered.length > 0 && {
      key: 'balances',
      text: `${unentered.length === 1 ? 'Balance' : 'Balances'} not entered: ${andList(unentered.slice(0, 3).map((a) => a.name))}${
        unentered.length > 3 ? ` and ${unentered.length - 3} more` : ''
      }. Every figure here counts ${unentered.length === 1 ? 'it' : 'them'} as 0.`,
      href: tabHref('/wealth', 'accounts'),
      cta: 'Open Accounts',
    },
    answerMissing.length === 0 && !forecast.ready && {
      key: 'forecast',
      text:
        forecast.monthCount < 3
          ? `Independence needs three closed months of spend or a budget · has ${forecast.monthCount}`
          : 'Independence needs a starting account valuation',
      tab: 'forecast',
      cta: 'Open Forecast',
    },
  ].filter(Boolean);

  const isEmpty = goals.length === 0 && debts.length === 0 && !forecast.ready && unchecked.length === 0;

  // What the stop year rests on that isn't a record, each said once under it
  // (Planning audit, 1.1). A year nobody chose was called "your plan's".
  const stopCaveats = (stop) =>
    [
      budgetStop && {
        text:
          budgetStop.earliest !== null
            ? `On your budget's figures rather than the recorded months: ${budgetStop.earliest}.`
            : "On your budget's figures rather than the recorded months, no year lasts.",
      },
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
  // and then the first card, with what it assumes about spending (SHR-324).
  // Before that, the independence year, after goals and debt as it always was.
  const answerCard = answerMissing.length > 0 ? (
    <SummaryCard label="Stop working" figure="—" note={`${couldntLoad(answerMissing)} No year is worked out without them.`} cta="Life plan" onClick={() => onOpenTab('life')} />
  ) : (
    stop ? (
      <SummaryCard
        label="Stop working"
        figure={stop.earliest !== null ? String(stop.earliest) : 'No year lasts'}
        note={
          stop.earliest !== null
            ? `${agesLabel(stop.ages)} · the money lasts to ${stop.endYear} · ${spendAfterText(stop, (v) => `AED ${formatMoney(v)}`)}${
                stop.earliest > stop.stopYear ? ` · not by ${stop.stopAssumed ? '' : "your plan's "}${stop.stopYear}` : ''
              }${basisIncomplete ? ` · incomplete, ${basisIncomplete}` : ''}${forecast.source === 'budget' ? ' · from your budget' : ''}`
            : noStopText(stop)
        }
        caveats={stopCaveats(stop)}
        cta="Life plan"
        onClick={() => onOpenTab('life')}
      />
    ) : (
      <SummaryCard
        label="Independence"
        figure={forecast.ready ? String(fireYear ?? '60+ yrs out') : '—'}
        progress={forecast.ready && fireTarget > 0 ? startNetWorth / fireTarget : null}
        note={
          forecast.ready
            ? // The progress figure rests on a net worth that skips any
              // account with no AED conversion, so it reads high when one
              // of those is a debt (QA #4), and any holding never valued
              // (SHR-292). Say so here rather than only on Forecast, since
              // this card is what most people look at.
              `${formatPct(startNetWorth / fireTarget)} of the way to ${formatMoney(fireTarget)}${
                basisIncomplete ? ` · incomplete, ${basisIncomplete}` : ''
              }${forecast.source === 'budget' ? ' · from your budget' : ''}`
            : 'Not enough data to project'
        }
        caveats={forecast.ready && provisional ? [{ text: `${provisional}.` }] : []}
        cta="Forecast"
        onClick={() => onOpenTab('forecast')}
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
      <section className="ov-quality-grid" style={{ marginTop: 22, rowGap: 26 }}>
        {(stop || answerMissing.length > 0) && answerCard}
        <SummaryCard
          label="Goals"
          figure={goalsMissing.length === 0 && goalRows.length > 0 ? formatMoney(goalsSaved) : '—'}
          progress={goalsMissing.length === 0 && goalRows.length > 0 && goalsTarget > 0 ? goalsSaved / goalsTarget : null}
          note={
            goalsMissing.length > 0
              ? couldntLoad(goalsMissing)
              : goalRows.length > 0
                ? `of ${formatMoney(goalsTarget)} target · ${goalRows.length} goal${goalRows.length === 1 ? '' : 's'}`
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
