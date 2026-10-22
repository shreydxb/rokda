import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney } from '../../lib/money';
import { amortizeMinimumOnly, debtsWithAccounts, orderDebts, simulatePayoffPlan } from '../../lib/debt';
import DebtEditor from './DebtEditor';
import DebtPlanEditor from './DebtPlanEditor';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { DEBT_INPUTS, DEBT_PLAN_INPUTS } from './planningSources';
import Withheld from './Withheld';

const STRATEGIES = [
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'snowball', label: 'Snowball' },
  { id: 'custom', label: 'Custom order' },
];

const STRATEGY_NOTE = {
  avalanche: 'Highest rate first. Every spare dirham goes to the debt costing the most in interest until it is clear.',
  snowball: 'Smallest balance first. Clears a debt soonest, at the cost of slightly more interest than avalanche overall.',
  custom: "Your own order, edited on each debt's rank. Nothing is enforced beyond changing where the extra payment goes.",
};

function monthsToLabel(months) {
  if (months === null) return null;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${rem} mo`;
  if (rem === 0) return `${years} yr`;
  return `${years} yr ${rem} mo`;
}

export default function DebtPayoff({ household, members, me, accounts = [], data, sources, onRetry, loading, onReload }) {
  const { assumptions, reload } = data;
  // Each debt at its linked account's balance: the one figure net worth uses too.
  const debts = useMemo(() => debtsWithAccounts(data.debts, accounts), [data.debts, accounts]);
  const unlinked = debts.filter((d) => !d.inNetWorth);
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const [strategy, setStrategy] = useState('avalanche');
  const [editing, setEditing] = useState(null);
  const [editingPlan, setEditingPlan] = useState(false);

  // A shared debt counts half toward each individual scope, same as every
  // other joint figure in the app. The payoff order and projection below
  // stay household-wide, though — a committed extra payment is one number
  // for the whole household, not something that splits per person.
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
  const historyAvailable = scopeMemberId === null;

  // The projection itself is always household-wide — a committed extra
  // payment isn't a per-person number — so it runs off the full debt list,
  // not whatever's scoped into view above.
  const orderedFull = useMemo(() => orderDebts(debts, strategy), [debts, strategy]);
  const extraPayment = assumptions?.debt_extra_payment != null ? Number(assumptions.debt_extra_payment) : null;
  const cardAssumptionSet = assumptions?.debt_assume_no_new_card_spend != null;
  const canProject = extraPayment !== null && extraPayment > 0 && cardAssumptionSet && debts.length > 0;

  const plan = useMemo(() => {
    if (!canProject) return null;
    return simulatePayoffPlan(orderedFull, extraPayment);
  }, [canProject, orderedFull, extraPayment]);

  const minimumOnlyByDebt = useMemo(
    () =>
      debts.map((d) => ({
        name: d.name,
        months: amortizeMinimumOnly(d.balance, d.apr_pct, d.minimum_payment),
      })),
    [debts]
  );

  // What a debt-free date rests on. An extra payment of 0 is set but commits
  // nothing, so it counts as missing, like one never entered.
  const extraCommitted = extraPayment !== null && extraPayment > 0;
  const debtInputs = [
    {
      label: 'Committed extra payment',
      note: 'How much above the minimums goes to debt each month',
      state: extraPayment !== null ? `${formatMoney(extraPayment)} a month` : 'Not set',
      tone: extraCommitted ? 'ov-chip-ok' : 'ov-chip-warn',
    },
    {
      label: 'Card usage assumption',
      note: 'Whether new spend keeps landing on the revolving card',
      state: cardAssumptionSet ? (assumptions.debt_assume_no_new_card_spend ? 'No new spend' : 'New spend continues') : 'Not set',
      tone: cardAssumptionSet ? 'ov-chip-ok' : 'ov-chip-warn',
    },
    { label: 'Minimum payments', note: 'Entered by hand on each debt', state: debts.length ? 'Known' : 'No debts yet', tone: debts.length ? 'ov-chip-ok' : 'ov-chip-warn' },
    { label: 'Rates', note: 'Entered by hand on each debt', state: debts.length ? 'Known · manual' : 'No debts yet', tone: debts.length ? 'ov-chip-ok' : 'ov-chip-warn' },
  ];
  const missing = [!extraCommitted && 'a committed extra payment', !cardAssumptionSet && 'a card-usage assumption'].filter(Boolean);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const notLoaded = neverLoaded(sources, DEBT_INPUTS);
  // The saved extra payment: without it the projection isn't worked out, and
  // its editor would open blank and save over what is there.
  const planNotLoaded = neverLoaded(sources, DEBT_PLAN_INPUTS);
  if (notLoaded.length > 0) {
    return (
      <Withheld missing={notLoaded} onRetry={onRetry}>
        Your debts aren&rsquo;t shown, rather than shown as none or at the wrong balance.
      </Withheld>
    );
  }

  return (
    <div className="debt">
      <div className="debt-toolbar">
        <div className="ov-seg-row" role="group" aria-label="Payoff order">
          {STRATEGIES.map((s) => (
            <button key={s.id} type="button" className="om-seg" data-active={strategy === s.id} onClick={() => setStrategy(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Debt
        </button>
      </div>

      {visibleDebts.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No debts</div>
          <div className="ov-empty-body">Add a debt to see payoff order and a projection.</div>
        </div>
      ) : (
        <>
          <div className="debt-summary">
            <span className="debt-total fig">{`${formatMoney(totalOwed)} outstanding`}</span>
            <span className="ov-muted">{` across ${visibleDebts.length} debt${visibleDebts.length === 1 ? '' : 's'}`}</span>
          </div>
          <div className="ov-muted debt-note">{STRATEGY_NOTE[strategy]}</div>
          {unlinked.length > 0 && (
            <div className="ov-warn debt-note debt-unlinked">
              {unlinked.length === 1 ? `${unlinked[0].name} is` : `${unlinked.length} debts are`} not in net worth. Open {unlinked.length === 1 ? 'it' : 'each'} and link a loan
              account, or create one, so the amount owed counts.
            </div>
          )}

          {/* Each debt in payoff order: its rank, name and progress, then the
              three figures that decide the order, each with its label. */}
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
                      <dd className="fig ov-neg">−{formatMoney(d.balance)}</dd>
                    </div>
                    <div>
                      <dt>Rate</dt>
                      <dd className="fig">{Number(d.apr_pct).toFixed(1)}% a year</dd>
                    </div>
                    <div>
                      <dt>Minimum</dt>
                      <dd className="fig">{formatMoney(d.minimum_payment)} a month</dd>
                    </div>
                  </dl>
                </button>
              );
            })}
          </div>

          {!historyAvailable ? (
            <div className="ov-muted debt-plan">
              The payoff order and projection are tracked household-wide — a committed extra payment isn't a per-person number.
              Switch to "Both" to see them.
            </div>
          ) : planNotLoaded.length > 0 ? (
            <div className="debt-plan">
              <div>
                <div className="ov-kicker">Payoff projection</div>
                <div className="debt-projection">
                  <div className="debt-projection-head">No payoff date</div>
                  <div className="ov-muted">
                    {couldntLoad(planNotLoaded)} The projection rests on the saved extra payment, so it isn&rsquo;t worked out. At minimums alone:{' '}
                    {minimumOnlyByDebt.map((m) => `${m.name} ${m.months === null ? 'revolves indefinitely' : `clears in ${monthsToLabel(m.months)}`}`).join(' · ')}.
                  </div>
                  {onRetry && (
                    <button type="button" className="om-btn debt-primary" onClick={onRetry}>
                      Try again
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="debt-plan">
              <div>
                <div className="ov-kicker">Required to project a payoff</div>
                <div className="debt-inputs">
                  {debtInputs.map((di) => (
                    <div key={di.label} className="debt-input">
                      <div>
                        <div>{di.label}</div>
                        <div className="ov-muted">{di.note}</div>
                      </div>
                      <span className={di.tone}>{di.state}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="ov-kicker">Payoff projection</div>
                <div className="debt-projection">
                  {canProject && plan ? (
                    <>
                      <div className="debt-projection-head">Debt-free in {monthsToLabel(plan.months)}</div>
                      <div className="ov-muted">
                        At {formatMoney(extraPayment)} extra a month on top of the minimums, following {strategy} order. Total interest paid
                        along the way: {formatMoney(plan.totalInterest)}.
                      </div>
                    </>
                  ) : canProject && !plan ? (
                    <div className="debt-projection-head">Doesn't clear within 50 years at this rate.</div>
                  ) : (
                    <>
                      <div className="debt-projection-head">No payoff date yet</div>
                      <div className="ov-muted">
                        A debt-free date needs a committed extra payment and a card-usage assumption.{' '}
                        {missing.length === 2 ? 'Neither is set' : `${missing[0][0].toUpperCase()}${missing[0].slice(1)} is not set`}, so no date is shown.
                        At minimums alone: {minimumOnlyByDebt.map((m) => `${m.name} ${m.months === null ? 'revolves indefinitely' : `clears in ${monthsToLabel(m.months)}`}`).join(' · ')}.
                      </div>
                    </>
                  )}
                  <button type="button" className="om-btn debt-primary" onClick={() => setEditingPlan(true)}>
                    {extraCommitted ? 'Change the plan' : 'Set an extra payment'}
                  </button>
                </div>
              </div>
            </div>
          )}
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
