import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney } from '../../lib/money';
import { amortizeMinimumOnly, orderDebts, simulatePayoffPlan } from '../../lib/debt';
import DebtEditor from './DebtEditor';
import DebtPlanEditor from './DebtPlanEditor';

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

export default function DebtPayoff({ household, members, me, data, loading }) {
  const { debts, assumptions, reload } = data;
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

  const debtInputs = [
    {
      label: 'Committed extra payment',
      note: 'How much above the minimums goes to debt each month',
      state: extraPayment !== null ? `${formatMoney(extraPayment)} / mo` : 'Not set',
      tone: extraPayment !== null ? 'ov-chip-ok' : 'ov-chip-warn',
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

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <div className="mn-filters">
        {STRATEGIES.map((s) => (
          <button key={s.id} type="button" className="om-seg" data-active={strategy === s.id} onClick={() => setStrategy(s.id)}>
            {s.label}
          </button>
        ))}
        <span className="ov-muted">{visibleDebts.length > 0 ? `${formatMoney(totalOwed)} outstanding` : ''}</span>
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
          <div className="ov-muted" style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.65, maxWidth: '78ch' }}>
            {STRATEGY_NOTE[strategy]}
          </div>

          <section style={{ marginTop: 18 }}>
            <div className="mn-list">
              {ordered.map((d, i) => {
                const paidPct = d.original_amount ? Math.max(0, 1 - Number(d.balance) / Number(d.original_amount)) : null;
                return (
                  <button
                    key={d.id}
                    type="button"
                    className="mn-row"
                    onClick={() => setEditing(debts.find((raw) => raw.id === d.id))}
                    style={{ alignItems: 'center' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 0 }}>
                      <div className="fig" style={{ fontSize: 19, color: 'var(--accent)', flex: 'none', width: 20 }}>
                        {i + 1}
                      </div>
                      <div className="mn-row-main">
                        <div>{d.name}</div>
                        {d.note && <div className="ov-muted" style={{ marginTop: 3 }}>{d.note}</div>}
                        {paidPct !== null && (
                          <div style={{ marginTop: 8, maxWidth: 220 }}>
                            <div className="bud-bar" style={{ height: 3 }}>
                              <span className="bud-bar-spent" style={{ width: `${paidPct * 100}%` }} />
                            </div>
                            <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 5 }}>{Math.round(paidPct * 100)}% paid down</div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 24, flex: 'none', alignItems: 'baseline' }}>
                      <div className="fig ov-neg" style={{ fontSize: 17, minWidth: 90, textAlign: 'right' }}>
                        −{formatMoney(d.balance)}
                      </div>
                      <div className="ov-muted" style={{ minWidth: 70, textAlign: 'right' }}>{Number(d.apr_pct).toFixed(1)}%/yr</div>
                      <div className="ov-muted" style={{ minWidth: 80, textAlign: 'right' }}>{formatMoney(d.minimum_payment)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {!historyAvailable ? (
            <div className="ov-muted" style={{ marginTop: 32 }}>
              The payoff order and projection are tracked household-wide — a committed extra payment isn't a per-person number.
              Switch to "Both" to see them.
            </div>
          ) : (
          <div className="ov-quality-section" style={{ marginTop: 32, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 44 }}>
            <div>
              <div className="ov-kicker" style={{ marginBottom: 12 }}>
                Required to project a payoff
              </div>
              {debtInputs.map((di) => (
                <div key={di.label} className="mn-row" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }} onClick={() => setEditingPlan(true)}>
                  <div>
                    <div style={{ fontSize: 13.5 }}>{di.label}</div>
                    <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 3 }}>{di.note}</div>
                  </div>
                  <span className={di.tone}>{di.state}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="ov-kicker" style={{ marginBottom: 12 }}>
                Payoff projection
              </div>
              <div style={{ border: '1px dashed var(--rule2)', borderRadius: 3, padding: '16px 18px' }}>
                {canProject && plan ? (
                  <>
                    <div style={{ fontSize: 14 }}>Debt-free in {monthsToLabel(plan.months)}</div>
                    <div className="ov-muted" style={{ marginTop: 9, lineHeight: 1.7 }}>
                      At {formatMoney(extraPayment)} extra a month on top of the minimums, following {strategy} order. Total interest paid
                      along the way: {formatMoney(plan.totalInterest)}.
                    </div>
                  </>
                ) : canProject && !plan ? (
                  <div style={{ fontSize: 14 }}>Doesn't clear within 50 years at this rate.</div>
                ) : (
                  <>
                    <div style={{ fontSize: 14 }}>No payoff date yet</div>
                    <div className="ov-muted" style={{ marginTop: 9, lineHeight: 1.7 }}>
                      A debt-free date needs a committed extra payment and a card-usage assumption. Neither is set, so no date is shown.
                      At minimums alone: {minimumOnlyByDebt.map((m) => `${m.name} ${m.months === null ? 'revolves indefinitely' : `clears in ${monthsToLabel(m.months)}`}`).join(' · ')}.
                    </div>
                  </>
                )}
                <button type="button" className="om-btn" style={{ marginTop: 14, borderColor: 'var(--accent)', color: 'var(--ink)' }} onClick={() => setEditingPlan(true)}>
                  Set an extra payment
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
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
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
