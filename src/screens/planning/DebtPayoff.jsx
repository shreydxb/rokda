import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney } from '../../lib/money';
import { supabase } from '../../lib/supabaseClient';
import { debtOrder, debtsWithAccounts, interestText, minimumOnlyPayoff, minimumOnlyText, orderDebts, payoffMonthLabel, simulatePayoffPlan } from '../../lib/debt';
import { andList } from '../../lib/words';
import DebtEditor from './DebtEditor';
import DebtPlanEditor from './DebtPlanEditor';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { DEBT_INPUTS, DEBT_PLAN_INPUTS } from './planningSources';
import Withheld from './Withheld';

// A custom order waits until a debt's rank can be set (Planning audit, 1.4).
const STRATEGIES = [
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'snowball', label: 'Snowball' },
];

const STRATEGY_NOTE = {
  avalanche: 'Highest rate first. Every spare dirham goes to the debt costing the most in interest until it is clear.',
  snowball: 'Smallest balance first. Clears a debt soonest, at the cost of slightly more interest than avalanche overall.',
};

// A debt's own end date at its minimum, for its row.
function clearsText(row, now) {
  if (!row) return '—';
  if (row.months === null) return 'Never';
  if (row.months === Infinity) return '50+ years';
  return payoffMonthLabel(row.months, now);
}

export default function DebtPayoff({ household, members, me, accounts = [], data, sources, onRetry, loading, onReload }) {
  const { assumptions, reload } = data;
  const now = useMemo(() => new Date(), []);
  // Each debt at its linked account's balance: the one figure net worth uses too.
  const debts = useMemo(() => debtsWithAccounts(data.debts, accounts), [data.debts, accounts]);
  const unlinked = debts.filter((d) => !d.inNetWorth);
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const [editing, setEditing] = useState(null);
  const [editingPlan, setEditingPlan] = useState(false);
  // The order is the household's, saved for both partners and for Plan; it
  // was forgotten on every reload (Planning audit, 1.4). A choice shows at
  // once and stands until the saved one catches up.
  const [chosenOrder, setChosenOrder] = useState(null);
  const [orderError, setOrderError] = useState('');
  const strategy = chosenOrder ?? debtOrder(assumptions);

  // A shared debt counts half toward each individual scope, same as every
  // other joint figure in the app. An extra payment stays household-wide,
  // though: it is one number for the whole household, not something that
  // splits per person.
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
  const totalOwed = visibleDebts.reduce((s, d) => s + Number(d.balance), 0);
  const householdView = scopeMemberId === null;

  // The date the debts are on: each at its own minimum, which every loan
  // has. This page used to show none until an extra payment and a card-usage
  // answer were entered (Planning audit, 1.4). Halving a shared debt's
  // balance and minimum leaves its date where it was.
  const atMinimums = useMemo(() => minimumOnlyPayoff(visibleDebts), [visibleDebts]);
  const byDebt = useMemo(() => new Map(atMinimums.byDebt.map((r) => [r.debt.id, r])), [atMinimums]);
  const interest = interestText(atMinimums);

  // An extra payment is a what-if on the whole household's debts, in the
  // chosen order, rolled on to the next debt once one clears.
  const orderedFull = useMemo(() => orderDebts(debts, strategy), [debts, strategy]);
  const extraPayment = assumptions?.debt_extra_payment != null ? Number(assumptions.debt_extra_payment) : null;
  const tryingExtra = extraPayment !== null && extraPayment > 0 && debts.length > 0;
  const withExtra = useMemo(() => (tryingExtra ? simulatePayoffPlan(orderedFull, extraPayment) : null), [tryingExtra, orderedFull, extraPayment]);

  // A rate or minimum of 0 is real for some loans, but it is also what an
  // older record left blank was saved as, and every date rests on them.
  const toCheck = visibleDebts.filter((d) => Number(d.balance) > 0 && (Number(d.apr_pct) === 0 || Number(d.minimum_payment) === 0));

  async function chooseOrder(id) {
    if (id === strategy) return;
    setChosenOrder(id);
    setOrderError('');
    const { error } = await supabase
      .from('planning_assumptions')
      .upsert({ household_id: household?.id, debt_order: id, updated_at: new Date().toISOString() }, { onConflict: 'household_id' });
    if (error) {
      setChosenOrder(null);
      setOrderError(`The order wasn't saved: ${error.message}`);
      return;
    }
    await reload();
    setChosenOrder(null);
  }

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const notLoaded = neverLoaded(sources, DEBT_INPUTS);
  // The saved extra payment and order: without them the what-if isn't worked
  // out, and its editor would open blank and save over what is there.
  const planNotLoaded = neverLoaded(sources, DEBT_PLAN_INPUTS);
  if (notLoaded.length > 0) {
    return (
      <Withheld missing={notLoaded} onRetry={onRetry}>
        Your debts aren&rsquo;t shown, rather than shown as none or at the wrong balance.
      </Withheld>
    );
  }
  // With one debt owing the order changes nothing.
  const showOrder = planNotLoaded.length === 0 && visibleDebts.filter((d) => Number(d.balance) > 0).length > 1;

  return (
    <div className="debt">
      <div className="debt-toolbar">
        {showOrder ? (
          <div className="ov-seg-row" role="group" aria-label="Payoff order">
            {STRATEGIES.map((s) => (
              <button key={s.id} type="button" className="om-seg" data-active={strategy === s.id} aria-pressed={strategy === s.id} onClick={() => chooseOrder(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Debt
        </button>
      </div>
      {orderError && (
        <p className="ov-warn debt-note" role="alert">
          {orderError}
        </p>
      )}

      {visibleDebts.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No debts</div>
          <div className="ov-empty-body">Add a debt to see when it clears and what it costs.</div>
        </div>
      ) : (
        <>
          <div className="debt-summary">
            <span className="debt-total fig">{`${formatMoney(totalOwed)} outstanding`}</span>
            <span className="ov-muted">{` across ${visibleDebts.length} debt${visibleDebts.length === 1 ? '' : 's'}`}</span>
          </div>
          <div className="debt-lead">
            <div className="debt-lead-date">{minimumOnlyText(atMinimums, now)}</div>
            {interest && <div className="ov-muted">{interest}, paying only the minimums.</div>}
          </div>
          {showOrder && <div className="ov-muted debt-note">{STRATEGY_NOTE[strategy]}</div>}
          {unlinked.length > 0 && (
            <div className="ov-warn debt-note debt-unlinked">
              {unlinked.length === 1 ? `${unlinked[0].name} is` : `${unlinked.length} debts are`} not in net worth. Open {unlinked.length === 1 ? 'it' : 'each'} and link a loan
              account, or create one, so the amount owed counts.
            </div>
          )}
          {toCheck.length > 0 && (
            <div className="ov-warn debt-note debt-check">
              Check the rate and minimum on {andList(toCheck.map((d) => d.name))}: a 0 is real for some loans, but it is also what a blank was once saved as, and
              the dates rest on {toCheck.length === 1 ? 'it' : 'them'}.
            </div>
          )}

          {/* Each debt in payoff order: its rank, name and progress, then what
              decides the order and when it clears at its minimum. */}
          <div className="debt-list">
            {ordered.map((d, i) => {
              const paidPct = d.original_amount ? Math.max(0, 1 - Number(d.balance) / Number(d.original_amount)) : null;
              return (
                <button key={d.id} type="button" className="debt-row" onClick={() => setEditing(data.debts.find((raw) => raw.id === d.id))}>
                  <div className="debt-rank fig">{i + 1}</div>
                  <div className="debt-main">
                    <div className="debt-name">{d.name}</div>
                    {d.note && <div className="ov-muted">{d.note}</div>}
                    {!d.inNetWorth && (
                      <div>
                        <span className="ov-chip-warn">{d.account ? 'Account not valued: not in net worth' : 'No account: not in net worth'}</span>
                      </div>
                    )}
                    {paidPct !== null && (
                      <div className="debt-progress">
                        <div className="bud-bar">
                          <span className="bud-bar-spent" style={{ width: `${paidPct * 100}%` }} />
                        </div>
                        <div className="ov-muted">{Math.round(paidPct * 100)}% paid down</div>
                      </div>
                    )}
                  </div>
                  <dl className="debt-figures">
                    <div>
                      <dt>Owed</dt>
                      <dd className={Number(d.balance) > 0 ? 'fig ov-neg' : 'fig'}>{d.inCredit ? 'In credit' : Number(d.balance) > 0 ? `−${formatMoney(d.balance)}` : '0'}</dd>
                    </div>
                    <div>
                      <dt>Rate</dt>
                      <dd className="fig">{Number(d.apr_pct).toFixed(1)}% a year</dd>
                    </div>
                    <div>
                      <dt>Minimum</dt>
                      <dd className="fig">{formatMoney(d.minimum_payment)} a month</dd>
                    </div>
                    <div>
                      <dt>Clears</dt>
                      <dd className="fig">{clearsText(byDebt.get(d.id), now)}</dd>
                    </div>
                  </dl>
                </button>
              );
            })}
          </div>

          <div className="debt-whatif">
            <div className="ov-kicker">What an extra payment would do</div>
            {!householdView ? (
              <div className="ov-muted debt-note">An extra payment is the household&rsquo;s, not a per-person number. Switch to &ldquo;Both&rdquo; to try one.</div>
            ) : planNotLoaded.length > 0 ? (
              <div className="debt-projection">
                <div className="ov-muted">{couldntLoad(planNotLoaded)} The extra payment and the order you chose aren&rsquo;t shown.</div>
                {onRetry && (
                  <button type="button" className="om-btn debt-primary" onClick={onRetry}>
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <div className="debt-projection">
                {tryingExtra && withExtra ? (
                  <>
                    <div className="debt-projection-head">
                      With {formatMoney(extraPayment)} extra a month: clears about {payoffMonthLabel(withExtra.months, now)}
                    </div>
                    <div className="ov-muted">
                      Against {atMinimums.months !== null ? payoffMonthLabel(atMinimums.months, now) : 'no date'} at the minimums. Interest along the way:{' '}
                      {formatMoney(Math.round(withExtra.totalInterest))}
                      {atMinimums.interest !== null && `, against ${formatMoney(Math.round(atMinimums.interest))}`}. The extra goes to the first debt in {strategy} order,
                      then the next once it clears.
                    </div>
                  </>
                ) : tryingExtra ? (
                  <div className="debt-projection-head">Doesn&rsquo;t clear within 50 years with {formatMoney(extraPayment)} extra a month.</div>
                ) : (
                  <>
                    <div className="debt-projection-head">No extra payment set</div>
                    <div className="ov-muted">Try one to see how much sooner the debts would clear, and how much interest it would save.</div>
                  </>
                )}
                <div className="ov-muted">
                  A rule of thumb: fill the cash reserve before paying extra on a loan at a low rate. Money paid into a loan can&rsquo;t be drawn back
                  when it&rsquo;s needed. A card at a high rate is the exception.
                </div>
                <button type="button" className="om-btn debt-primary" onClick={() => setEditingPlan(true)}>
                  {tryingExtra ? 'Change the extra payment' : 'Try an extra payment'}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {editing && (
        <DebtEditor
          debt={editing === 'new' ? null : editing}
          householdId={household?.id}
          members={members}
          accounts={accounts}
          debts={data.debts}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            // The debt may have made or changed its account, so both reload.
            await Promise.all([reload(), onReload?.()]);
          }}
        />
      )}

      {editingPlan && (
        <DebtPlanEditor
          householdId={household?.id}
          assumptions={assumptions}
          onClose={() => setEditingPlan(false)}
          onSaved={async () => {
            setEditingPlan(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}
