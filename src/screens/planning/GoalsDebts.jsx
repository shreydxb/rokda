import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNow } from '../../lib/useNow';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { assumption } from '../../lib/planningDefaults';
import { doneMonth, goalStatuses, isDone } from '../../lib/goals';
import { goalGroups } from '../../lib/goalsView';
import { cashReserve } from '../../lib/monthlyCheck';
import { debtOrder, debtsWithAccounts, extraPaymentEffect, minimumOnlyPayoff, minimumOnlyText, orderDebts, payoffMonthLabel } from '../../lib/debt';
import { andList } from '../../lib/words';
import { planningModel } from '../../lib/planningModel';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { Avatar, Banner, Card, Chip, EmptyState, Fold, InfoButton, KpiStrip, ProgressBar, Segmented, WarningRow } from '../../design-system/kit';
import { Tools } from '../PageTools';
import { DEBT_INPUTS, DEBT_PLAN_INPUTS, GOALS_INPUTS, projectionInputs } from './planningSources';
import Withheld from './Withheld';
import './GoalsDebts.css';

// Planning -> Goals & debts (the revamp, phase 6b; design/prototype
// screens-planning.js goalsHalf and debtsHalf): a table card a group of
// goals, Done folded at the foot, then the debts with their order, three
// figures, a table and Extra a month typed in place. A goal or a debt opens
// through its address, over whichever tab is open (GoalDrawer, DebtDrawer).
// Planning is in dirhams whatever the display currency (the AED note).

const NONE = [];
const fmt = (v) => formatMoney(v);

// The goal or debt to open, in the address. Opened from the page, it is a
// step forward, so closing goes back (GoalDrawer).
function useOpener() {
  const [, setParams] = useSearchParams();
  return (key, id) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('goal');
        p.delete('debt');
        p.delete('view');
        p.set(key, id);
        return p;
      },
      { state: { drawer: true } },
    );
}

// Whose a goal or a debt is, as the prototype's avatar.
function ownerAvatar(row, members) {
  if (row.is_shared || !row.owner_member_id) return <Avatar name="Shared" initial="S" />;
  const at = members.findIndex((m) => m.id === row.owner_member_id);
  const m = members[at];
  return m ? <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={at === 0 ? 'a' : 'b'} /> : null;
}

export default function GoalsDebts({
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
  const open = useOpener();
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  if (loading) return <div className="ov-skel" aria-busy="true" />;
  return (
    <div className="gd">
      <Tools>
        <button type="button" className="ds-btn" onClick={() => open('debt', 'new')}>
          + Debt
        </button>
        <button type="button" className="ds-btn ds-btn-primary" onClick={() => open('goal', 'new')}>
          + Goal
        </button>
      </Tools>
      <h2 className="pl-band-h gd-first">Goals</h2>
      <GoalsHalf
        household={household}
        members={members}
        accounts={accounts}
        holdings={holdings}
        transactions={transactions}
        recurring={recurring}
        budgets={budgets}
        categories={categories}
        data={data}
        sources={sources}
        onRetry={onRetry}
        scopeMemberId={scopeMemberId}
        onOpen={(id) => open('goal', id)}
      />
      <DebtsHalf household={household} members={members} accounts={accounts} data={data} sources={sources} onRetry={onRetry} scopeMemberId={scopeMemberId} onOpen={(id) => open('debt', id)} />
    </div>
  );
}

function GoalsHalf({ household, members, accounts, holdings, transactions, recurring, budgets, categories, data, sources, onRetry, scopeMemberId, onOpen }) {
  const { goals = NONE, goalContributions = NONE, goalAllocations = NONE, assumptions, memberLife, independenceIncome, afterWorkCosts, debts: debtRows } = data;
  const now = useNow(data?.loadedAt);
  // The recorded balance changes a linked goal's pace is read from; null when
  // they never loaded, so no pace is given rather than one from nothing.
  const balanceEvents = neverLoaded(sources, ['balanceEvents']).length > 0 ? null : (data.balanceEvents ?? NONE);
  const inflationPct = assumption(assumptions, 'inflation_pct');
  // The plan's timeline, which later goals take their state from.
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
        members,
        household,
        now,
      }),
    [accounts, holdings, transactions, recurring, budgets, categories, assumptions, goals, memberLife, independenceIncome, afterWorkCosts, debtRows, members, household, now]
  );
  const timelineMissing = neverLoaded(sources, projectionInputs(model.inputs)).length > 0;
  const timeline = useMemo(() => (timelineMissing ? null : (model.stop()?.rows ?? null)), [timelineMissing, model]);
  const rows = useMemo(
    () => goalStatuses({ goals, contributions: goalContributions, allocations: goalAllocations, accounts, holdings, scopeMemberId, now, inflationPct, timeline, balanceEvents }),
    [goals, goalContributions, goalAllocations, accounts, holdings, scopeMemberId, now, inflationPct, timeline, balanceEvents]
  );
  const done = useMemo(
    () => goals.filter((g) => isDone(g) && (scopeMemberId === null || g.is_shared || g.owner_member_id === scopeMemberId)).sort((a, b) => String(b.done_at).localeCompare(String(a.done_at))),
    [goals, scopeMemberId]
  );
  const groups = goalGroups(rows);
  // The cash reserve against what the kept goals hold (today's Monthly
  // check, which lost its tab): the household's, so in Both only.
  const reserve =
    scopeMemberId === null
      ? cashReserve({ accounts, monthlySpend: model.inputs.ready ? model.inputs.avgMonthlySpend : null, keptCost: rows.filter((r) => r.kind === 'kept').reduce((s, r) => s + r.cost, 0) })
      : null;

  const missing = neverLoaded(sources, GOALS_INPUTS);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={onRetry}>
        Your goals aren&rsquo;t shown, rather than shown as none or with what is set aside for them left out.
      </Withheld>
    );
  }
  if (rows.length === 0 && done.length === 0) {
    return (
      <>
        <section className="ds-card">
          <EmptyState title="No goals yet" body="Add one to see what it needs each month." action={{ label: 'Add a goal', onClick: () => onOpen('new') }} />
        </section>
        {reserve && <ReserveCard reserve={reserve} />}
      </>
    );
  }
  const kept = groups.find((g) => g.kind === 'kept');
  return (
    <div className="gd-goals">
      {rows.length === 0 && <p className="ds-muted gd-alldone">Every goal is done.</p>}
      {groups.map((g) => (
        <Card
          key={g.kind}
          title={g.title}
          info={<InfoButton about={g.title}>{g.info}</InfoButton>}
          right={<span>{`${fmt(g.saved)} of ${fmt(g.target)}${g.needs > 0 ? ` · needs ${fmt(g.needs)} a month` : ''}`}</span>}
          flush
        >
          <GoalTable rows={g.rows} members={members} onOpen={onOpen} />
          {g.kind === 'kept' && reserve && <ReserveLine reserve={reserve} />}
        </Card>
      ))}
      {!kept && reserve && <ReserveCard reserve={reserve} />}
      {done.length > 0 && (
        <section className="ds-card gd-done">
          <Fold label="Done" count={done.length}>
            <div className="ds-table-wrap">
              <table className="ds-table gd-table">
                <tbody>
                  {done.map((g) => (
                    <tr key={g.id} className="gd-row" onClick={(e) => !e.target.closest('button') && onOpen(g.id)}>
                      <td>
                        <div className="gd-goal">
                          {ownerAvatar(g, members)}
                          <button type="button" className="gd-name" onClick={() => onOpen(g.id)}>
                            {g.name}
                          </button>
                        </div>
                      </td>
                      <td className="gd-num">{fmt(Number(g.target_amount))}</td>
                      <td className="ds-muted">{`Done ${doneMonth(g)}`}</td>
                      <td className="gd-status">
                        <Chip>Done</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Fold>
        </section>
      )}
    </div>
  );
}

function GoalTable({ rows, members, onOpen }) {
  return (
    <div className="ds-table-wrap">
      <table className="ds-table gd-table gd-goal-table">
        <thead>
          <tr>
            <th scope="col">Goal</th>
            <th scope="col" className="gd-num">
              Target
            </th>
            <th scope="col" className="gd-num">
              Saved
            </th>
            <th scope="col">Progress</th>
            <th scope="col" className="gd-num">
              Needs a month
            </th>
            <th scope="col" className="gd-num">
              <span className="gd-th">
                Pace
                <InfoButton about="Pace">What has gone in each month, over about three months.</InfoButton>
              </span>
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="gd-row" onClick={(e) => !e.target.closest('button') && onOpen(r.id)}>
              <td>
                <div className="gd-goal">
                  {ownerAvatar(r.goal, members)}
                  <div className="gd-goal-text">
                    <button type="button" className="gd-name" onClick={() => onOpen(r.id)}>
                      {r.goal.name}
                    </button>
                    {r.goal.note && <div className="gd-sub">{r.goal.note}</div>}
                  </div>
                </div>
              </td>
              <td className="gd-num">
                <div>{fmt(r.target)}</div>
                <div className="gd-sub">{r.by ? `by ${r.by}` : 'no date'}</div>
              </td>
              <td className="gd-num">{fmt(r.saved)}</td>
              <td>
                <div className="gd-progress">
                  <ProgressBar label={`${r.goal.name}, saved of its target`} value={r.saved} max={r.target} tone={r.chip.tone === 'pos' ? 'pos' : 'accent'} format={fmt} />
                  <span className="gd-pct">{`${Math.round(r.share * 100)}%`}</span>
                </div>
              </td>
              <td className="gd-num">{r.needs != null ? fmt(r.needs) : ''}</td>
              <td className={`gd-num gd-pace${r.paceLow ? ' gd-low' : ''}`}>{r.pace != null ? fmt(r.pace) : ''}</td>
              <td className="gd-status">
                <Chip tone={r.chip.tone} title={r.why}>
                  {r.chip.label}
                </Chip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const monthsText = (m) => `${m.toFixed(1)} month${m.toFixed(1) === '1.0' ? '' : 's'}`;

// The cash reserve (lib/monthlyCheck.js): what the current, savings and cash
// accounts hold, in months of spending, against what the kept goals hold.
function ReserveLine({ reserve }) {
  return (
    <div className="gd-reserve">
      <span className="ds-muted">Cash reserve</span>
      <b>{fmt(reserve.liquid)}</b>
      <span>{` in current, savings and cash accounts${reserve.months !== null ? ` · about ${monthsText(reserve.months)} of spending` : ''}`}</span>
      {reserve.target !== null && (reserve.liquid >= reserve.target ? <Chip tone="pos">Covers kept goals</Chip> : <Chip tone="warn">Short of kept goals</Chip>)}
      {reserve.unvalued > 0 && <span className="ds-muted">{` · ${reserve.unvalued === 1 ? 'one account has' : `${reserve.unvalued} accounts have`} no AED value`}</span>}
    </div>
  );
}

function ReserveCard({ reserve }) {
  return (
    <Card title="Cash reserve" flush>
      <ReserveLine reserve={reserve} />
    </Card>
  );
}

// A debt's own end date at its minimum, for its row.
function clearsText(row, now) {
  if (!row) return '—';
  if (row.months === null) return 'Never';
  if (row.months === Infinity) return '50+ years';
  return payoffMonthLabel(row.months, now);
}

const ORDERS = [
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'snowball', label: 'Snowball' },
];

function DebtsHalf({ household, members, accounts, data, sources, onRetry, scopeMemberId, onOpen }) {
  const { assumptions, reload } = data;
  const now = useNow(data?.loadedAt);
  const debts = useMemo(() => debtsWithAccounts(data.debts ?? NONE, accounts), [data.debts, accounts]);
  // The order is the household's, saved for both partners. A choice shows at
  // once and stands until the saved one catches up.
  const [chosenOrder, setChosenOrder] = useState(null);
  const [orderError, setOrderError] = useState('');
  const strategy = chosenOrder ?? debtOrder(assumptions);
  // A shared debt counts half toward each individual scope, as every joint
  // figure does. The extra payment is the household's, one number.
  const visibleDebts = useMemo(
    () =>
      debts
        .filter((d) => scopeMemberId === null || d.is_shared || d.owner_member_id === scopeMemberId)
        .map((d) => {
          const factor = scopeMemberId === null || !d.is_shared ? 1 : 0.5;
          return { ...d, balance: Number(d.balance) * factor, minimum_payment: Number(d.minimum_payment) * factor, original_amount: d.original_amount != null ? Number(d.original_amount) * factor : null };
        }),
    [debts, scopeMemberId]
  );
  const ordered = useMemo(() => orderDebts(visibleDebts, strategy), [visibleDebts, strategy]);
  const atMinimums = useMemo(() => minimumOnlyPayoff(visibleDebts), [visibleDebts]);
  const byDebt = useMemo(() => new Map(atMinimums.byDebt.map((r) => [r.debt.id, r])), [atMinimums]);
  const householdView = scopeMemberId === null;

  // Extra a month, typed in place as a what-if, saved with Make this the
  // plan (decision 4 of the phase 6 design). Null follows the saved figure.
  const saved = assumptions?.debt_extra_payment != null ? Number(assumptions.debt_extra_payment) : null;
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const typed = draft ?? (saved != null ? String(saved) : '');
  const blankTyped = typed.trim() === '';
  const valid = blankTyped || (Number.isFinite(Number(typed)) && Number(typed) >= 0);
  const amount = valid && !blankTyped ? Number(typed) : 0;
  const changed = draft !== null && valid && (blankTyped ? null : Number(typed)) !== saved;
  const effect = useMemo(() => extraPaymentEffect(ordered, householdView ? amount : 0), [ordered, householdView, amount]);

  const notLoaded = neverLoaded(sources, DEBT_INPUTS);
  if (notLoaded.length > 0) {
    return (
      <>
        <h2 className="pl-band-h">Debts</h2>
        <Withheld missing={notLoaded} onRetry={onRetry}>
          Your debts aren&rsquo;t shown, rather than shown as none or at the wrong balance.
        </Withheld>
      </>
    );
  }
  if (visibleDebts.length === 0) return null;
  // The saved extra payment and order: without them the what-if isn't
  // worked out, and there is nothing to save over what is there.
  const planNotLoaded = neverLoaded(sources, DEBT_PLAN_INPUTS);
  const owing = visibleDebts.filter((d) => Number(d.balance) > 0);
  const showOrder = planNotLoaded.length === 0 && owing.length > 1;
  const totalOwed = visibleDebts.reduce((s, d) => s + Number(d.balance), 0);
  // A rate or minimum of 0 is real for some loans, but it is also what an
  // older record left blank was saved as, and every date rests on them.
  const toCheck = owing.filter((d) => Number(d.apr_pct) === 0 || Number(d.minimum_payment) === 0);

  async function chooseOrder(id) {
    if (id === strategy) return;
    setChosenOrder(id);
    setOrderError('');
    const { error } = await supabase.from('planning_assumptions').upsert({ household_id: household?.id, debt_order: id }, { onConflict: 'household_id' });
    if (error) {
      setChosenOrder(null);
      setOrderError(`The order wasn't saved: ${error.message}`);
      return;
    }
    await reload();
    setChosenOrder(null);
  }

  async function makeThePlan() {
    setSaving(true);
    setSaveError('');
    const { error } = await supabase.from('planning_assumptions').upsert({ household_id: household?.id, debt_extra_payment: blankTyped ? null : amount }, { onConflict: 'household_id' });
    setSaving(false);
    if (error) {
      setSaveError(`The extra payment wasn't saved: ${error.message}`);
      return;
    }
    // The typed figure stays until the saved one is read again.
    await reload();
    setDraft(null);
  }

  const minimumsWhen = effect.minimums.months !== null ? payoffMonthLabel(effect.minimums.months, now) : 'no date';
  const clears =
    atMinimums.owed === 0
      ? { value: 'Nothing owed', sub: null }
      : effect.months !== null
        ? { value: payoffMonthLabel(effect.months, now), sub: effect.extra > 0 ? `with ${fmt(effect.extra)} extra a month` : 'at the minimum payments' }
        : { value: '—', sub: effect.extra > 0 ? `Doesn't clear within 50 years with ${fmt(effect.extra)} extra a month` : minimumOnlyText(atMinimums, now) };

  return (
    <>
      <h2 className="pl-band-h">Debts</h2>
      <section className="ds-card gd-debts" aria-label="Debts">
        <div className="ds-card-head">
          <div className="ds-card-title">
            <h3>{`${visibleDebts.length} debt${visibleDebts.length === 1 ? '' : 's'}`}</h3>
          </div>
          {showOrder && (
            <div className="ds-card-right">
              <Segmented label="Payoff order" options={ORDERS} value={strategy} onChange={chooseOrder} />
              <InfoButton about="Payoff order">Avalanche pays the highest rate first. Snowball pays the smallest balance first, clearing a debt soonest at the cost of a little more interest.</InfoButton>
            </div>
          )}
        </div>
        {orderError && (
          <div className="gd-warns">
            <WarningRow tone="neg">
              <span role="alert">{orderError}</span>
            </WarningRow>
          </div>
        )}
        <KpiStrip
          items={[
            { label: 'Owed', value: fmt(totalOwed), hero: true },
            { label: 'Clears', value: clears.value, sub: clears.sub },
            { label: 'Interest still to pay', value: effect.interest !== null && atMinimums.owed > 0 ? fmt(Math.round(effect.interest)) : '—' },
          ]}
        />
        {(toCheck.length > 0 || planNotLoaded.length > 0) && (
          <div className="gd-warns">
            {toCheck.length > 0 && (
              <WarningRow>
                {`Check the rate and minimum on ${andList(toCheck.map((d) => d.name))}: a 0 is real for some loans, but it is also what a blank was once saved as, and the dates rest on ${toCheck.length === 1 ? 'it' : 'them'}.`}
              </WarningRow>
            )}
            {planNotLoaded.length > 0 && (
              <Banner tone="warn" onRetry={onRetry}>
                {`${couldntLoad(planNotLoaded)} The extra payment and the order you chose aren’t shown.`}
              </Banner>
            )}
          </div>
        )}
        <div className="ds-table-wrap gd-debt-table">
          <table className="ds-table gd-table gd-debt-cols">
            <thead>
              <tr>
                <th scope="col">Debt</th>
                <th scope="col" className="gd-num">
                  Owed
                </th>
                <th scope="col" className="gd-num">
                  Rate
                </th>
                <th scope="col" className="gd-num">
                  Minimum
                </th>
                <th scope="col">Clears</th>
                <th scope="col">Paid down</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((d) => {
                const paid = d.original_amount ? Math.max(0, 1 - Number(d.balance) / Number(d.original_amount)) : null;
                return (
                  <tr key={d.id} className="gd-row" onClick={(e) => !e.target.closest('button') && onOpen(d.id)}>
                    <td>
                      <div className="gd-goal">
                        {ownerAvatar(d, members)}
                        <div className="gd-goal-text">
                          <button type="button" className="gd-name" onClick={() => onOpen(d.id)}>
                            {d.name}
                          </button>
                          {d.note && <div className="gd-sub">{d.note}</div>}
                        </div>
                        {!d.inNetWorth && (
                          <>
                            <Chip tone="warn" title={d.account ? 'Its account has no value, so net worth leaves it out.' : 'No account carries it, so net worth leaves it out.'}>
                              Not in net worth
                            </Chip>
                            <button type="button" className="ds-link ds-link-accent" onClick={() => onOpen(d.id)}>
                              Link account
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className={`gd-num${Number(d.balance) > 0 ? ' ds-neg' : ''}`}>{d.inCredit ? 'In credit' : Number(d.balance) > 0 ? `−${fmt(d.balance)}` : '0'}</td>
                    <td className="gd-num">{`${Number(d.apr_pct).toFixed(1)}%`}</td>
                    <td className="gd-num">{fmt(d.minimum_payment)}</td>
                    <td>{clearsText(byDebt.get(d.id), now)}</td>
                    <td>
                      {paid !== null && (
                        <div className="gd-progress">
                          <ProgressBar label={`${d.name}, paid down`} value={paid * 100} max={100} format={(v) => `${Math.round(v)}%`} />
                          <span className="gd-pct">{`${Math.round(paid * 100)}%`}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {planNotLoaded.length === 0 && (
          <div className="gd-extra">
            <label className="gd-extra-label" htmlFor="gd-extra">
              Extra a month
            </label>
            <InfoButton about="Extra a month">
              A what-if on top of every minimum, to the first debt in the order above, then the next once it clears. A rule of thumb: fill the cash reserve before
              paying extra on a loan at a low rate; money paid into a loan can&rsquo;t be drawn back when it&rsquo;s needed. A card at a high rate is the exception.
            </InfoButton>
            <input
              id="gd-extra"
              className="ds-select ds-select-sm gd-extra-input"
              type="number"
              min="0"
              step="50"
              inputMode="numeric"
              placeholder="0"
              value={typed}
              disabled={!householdView}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={!valid}
            />
            {!householdView ? (
              <span className="ds-muted">The extra payment is the household&rsquo;s, one figure for both: switch to Both to try one.</span>
            ) : !valid ? (
              <span className="ds-warn-ink">An extra payment of 0 or more.</span>
            ) : amount > 0 && effect.months !== null ? (
              <span>
                <span className="ds-muted">→ </span>
                {`Clears ${payoffMonthLabel(effect.months, now)}`}
                {effect.saves !== null && (
                  <>
                    {' · saves '}
                    <b className="ds-pos">{fmt(Math.round(effect.saves))}</b>
                    {' in interest'}
                  </>
                )}
                <span className="ds-muted">{`, against ${minimumsWhen} at the minimums`}</span>
              </span>
            ) : amount > 0 ? (
              <span className="ds-warn-ink">{`Doesn't clear within 50 years with ${fmt(amount)} extra a month.`}</span>
            ) : (
              <span className="ds-muted">Try an amount to see how much sooner the debts clear.</span>
            )}
            {householdView && changed && (
              <span className="gd-unsaved">
                <Chip tone="warn">Not saved</Chip>
                <button type="button" className="ds-link" onClick={() => setDraft(null)}>
                  Reset
                </button>
                <button type="button" className="ds-btn ds-btn-sm" onClick={makeThePlan} disabled={saving}>
                  {saving ? 'Saving…' : 'Make this the plan'}
                </button>
              </span>
            )}
            {saveError && (
              <span className="ds-warn-ink" role="alert">
                {saveError}
              </span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
