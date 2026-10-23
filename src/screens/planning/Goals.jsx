import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney } from '../../lib/money';
import { assumption } from '../../lib/planningDefaults';
import { cashPerMonth, fundInPriority, goalCostAtDate, goalInflationPct, doneMonth, goalStatuses, isDone } from '../../lib/goals';
import { budgetPlan, forecastInputs, spendThatStops } from '../../lib/forecast';
import { lifePlanStop } from '../../lib/lifePlan';
import { startingNetWorth } from '../overviewMath';
import GoalEditor from './GoalEditor';
import { neverLoaded } from '../../lib/loadState';
import { GOALS_INPUTS, projectionInputs } from './planningSources';
import Withheld from './Withheld';

const NONE = [];

// Each goal's one status, as its chip (Planning audit, 1.5).
function chip(row) {
  if (row.kind === 'undated') return { label: 'No date', tone: 'ov-chip-mute' };
  if (row.kind === 'later') {
    if (row.state === 'unchecked') return { label: 'Not checked', tone: 'ov-chip-mute' };
    return row.state === 'short' ? { label: `Short in ${row.year}`, tone: 'ov-chip-warn' } : { label: `Paid in ${row.year}`, tone: 'ov-chip-ok' };
  }
  if (row.state === 'covered') return { label: 'Covered', tone: 'ov-chip-ok' };
  if (row.state === 'due') return { label: 'Due', tone: 'ov-chip-warn' };
  // A plan that covers it by its date settles it (Planning audit, 2.7).
  if (row.plan?.enough) return { label: 'Planned', tone: 'ov-chip-ok' };
  if (row.plan?.enough === false) return { label: 'Plan short', tone: 'ov-chip-warn' };
  return { label: 'Saving', tone: 'ov-chip-warn' };
}

// What the household's planned monthly amount does, after the need.
function planLine(row) {
  const { plan } = row;
  if (!plan) return '';
  if (plan.enough) return ` You plan ${formatMoney(plan.amount)}, which covers it.`;
  if (plan.months == null) return ` You plan ${formatMoney(plan.amount)}, which never covers it.`;
  return ` At the ${formatMoney(plan.amount)} you plan, it is covered by ${plan.byLabel}.`;
}

// The one line under a goal that says why its chip says what it does.
function why(row) {
  // A later or undated goal's plan is said, not measured: the Life plan pays
  // a later goal from everything, and an undated one has nothing to be on
  // time for.
  const planned = row.planned != null ? ` You plan ${formatMoney(row.planned)} a month towards it.` : '';
  if (row.kind === 'undated') return `Not in any plan: set a date to plan for it.${planned}`;
  if (row.kind === 'later') {
    if (row.state === 'unchecked') return `The Life plan can\u2019t check it yet: it needs ages, an account valuation and three months of records or a budget.${planned}`;
    if (row.state === 'short') return `The Life plan runs short by ${formatMoney(row.short)} in ${row.year}, the year it is due.${planned}`;
    return `The Life plan pays it from your savings and investments in ${row.year}.${planned}`;
  }
  const held = row.kind === 'kept' ? 'Kept, not spent, so held in cash' : 'Due within 3 years, so paid from cash';
  if (row.state === 'covered') return `${held}: covered by what is set aside.`;
  if (row.state === 'due') return `${held}: ${formatMoney(row.remaining)} still needed, and its date has arrived.${planLine(row)}`;
  if (row.perMonth) return `${held}: ${formatMoney(row.perMonth)} a month to ${row.byLabel}.${planLine(row)}`;
  return `${held}: ${formatMoney(row.remaining)} still to set aside.${planLine(row)}`;
}

export default function Goals({
  household,
  members = NONE,
  me,
  accounts = NONE,
  holdings = NONE,
  transactions = NONE,
  recurring = NONE,
  budgets = NONE,
  categories = NONE,
  data,
  sources,
  onRetry,
  loading,
}) {
  const { goals, goalContributions, goalAllocations, assumptions, reload } = data;
  const inflationPct = assumption(assumptions, 'inflation_pct');
  // The same expected return the Life plan projects with.
  const returnPct = assumption(assumptions, 'nominal_return_pct');
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const [editing, setEditing] = useState(null);
  const now = useMemo(() => new Date(), []);

  // The Life plan's timeline, which later goals take their state from: the
  // household's saved plan, as Plan and the Life plan tab show it.
  const startNetWorth = useMemo(() => startingNetWorth(accounts, holdings), [accounts, holdings]);
  const plan = useMemo(() => budgetPlan(budgets, categories, now), [budgets, categories, now]);
  const inputs = useMemo(() => forecastInputs(transactions, startNetWorth, now, plan, recurring), [transactions, startNetWorth, now, plan, recurring]);
  const timelineMissing = neverLoaded(sources, projectionInputs(inputs)).length > 0;
  const timeline = useMemo(() => {
    if (timelineMissing) return null;
    const stopping = spendThatStops({ inputs, transactions, budgets, categories, now });
    const stop = lifePlanStop({
      members,
      memberLife: data.memberLife ?? [],
      assumptions,
      inputs,
      startNetWorth,
      goals: goals ?? [],
      incomes: data.independenceIncome ?? [],
      household,
      stopping,
      startYear: now.getFullYear(),
      now,
    });
    return stop?.rows ?? null;
  }, [timelineMissing, inputs, transactions, budgets, categories, now, members, data.memberLife, assumptions, startNetWorth, goals, data.independenceIncome, household]);

  const rows = useMemo(
    () =>
      goalStatuses({
        goals,
        contributions: goalContributions,
        allocations: goalAllocations ?? [],
        accounts: accounts ?? [],
        holdings: holdings ?? [],
        scopeMemberId,
        now,
        inflationPct,
        timeline,
      }),
    [goals, goalContributions, goalAllocations, accounts, holdings, scopeMemberId, now, inflationPct, timeline]
  );
  const near = rows.filter((r) => r.kind === 'near');
  const kept = rows.filter((r) => r.kind === 'kept');
  const later = rows.filter((r) => r.kind === 'later');
  const undated = rows.filter((r) => r.kind === 'undated');
  // Done goals in the scope, newest first: out of every plan, listed so they
  // can be opened and reopened (Planning audit, 2.7).
  const done = useMemo(
    () =>
      (goals ?? [])
        .filter((g) => isDone(g) && (scopeMemberId === null || g.is_shared || g.owner_member_id === scopeMemberId))
        .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at))),
    [goals, scopeMemberId]
  );
  // The next 3 years' own cash a month; kept money says its own in its row.
  const schedule = cashPerMonth(near);
  const nearCash = near.reduce((s, r) => s + r.cash, 0);
  const nearCost = near.reduce((s, r) => s + r.cost, 0);

  // Later goals only, if investments paid for them: a goal due soon can't
  // wait for a market, so the priority table no longer offers it one. A
  // household question, worked out for Both only.
  const funding = useMemo(() => {
    if (scopeMemberId !== null || later.length === 0) return null;
    const netWorth = startNetWorth ?? 0;
    const earmarked = rows.reduce((s, r) => s + r.progress.saved, 0);
    return fundInPriority({ rows: later, freeMoney: netWorth - earmarked, returnPct, now });
  }, [scopeMemberId, later, rows, startNetWorth, returnPct, now]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const missing = neverLoaded(sources, GOALS_INPUTS);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={onRetry}>
        Your goals aren&rsquo;t shown, rather than shown as none or with what is set aside for them left out.
      </Withheld>
    );
  }

  const dated = rows.length - undated.length;
  const goalRow = (row, figure, of) => {
    const c = chip(row);
    const { goal } = row;
    const bar = row.kind === 'near' || row.kind === 'kept' ? (row.cost > 0 ? Math.min(1, row.cash / row.cost) : 1) : null;
    return (
      <button key={goal.id} type="button" className="mn-row" onClick={() => setEditing(goal)} style={{ alignItems: 'flex-start' }}>
        <div className="mn-row-main">
          <div>{goal.name}</div>
          {goal.note && <div className="ov-muted" style={{ marginTop: 4 }}>{goal.note}</div>}
          {goal.cost_today && goal.target_date && (
            <div className="ov-muted" style={{ marginTop: 4 }}>
              {formatMoney(Number(goal.target_amount))} today, rising {goalInflationPct(goal, inflationPct)}% a year · about {formatMoney(goalCostAtDate(goal, now, inflationPct))} by{' '}
              {String(goal.target_date).slice(0, 4)}
            </div>
          )}
          {bar !== null && (
            <div className="bud-bar" style={{ marginTop: 10, maxWidth: 260 }}>
              <span className="bud-bar-spent" style={{ width: `${bar * 100}%` }} />
            </div>
          )}
          <div className="gl-need">{why(row)}</div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          <div className="fig mn-row-amt">{formatMoney(figure)}</div>
          {of && <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{of}</div>}
          <div style={{ marginTop: 8 }}>
            <span className={c.tone}>{c.label}</span>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div>
      <div className="mn-filters">
        <span className="ov-muted" style={{ marginRight: 'auto' }}>
          {[
            rows.length > 0 && `${dated} dated goal${dated === 1 ? '' : 's'}`,
            undated.length > 0 && `${undated.length} with no date`,
            done.length > 0 && `${done.length} done`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Goal
        </button>
      </div>

      {rows.length === 0 && done.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No goals</div>
          <div className="ov-empty-body">Add a goal to start tracking progress toward it.</div>
        </div>
      ) : (
        <>
          {near.length > 0 && (
            <section className="gl-section" aria-label="Next 3 years">
              <div className="ov-kicker">Next 3 years · from cash</div>
              <div className="bud-bar bud-bar-lg" style={{ marginTop: 12 }}>
                <span className="bud-bar-spent" style={{ width: `${nearCost > 0 ? Math.min(100, (nearCash / nearCost) * 100) : 0}%` }} />
              </div>
              <div className="gl-summary-row">
                <span>
                  <b className="fig">{formatMoney(nearCash)}</b> of {formatMoney(nearCost)} set aside in cash
                </span>
                {schedule ? (
                  <span>
                    Needs <b className="fig">{formatMoney(schedule.now)}</b> a month in cash
                    {schedule.after > 0 ? (
                      <>
                        {' '}
                        now, falling to <b className="fig">{formatMoney(schedule.after)}</b> after {schedule.until}
                      </>
                    ) : (
                      ` until ${schedule.until}`
                    )}
                    {schedule.planned != null && (
                      <>
                        {' · '}you plan <b className="fig">{formatMoney(schedule.planned)}</b>
                      </>
                    )}
                    {plan?.monthlySaving > 0 && ` · your budget saves ${formatMoney(plan.monthlySaving)} a month`}
                  </span>
                ) : (
                  <span>Nothing more to set aside each month</span>
                )}
              </div>
              <div className="mn-list" style={{ marginTop: 14 }}>
                {near.map((r) => goalRow(r, r.cash, `of ${formatMoney(r.cost)}`))}
              </div>
            </section>
          )}

          {kept.length > 0 && (
            <section className="gl-section" aria-label="Kept, not spent">
              <div className="ov-kicker">Kept, not spent · in cash</div>
              <div className="mn-list" style={{ marginTop: 14 }}>
                {kept.map((r) => goalRow(r, r.cash, `of ${formatMoney(r.cost)}`))}
              </div>
            </section>
          )}

          {later.length > 0 && (
            <section className="gl-section" aria-label="Later">
              <div className="ov-kicker">Later · paid by the Life plan</div>
              <div className="mn-list" style={{ marginTop: 14 }}>
                {later.map((r) => goalRow(r, r.cost, `on its date${r.progress.saved > 0 ? ` · ${formatMoney(r.progress.saved)} set aside` : ''}`))}
              </div>
              {funding && funding.goals.length > 0 && <PriorityFunding funding={funding} returnPct={returnPct} />}
            </section>
          )}

          {undated.length > 0 && (
            <section className="gl-section" aria-label="No date">
              <div className="ov-kicker">No date · not in any plan</div>
              <div className="mn-list" style={{ marginTop: 14 }}>
                {undated.map((r) => goalRow(r, r.cost, null))}
              </div>
            </section>
          )}

          {rows.length === 0 && <div className="ov-muted">Every goal is done.</div>}

          {done.length > 0 && (
            <section className="gl-section" aria-label="Done">
              <div className="ov-kicker">Done · out of every plan</div>
              <div className="mn-list" style={{ marginTop: 14 }}>
                {done.map((g) => (
                  <button key={g.id} type="button" className="mn-row" onClick={() => setEditing(g)}>
                    <div className="mn-row-main">
                      <div>{g.name}</div>
                      <div className="ov-muted" style={{ marginTop: 4 }}>
                        Done {doneMonth(g)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <div className="fig mn-row-amt">{formatMoney(Number(g.target_amount))}</div>
                      <div style={{ marginTop: 8 }}>
                        <span className="ov-chip-mute">Done</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="ov-muted" style={{ marginTop: 18, fontSize: 11.5, lineHeight: 1.65, maxWidth: '80ch' }}>
            A goal due within 3 years counts only the cash set aside for it: what is logged to it, and the current, savings and cash accounts
            linked to it, with no growth. A later goal is paid by the Life plan from everything you own, in its year, so the two tabs agree
            about it. Money kept rather than spent, like an emergency fund, is held in cash.
          </div>
        </>
      )}

      {editing && (
        <GoalEditor
          goal={editing === 'new' ? null : editing.goal ?? editing}
          contributions={editing === 'new' ? [] : goalContributions.filter((c) => c.goal_id === (editing.goal ?? editing).id)}
          allocations={editing === 'new' ? [] : (goalAllocations ?? []).filter((a) => a.goal_id === (editing.goal ?? editing).id)}
          accounts={accounts ?? []}
          holdings={holdings ?? []}
          householdId={household?.id}
          members={members}
          inflationPct={inflationPct}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
          onChanged={reload}
        />
      )}
    </div>
  );
}

// The financial plan's view of later goals: what each needs set aside today to
// be paid on its date, covered in priority order by what is already earmarked
// and then by the household's other money, and the top-up still missing. A
// what-if, closed until opened: the Life plan is what pays them (Planning
// audit, 1.5).
function PriorityFunding({ funding, returnPct }) {
  return (
    <details className="gl-priority">
      <summary className="ov-kicker">If your investments paid for these</summary>
      <div className="gl-summary-row" style={{ marginTop: 10 }}>
        <span>
          Needed today for every later goal <b className="fig">{formatMoney(funding.neededToday)}</b>
        </span>
        <span>
          Covered <b className="fig">{formatMoney(funding.covered)}</b>
          {funding.topUp > 0 ? (
            <>
              {' · '}short <b className="fig ov-neg">{formatMoney(funding.topUp)}</b>
            </>
          ) : (
            ' · every goal covered'
          )}
          {funding.freeLeft > 0 && (
            <>
              {' · '}left over <b className="fig">{formatMoney(funding.freeLeft)}</b>
            </>
          )}
        </span>
      </div>
      <div className="ch-table" style={{ marginTop: 14 }}>
        <div className="ch-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Priority</th>
                <th scope="col" style={{ textAlign: 'left' }}>
                  Goal
                </th>
                <th scope="col">On its date</th>
                <th scope="col">Needed today</th>
                <th scope="col">Covered</th>
                <th scope="col">Top-up today</th>
                <th scope="col">Or a month</th>
              </tr>
            </thead>
            <tbody>
              {funding.goals.map((g) => (
                <tr key={g.goal.id}>
                  <td className="fig">{g.goal.priority ?? '—'}</td>
                  <td style={{ textAlign: 'left' }}>
                    {g.goal.name}
                    <span className="ov-muted"> · {String(g.goal.target_date).slice(0, 4)}</span>
                  </td>
                  <td className="fig">{formatMoney(g.costAtDate)}</td>
                  <td className="fig">{formatMoney(g.neededToday)}</td>
                  <td className="fig">{Math.round(g.pct * 100)}%</td>
                  <td className={`fig ${g.topUp > 0 ? 'ov-neg' : ''}`}>{g.topUp > 0 ? formatMoney(g.topUp) : '—'}</td>
                  <td className="fig">{g.topUp > 0 && g.monthsLeft > 0 ? formatMoney(g.monthly) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="ov-muted" style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.65, maxWidth: '80ch' }}>
        Needed today is what would grow to each goal&rsquo;s cost by its date at {returnPct.toFixed(1)}% a year, the expected
        return. Money already set aside for a goal counts first; the rest of your net worth then covers goals in priority order, unnumbered
        goals last and earliest first. Retirement is on the Life plan, which pays these goals out of the same money.
      </div>
    </details>
  );
}
