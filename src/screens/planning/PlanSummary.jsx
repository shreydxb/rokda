import { useId } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney, formatPct } from '../../lib/money';
import { isDone } from '../../lib/goals';
import { minimumOnlyText, payoffMonthLabel } from '../../lib/debt';
import { tabHref } from '../../lib/activityLink';
import { reviewMonthParam } from '../../lib/monthlyReview';
import { agesLabel, DEFAULT_STOP_AGE, leftOutText, rangeText, spendAfterText } from '../../lib/lifePlanBasis';
import { couldntLoad } from '../../lib/loadState';
import { usePlanFigures } from './usePlanFigures';
import BasisLine from './BasisLine';
import './PlanSummary.css';


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
  const { goals, scopeMemberId, now, goalRows, nearGoals, nearCash, nearCost, goalsElsewhere, visibleDebts, totalOwed, paidDown, atMinimums, canProjectDebt, debtPlan, forecast, basisIncomplete, provisional, stop, budgetStop, goalsMissing, debtsMissing, debtPlanMissing, answerMissing, unchecked, checkMonth, saving, savingMissing, reserve, reserveMissing, actions, isEmpty, assumptions } = usePlanFigures({ household, members, me, accounts, transactions, recurring, holdings, budgets, categories, data, sources });

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
