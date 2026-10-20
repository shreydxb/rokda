import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { formatBalance, formatMoney } from '../../lib/money';
import { parseDay } from '../../lib/day';
import { activityHref } from '../../lib/activityLink';
import { confirmedPairRow } from '../../lib/duplicates';
import { adjacentReviewMonths, budgetSummary, monthlyReview, reviewMonth, reviewMonthParam, withReviewReturn } from '../../lib/monthlyReview';
import { historyPreview, monthActions } from '../../lib/monthActions';

// The monthly review (lib/monthlyReview.js): what to settle before a month's
// totals go into history, worked out from the records, so each check ticks
// itself off once the work is done wherever it was done. Then what the close
// puts into history, and what the month says to do next (lib/monthActions.js).
const MARK = { done: '✓', todo: '○', note: '·' };
const STATEMENT_STATUS = { unchecked: 'Not checked', waiting: 'Waiting', mismatch: "Doesn't match", confirmed: 'Done', reconciled: 'Reconciled' };
const shortDate = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const monthName = (day) => parseDay(day).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const CHECK_CTA = { close: 'Close the month', balances: 'Confirm balances', statements: 'Check statements', estimates: 'Enter the AED debited' };
// Each pair of these is settled here, in the check, rather than on another page.
const SETTLED_HERE = new Set(['duplicates', 'transfers']);

export default function Review({ household, data, planning = {}, loading }) {
  const [params, setParams] = useSearchParams();
  const now = useMemo(() => new Date(), []);
  const monthParam = params.get('month');
  const selected = useMemo(() => reviewMonth(monthParam, now), [monthParam, now]);
  const { prev, next } = adjacentReviewMonths(selected, now);
  const goTo = (m) =>
    setParams((p) => {
      const nextParams = new URLSearchParams(p);
      nextParams.set('month', reviewMonthParam(m.year, m.month));
      return nextParams;
    });

  const review = useMemo(() => monthlyReview(selected, data, now), [selected, data, now]);
  const budget = useMemo(() => budgetSummary(selected, data, now), [selected, data, now]);
  const history = useMemo(() => historyPreview(selected, data, now), [selected, data, now]);
  const actions = useMemo(() => monthActions(selected, data, planning, now), [selected, data, planning, now]);
  // The first check still holding the month up is the next thing to do.
  const nextCheck = review.checks.find((c) => c.required && c.status === 'todo');
  // A link out of the review carries the month, so the page it opens offers
  // the way back (screens/BackToReview.jsx).
  const out = (href) => withReviewReturn(href, selected);
  const accountName = useMemo(() => new Map((data.accounts ?? []).map((a) => [a.id, a.name])), [data.accounts]);
  const [joining, setJoining] = useState(null);
  // Which pair is being settled, and whether its delete is waiting for a
  // second press.
  const [settling, setSettling] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [error, setError] = useState('');

  // Joins a suggested pair into one transfer, as the record editor's "Make
  // these one transfer" does.
  async function join(pair) {
    setJoining(pair.out.id);
    setError('');
    const { error: linkError } = await supabase.rpc('link_transfer', { p_out_transaction_id: pair.out.id, p_in_transaction_id: pair.in.id });
    setJoining(null);
    if (linkError) {
      setError(linkError.message);
      return;
    }
    await data.reload();
  }

  // "Both are real" is remembered as a link, so the pair is never asked about
  // again; deleting the one recorded twice ends it the other way.
  async function settle(pair, how) {
    if (how === 'delete' && confirmingDelete !== pair.second.id) {
      setConfirmingDelete(pair.second.id);
      return;
    }
    setSettling(pair.second.id);
    setError('');
    const { error: writeError } =
      how === 'keep'
        ? await supabase.from('transaction_links').insert(confirmedPairRow(household?.id, pair.first, pair.second))
        : await supabase.from('transactions').delete().eq('id', pair.second.id);
    setSettling(null);
    setConfirmingDelete(null);
    if (writeError) {
      setError(writeError.message);
      return;
    }
    await data.reload();
  }

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div className="rv">
      <div className="cal-nav" style={{ marginTop: 22 }}>
        <button type="button" className="om-btn" onClick={() => goTo(prev)}>
          ← Prev
        </button>
        <h2 className="rv-month">{review.label}</h2>
        <button type="button" className="om-btn" disabled={!next} onClick={() => next && goTo(next)}>
          Next →
        </button>
      </div>

      <div className="rv-progress" data-complete={review.complete}>
        {review.complete ? (review.closed ? `${review.label} is reviewed and closed.` : 'Every check is done.') : `${review.done} of ${review.total} done`}
      </div>
      <div className="ov-muted" style={{ fontSize: 12, marginTop: 4 }}>
        Covers the whole household's records, whoever is selected. Each check ticks itself off once the work is done.
      </div>
      {error && (
        <div className="ov-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      <section className="rv-next" aria-label="Next step">
        <div className="ov-kicker">Next step</div>
        {nextCheck ? (
          <>
            <div className="rv-title">{nextCheck.title}</div>
            <div className="ov-muted rv-detail">{nextCheck.detail}</div>
            {SETTLED_HERE.has(nextCheck.id) || !nextCheck.href ? (
              <button type="button" className="om-btn rv-open" onClick={() => document.getElementById(`review-${nextCheck.id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })}>
                Settle them below
              </button>
            ) : (
              <Link className="om-btn rv-open" to={out(nextCheck.href)}>
                {CHECK_CTA[nextCheck.id] ?? 'Open the records'}
              </Link>
            )}
          </>
        ) : actions.length > 0 ? (
          <>
            <div className="rv-title">{actions[0].title}</div>
            <div className="ov-muted rv-detail">{`The records are done. ${actions[0].detail}`}</div>
            <Link className="om-btn rv-open" to={out(actions[0].href)}>
              {actions[0].cta}
            </Link>
          </>
        ) : (
          <div className="rv-detail">{`Nothing else to do for ${review.label}.`}</div>
        )}
      </section>

      <ol className="rv-checks">
        {review.checks.map((check) => (
          <li key={check.id} id={`review-${check.id}`} className="rv-check" data-status={check.required ? check.status : 'note'} data-testid={`review-${check.id}`}>
            {/* A check that can't hold the month up isn't ticked, so the ticks
                always match the count above. */}
            <span className="rv-mark" aria-label={!check.required ? 'Note' : check.status === 'done' ? 'Done' : 'To do'}>
              {MARK[check.required ? check.status : 'note']}
            </span>
            <div className="rv-body">
              <div className="rv-title">{check.title}</div>
              <div className="ov-muted rv-detail">{check.detail}</div>

              {check.id === 'statements' && (
                <ul className="rv-sublist">
                  {check.statements.map((s) => (
                    <li key={s.account.id}>
                      {`${s.account.name}, closed ${shortDate(s.statementDate)}: `}
                      <span className={s.settled ? '' : 'ov-warn'}>{STATEMENT_STATUS[s.status] ?? s.status}</span>
                    </li>
                  ))}
                  {check.status === 'todo' && <li className="ov-muted">{check.hint}</li>}
                </ul>
              )}

              {check.id === 'duplicates' && check.pairs.length > 0 && (
                <ul className="rv-sublist">
                  {check.pairs.map((pair) => (
                    <li key={pair.second.id} className="rv-pair">
                      <span>
                        {`${pair.first.merchant}, `}
                        <span className="fig">{formatMoney(pair.first.amount, { decimals: 2 })}</span>
                        {` on ${accountName.get(pair.first.account_id) ?? 'an account'}: ${shortDate(pair.first.occurred_at)} and ${shortDate(pair.second.occurred_at)}`}
                      </span>
                      <span className="rv-actions">
                        <button type="button" className="om-btn rc-markpaid" disabled={settling !== null} onClick={() => settle(pair, 'keep')}>
                          Both are real
                        </button>
                        <button type="button" className="om-btn rc-markpaid" disabled={settling !== null} onClick={() => settle(pair, 'delete')}>
                          {confirmingDelete === pair.second.id ? `Delete the ${shortDate(pair.second.occurred_at)} one?` : 'Delete one'}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {check.id === 'transfers' && check.pairs.length > 0 && (
                <ul className="rv-sublist">
                  {check.pairs.map((pair) => (
                    <li key={pair.out.id} className="rv-pair">
                      <span>
                        <span className="fig">{formatMoney(pair.in.amount, { decimals: 2 })}</span>
                        {` from ${accountName.get(pair.out.account_id) ?? 'an account'} (${shortDate(pair.out.occurred_at)}) to ${accountName.get(pair.in.account_id) ?? 'an account'} (${shortDate(pair.in.occurred_at)})`}
                      </span>
                      <button type="button" className="om-btn rc-markpaid" disabled={joining !== null} onClick={() => join(pair)}>
                        {joining === pair.out.id ? 'Joining…' : 'Make one transfer'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {check.href && check.status !== 'done' && (
                <Link className="ov-link rv-open" to={out(check.href)}>
                  {CHECK_CTA[check.id] ?? 'Open the records'}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>

      <section className="rv-budget" aria-label="Budget">
        <div className="ov-kicker">Budget</div>
        {budget.hasBudget ? (
          <>
            <div style={{ marginTop: 6 }}>
              Spent <span className="fig">{formatMoney(budget.spentInBudget)}</span> of <span className="fig">{formatMoney(budget.budgeted)}</span> budgeted
              {budget.outside > 0 && (
                <>
                  , and <span className="fig">{formatMoney(budget.outside)}</span> outside it
                </>
              )}
              .
            </div>
            {budget.over.length > 0 ? (
              <ul className="rv-sublist">
                {budget.over.map((g) => (
                  <li key={g.categoryId}>
                    <Link className="ov-link" to={out(activityHref({ categoryId: g.categoryId, from: review.from, to: review.to, who: 'both' }))}>
                      {g.name}
                    </Link>
                    {`: ${formatMoney(g.spent)} of ${formatMoney(g.budget)}, ${formatMoney(g.spent - g.budget)} over`}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ov-muted" style={{ marginTop: 4 }}>
                No category went over its budget.
              </div>
            )}
          </>
        ) : (
          <div className="ov-muted" style={{ marginTop: 6 }}>
            {`No budget was set for ${review.label}. Spent ${formatMoney(budget.total)} in all.`}
          </div>
        )}
      </section>

      <section className="rv-history" aria-label={history.closed ? 'What went into history' : 'What goes into history'}>
        <div className="ov-kicker">{history.closed ? 'What went into history' : 'What goes into history'}</div>
        <dl className="rv-figures">
          <div>
            <dt>Income</dt>
            <dd className="fig">{formatMoney(history.income)}</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd className="fig">{formatMoney(history.spend)}</dd>
          </div>
          <div>
            <dt>Saved</dt>
            <dd className="fig">
              {formatBalance(history.saved)}
              {history.rate !== null && history.saved > 0 ? `, ${Math.round(history.rate * 100)}% of income` : ''}
            </dd>
          </div>
          <div>
            <dt>Net worth</dt>
            <dd className="fig">{formatBalance(history.netWorth)}</dd>
          </div>
        </dl>
        <div className="ov-muted rv-detail">
          {history.previous
            ? `${history.change >= 0 ? 'Up' : 'Down'} ${formatMoney(Math.abs(history.change))} on ${monthName(history.previous.date)}, the last month closed before it.`
            : 'The first month in history: nothing closed before it to compare with.'}
          {!history.closed && ' A close records the balances as they stand when it is pressed.'}
          {history.incomplete > 0 && ` ${history.incomplete} account(s) or holding(s) have no value yet, so net worth leaves them out.`}
          {!history.closed && !review.complete && ' Some checks are still open, so these figures may still change.'}
        </div>
      </section>

      <section className="rv-todo" aria-label="What to do next">
        <div className="ov-kicker">What to do next</div>
        {actions.length > 0 ? (
          <ol className="rv-checks">
            {actions.map((a) => (
              <li key={a.id} className="rv-check" data-status="todo" data-testid={`action-${a.id}`}>
                <div className="rv-body">
                  <div className="rv-title">{a.title}</div>
                  <div className="ov-muted rv-detail">{a.detail}</div>
                  <Link className="ov-link rv-open" to={out(a.href)}>
                    {a.cta}
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="ov-muted" style={{ marginTop: 6 }}>
            Nothing to act on: the bills ahead are covered, no goal is behind its pace, and nothing went over a budget or under a saving target.
          </div>
        )}
      </section>
    </div>
  );
}
