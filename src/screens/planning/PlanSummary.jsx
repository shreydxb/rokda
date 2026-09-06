import { useMemo } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import { goalProgress } from '../../lib/goals';
import { orderDebts, simulatePayoffPlan } from '../../lib/debt';
import { closedMonths, crossingYear, fiTarget, forecastInputs } from '../../lib/forecast';
import { netWorthSummary } from '../overviewMath';

const DEFAULTS = { nominal_return_pct: 6.0, inflation_pct: 2.5, safe_withdrawal_pct: 4.0 };

function monthsToLabel(months) {
  if (months === null) return null;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${rem} mo`;
  if (rem === 0) return `${years} yr`;
  return `${years} yr ${rem} mo`;
}

// Composes the same goal/debt/forecast outputs Goals, DebtPayoff and Forecast
// already compute — no new financial math lives here, just a next-action read.
export default function PlanSummary({ members, me, accounts, transactions, holdings, data, loading, onOpenTab }) {
  const { goals, goalContributions, debts, assumptions } = data;
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const now = useMemo(() => new Date(), []);

  const goalRows = useMemo(
    () =>
      goals
        .filter((g) => scopeMemberId === null || g.is_shared || g.owner_member_id === scopeMemberId)
        .map((g) => {
          const factor = scopeMemberId === null || !g.is_shared ? 1 : 0.5;
          const scopedGoal = { ...g, target_amount: Number(g.target_amount) * factor };
          const contributions = goalContributions
            .filter((c) => c.goal_id === g.id)
            .map((c) => ({ ...c, amount: Number(c.amount) * factor }));
          return { goal: g, progress: goalProgress(scopedGoal, contributions, now) };
        }),
    [goals, goalContributions, scopeMemberId, now]
  );
  const goalsSaved = goalRows.reduce((s, r) => s + r.progress.saved, 0);
  const goalsTarget = goalRows.reduce((s, r) => s + r.progress.target, 0);
  const behindGoals = goalRows.filter((r) => r.progress.status === 'behind');

  const visibleDebts = useMemo(
    () =>
      debts
        .filter((d) => scopeMemberId === null || d.is_shared || d.owner_member_id === scopeMemberId)
        .map((d) => ({ ...d, balance: Number(d.balance) * (scopeMemberId === null || !d.is_shared ? 1 : 0.5) })),
    [debts, scopeMemberId]
  );
  const totalOwed = visibleDebts.reduce((s, d) => s + Number(d.balance), 0);

  const orderedFull = useMemo(() => orderDebts(debts, 'avalanche'), [debts]);
  const extraPayment = assumptions?.debt_extra_payment != null ? Number(assumptions.debt_extra_payment) : null;
  const cardAssumptionSet = assumptions?.debt_assume_no_new_card_spend != null;
  const canProjectDebt = extraPayment !== null && extraPayment > 0 && cardAssumptionSet && debts.length > 0;
  const debtPlan = useMemo(() => (canProjectDebt ? simulatePayoffPlan(orderedFull, extraPayment) : null), [canProjectDebt, orderedFull, extraPayment]);

  const startNetWorth = accounts.length > 0 || holdings.length > 0 ? netWorthSummary(accounts, null, holdings).netWorth : null;
  const monthCount = closedMonths(transactions, now).size;
  const forecast = useMemo(() => forecastInputs(transactions, startNetWorth, now), [transactions, startNetWorth, now]);
  const nominalPct = assumptions?.nominal_return_pct != null ? Number(assumptions.nominal_return_pct) : DEFAULTS.nominal_return_pct;
  const inflationPct = assumptions?.inflation_pct != null ? Number(assumptions.inflation_pct) : DEFAULTS.inflation_pct;
  const swrPct = assumptions?.safe_withdrawal_pct != null ? Number(assumptions.safe_withdrawal_pct) : DEFAULTS.safe_withdrawal_pct;
  const fireTarget = forecast.ready ? fiTarget(forecast.annualSpend, swrPct) : null;
  const fireYear = forecast.ready
    ? crossingYear({
        startYear: now.getFullYear(),
        startNetWorth,
        annualSaving: forecast.monthlySaving * 12,
        rate: (1 + nominalPct / 100) / (1 + inflationPct / 100) - 1,
        mode: 'real',
        inflationPct,
        goal: fireTarget,
      })
    : null;

  const actions = [
    behindGoals.length > 0 && {
      key: 'goals',
      text: `${behindGoals.length} goal${behindGoals.length === 1 ? '' : 's'} behind pace`,
      tab: 'goals',
      cta: 'Open Goals',
    },
    debts.length > 0 && !canProjectDebt && {
      key: 'debt',
      text: 'No committed extra payment set, so debt has no payoff date',
      tab: 'debt',
      cta: 'Set a plan',
    },
    !forecast.ready && {
      key: 'forecast',
      text:
        monthCount < 3
          ? `Independence needs three closed months of spend · has ${monthCount}`
          : 'Independence needs a starting account valuation',
      tab: 'forecast',
      cta: 'Open Forecast',
    },
  ].filter(Boolean);

  const isEmpty = goals.length === 0 && debts.length === 0 && !forecast.ready;

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
      <section className="ov-quality-grid" style={{ marginTop: 22 }}>
        <SummaryCard
          label="Goals"
          figure={goalRows.length > 0 ? formatMoney(goalsSaved) : '—'}
          note={goalRows.length > 0 ? `of ${formatMoney(goalsTarget)} target · ${goalRows.length} goal${goalRows.length === 1 ? '' : 's'}` : 'No goals yet'}
          cta="Goals"
          onClick={() => onOpenTab('goals')}
        />
        <SummaryCard
          label="Debt payoff"
          figure={visibleDebts.length > 0 ? `−${formatMoney(totalOwed)}` : '—'}
          note={
            visibleDebts.length === 0
              ? 'No debts on record'
              : canProjectDebt && debtPlan
                ? `Debt-free in ${monthsToLabel(debtPlan.months)}`
                : canProjectDebt
                  ? "Doesn't clear within 50 years at this rate"
                  : 'No payoff date set'
          }
          cta="Debt payoff"
          onClick={() => onOpenTab('debt')}
        />
        <SummaryCard
          label="Independence"
          figure={forecast.ready ? String(fireYear ?? '60+ yrs out') : '—'}
          note={forecast.ready ? `${formatPct(startNetWorth / fireTarget)} of the way to ${formatMoney(fireTarget)}` : 'Not enough data to project'}
          cta="Forecast"
          onClick={() => onOpenTab('forecast')}
        />
      </section>

      <section style={{ marginTop: 40 }}>
        <div className="ov-section-head">
          <div className="ov-kicker">What needs a decision</div>
          <div className="ov-muted">{actions.length ? `${actions.length} open` : 'All clear'}</div>
        </div>
        {actions.length === 0 ? (
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
                <button type="button" className="om-btn ov-attn-btn" onClick={() => onOpenTab(a.tab)}>
                  {a.cta}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard({ label, figure, note, cta, onClick }) {
  return (
    <div style={{ cursor: 'pointer' }} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="ov-quality-row">
        <span className="ov-kicker" style={{ marginBottom: 0 }}>{label}</span>
        <span className="ov-link">{cta} →</span>
      </div>
      <div className="fig" style={{ fontSize: 22, marginTop: 8 }}>{figure}</div>
      <div className="ov-muted ov-quality-note" style={{ marginTop: 5 }}>{note}</div>
    </div>
  );
}
