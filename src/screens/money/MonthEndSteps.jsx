import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { formatBalance, formatMoney } from '../../lib/money';
import { isPosted, parseDay } from '../../lib/day';
import { accountHref, monthRange, tabHref } from '../../lib/activityLink';
import { isUncategorised } from '../../lib/activity';
import { confirmedPairRow } from '../../lib/duplicates';
import { fileableCategories } from '../../lib/fileableCategories';
import { monthlyReview, withReviewReturn } from '../../lib/monthlyReview';
import { historyPreview } from '../../lib/monthActions';
import { monthEndSteps } from '../../lib/monthEnd';
import { statementRowsForMonth } from '../../lib/statements';
import { useMonthClose } from '../../lib/useMonthClose';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { monthParam } from '../../lib/useMonthParam';
import { Chip, Fold, KpiStrip, WarningRow } from '../../design-system/kit';
import Icon from '../../design-system/Icon';
import MonthCloseForm from '../wealth/MonthCloseForm';
import StatementsTable, { MarkTicked } from './StatementsTable';
import { useStatementActions } from './useStatementActions';
import { setCategory } from './setCategory';

// A month to close, or an earlier one never closed, as the prototype's steps
// (the revamp, phase 4d; design/prototype meSteps): tidy the records, check
// the statements and balances, then close. The checks are the monthly
// review's (lib/monthlyReview.js), gathered into steps by lib/monthEnd.js, so
// each ticks itself off once the work is done, wherever it was done. The step
// still open is shown open; a click opens another, and a link can name one
// (`step=2`, or `step=all`).

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (day) => {
  const d = parseDay(day);
  return `${d.getDate()} ${SHORT[d.getMonth()]}`;
};
const longMonth = (year, month) => new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long' });
// What each check's link says (lib/monthlyReview.js gives where it goes).
const CHECK_CTA = { estimates: 'Enter the AED debited' };

export default function MonthEndSteps({ household, members, me, data, year, month, now, closable, closed = false }) {
  const [params] = useSearchParams();
  const selected = useMemo(() => ({ year, month }), [year, month]);
  const review = useMemo(() => monthlyReview(selected, data, now), [selected, data, now]);
  const steps = monthEndSteps(review);
  const byId = new Map(review.checks.map((c) => [c.id, c]));
  const name = longMonth(year, month);
  const { accounts = [], transactions = [], categories = [], statementReconciliations = [] } = data;

  // Which step is open: the one a click chose, else the one a link named,
  // else the first still to do.
  const [chosen, setChosen] = useState(undefined);
  const linked = params.get('step');
  const isOpen = (n) => (chosen !== undefined ? chosen === n : linked === 'all' ? true : linked ? Number(linked) === n : steps.current === n);
  const toggle = (n) => setChosen(isOpen(n) ? null : n);

  // A link out of Month end carries the month, so the page it opens offers
  // the way back (screens/BackToReview.jsx).
  const out = (href) => withReviewReturn(href, selected);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const [busy, setBusy] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [error, setError] = useState('');

  // One write, then the records read again; its error is shown at the top.
  const run = async (key, write) => {
    setBusy(key);
    setError('');
    const { error: writeError } = await write();
    setBusy(null);
    if (writeError) {
      setError(writeError.message ?? writeError);
      return;
    }
    await data.reload();
  };
  // Joins a suggested pair into one transfer, as the record editor's "Make
  // these one transfer" does.
  const join = (pair) => run(pair.out.id, () => supabase.rpc('link_transfer', { p_out_transaction_id: pair.out.id, p_in_transaction_id: pair.in.id }));
  // "Both are real" is remembered as a link, so the pair is never asked about
  // again; deleting the one recorded twice ends it the other way, after a
  // second press.
  const settle = (pair, how) => {
    if (how === 'delete' && confirmingDelete !== pair.second.id) {
      setConfirmingDelete(pair.second.id);
      return;
    }
    setConfirmingDelete(null);
    return run(pair.second.id, () =>
      how === 'keep' ? supabase.from('transaction_links').insert(confirmedPairRow(household?.id, pair.first, pair.second)) : supabase.from('transactions').delete().eq('id', pair.second.id),
    );
  };
  const file = async (t, categoryId) => {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;
    setBusy(t.id);
    setError('');
    const result = await setCategory(t, category);
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.historyError) setError(`Saved, but not added to the record's history: ${result.historyError}`);
    await data.reload();
  };

  // The month's posted records with no category, newest first.
  const { from, to } = monthRange(year, month);
  const uncategorised = transactions
    .filter((t) => {
      const day = String(t.occurred_at).slice(0, 10);
      return day >= from && day <= to && isPosted(t, now) && isUncategorised(t);
    })
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  const statements = useMemo(() => statementRowsForMonth({ accounts, reconciliations: statementReconciliations, transactions, now, year, month }), [accounts, statementReconciliations, transactions, now, year, month]);
  const statementActions = useStatementActions({ household, me, reload: data.reload });

  const history = useMemo(() => historyPreview(selected, data, now), [selected, data, now]);
  const close = useMonthClose({ householdId: household?.id, accounts, holdings: data.holdings ?? [], netWorthSnapshots: data.netWorthSnapshots ?? [], now, onClosed: data.reload });
  // A total worked out without holdings that never loaded is not the
  // household's, and a close is kept for good: none is offered until they
  // load, as on Net worth (outside review, E-03).
  const unread = neverLoaded(data, ['holdings']);
  const canClose = closable && !!close.pending && unread.length === 0;
  // The balances are what a close records, so they are not to finish after:
  // an account not confirmed since the month ended goes in as it stands, and
  // a closed month can't be changed. The other checks can be.
  const staleBalances = byId.get('balances')?.status === 'todo' ? byId.get('balances').accounts : [];
  const stillOpen = steps.steps.filter((s) => s.n < 3 && s.checks.some((c) => c.required && c.status === 'todo' && c.id !== 'balances')).map((s) => s.n);
  const balanceNote = staleBalances.length > 0 && (
    <span className="ov-warn">
      {`${staleBalances.map((a) => a.name).join(', ')} ${staleBalances.length === 1 ? 'isn’t' : 'aren’t'} confirmed since the month ended. The close records ${staleBalances.length === 1 ? 'it' : 'them'} as ${staleBalances.length === 1 ? 'it stands' : 'they stand'}, and a closed month can’t be changed afterwards: confirm ${staleBalances.length === 1 ? 'it' : 'them'} first, or check the two figures below.`}
    </span>
  );

  const okRow = (text) => (
    <div className="me-ok">
      <span className="me-ok-mark" aria-hidden="true" />
      {text}
    </div>
  );
  const linkRow = (check) => (
    <div className="me-rows">
      <div className="me-rw">
        <span className="me-rw-main">{check.detail}</span>
        <Link className="ds-link ds-link-accent" to={out(check.href)}>
          {CHECK_CTA[check.id] ?? 'Open the records'}
        </Link>
      </div>
    </div>
  );
  const todo = (id) => (byId.get(id)?.status === 'todo' || byId.get(id)?.status === 'note') && byId.get(id).count > 0;

  const tidy = steps.steps[0];
  const tidyBody = (
    <>
      {uncategorised.length > 0 && (
        <>
          <div className="me-sub-h">{`Uncategorised · ${uncategorised.length}`}</div>
          <div className="me-rows">
            {uncategorised.map((t) => (
              <div key={t.id} className="me-rw">
                <span className="me-rw-date">{shortDate(t.occurred_at)}</span>
                <span className="me-rw-main">
                  <span className="me-rw-t">{t.merchant || 'Transaction'}</span>
                  <span className="me-rw-s">{` · ${accountName.get(t.account_id) ?? 'Account'}`}</span>
                </span>
                <span className="ds-num me-rw-amt">{formatBalance(t.amount, { decimals: 2 })}</span>
                <select
                  className="ds-select ds-select-sm me-rw-select"
                  aria-label={`Category for ${t.merchant || 'this record'}`}
                  value=""
                  disabled={busy === t.id}
                  onChange={(e) => file(t, e.target.value)}
                >
                  <option value="">Uncategorised</option>
                  {fileableCategories(categories, Number(t.amount) > 0 && t.kind !== 'refund' ? 'income' : 'expense').map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </>
      )}
      {todo('duplicates') && (
        <>
          <div className="me-sub-h">{`Possible duplicates · ${byId.get('duplicates').count}`}</div>
          <div className="me-rows">
            {byId.get('duplicates').pairs.map((pair) => (
              <div key={pair.second.id} className="me-rw">
                <span className="me-rw-date">{shortDate(pair.first.occurred_at)}</span>
                <span className="me-rw-main">
                  <span className="me-rw-t">{pair.first.merchant || 'Transaction'}</span>
                  <span className="me-rw-s">{` · also ${shortDate(pair.second.occurred_at)} · ${formatMoney(pair.first.amount, { decimals: 2 })} each on ${accountName.get(pair.first.account_id) ?? 'an account'}`}</span>
                </span>
                <button type="button" className="ds-btn ds-btn-sm" disabled={busy !== null} onClick={() => settle(pair, 'keep')}>
                  Both are real
                </button>
                <button type="button" className="ds-btn ds-btn-sm me-danger" disabled={busy !== null} onClick={() => settle(pair, 'delete')}>
                  {confirmingDelete === pair.second.id ? `Delete the ${shortDate(pair.second.occurred_at)} one?` : 'Delete one'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {todo('review') && (
        <>
          <div className="me-sub-h">{`Flagged · ${byId.get('review').count}`}</div>
          {linkRow(byId.get('review'))}
        </>
      )}
      {todo('estimates') && (
        <>
          <div className="me-sub-h">{`AED estimates · ${byId.get('estimates').count}`}</div>
          {linkRow(byId.get('estimates'))}
        </>
      )}
      {todo('transfers') && (
        <>
          <div className="me-sub-h">{`Transfers · ${byId.get('transfers').count}`}</div>
          <div className="me-rows">
            {byId.get('transfers').pairs.map((pair) => (
              <div key={pair.out.id} className="me-rw">
                <span className="me-rw-date">{shortDate(pair.out.occurred_at)}</span>
                <span className="me-rw-main">
                  <span className="me-rw-t">{formatMoney(pair.in.amount, { decimals: 2 })}</span>
                  <span className="me-rw-s">{` from ${accountName.get(pair.out.account_id) ?? 'an account'} (${shortDate(pair.out.occurred_at)}) to ${accountName.get(pair.in.account_id) ?? 'an account'} (${shortDate(pair.in.occurred_at)})`}</span>
                </span>
                <button type="button" className="ds-btn ds-btn-sm" disabled={busy !== null} onClick={() => join(pair)}>
                  {busy === pair.out.id ? 'Joining…' : 'Make one transfer'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {todo('refunds') && (
        <>
          <div className="me-sub-h">{`Refunds · ${byId.get('refunds').count}`}</div>
          {linkRow(byId.get('refunds'))}
        </>
      )}
      {tidy.done && !todo('transfers') && !todo('refunds') && okRow('Nothing left to tidy.')}
      {tidy.clear.length > 0 && (
        <Fold label="Nothing to do" count={tidy.clear.length}>
          <div className="me-clear">
            {tidy.clear.map((title) => (
              <span key={title}>
                <Icon name="check" />
                {title}
              </span>
            ))}
          </div>
        </Fold>
      )}
    </>
  );

  const statementsCheck = byId.get('statements');
  const checkBody = (
    <>
      {statementsCheck ? (
        <>
          <StatementsTable rows={statements} accounts={accounts} members={members} actions={statementActions} />
          {statementsCheck.status === 'todo' && <div className="me-hint">{statementsCheck.hint}</div>}
        </>
      ) : (
        okRow(`No card statement closed in ${name}.`)
      )}
      {byId.get('balances') && (
        <>
          <div className="me-sub-h me-sub-rule">Balances</div>
          {staleBalances.length > 0 ? (
            <div className="me-rows">
              {staleBalances.map((a) => (
                <div key={a.id} className="me-rw">
                  <span className="me-dot" aria-hidden="true" />
                  <span className="me-rw-main">
                    <span className="me-rw-t">{a.name}</span>
                    <span className="me-rw-s">{` · not confirmed since ${shortDate(to)}`}</span>
                  </span>
                  <Link className="ds-btn ds-btn-sm" to={out(accountHref(a.id, { view: 'details', who: 'both' }))}>
                    Confirm balance
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            okRow('Every balance is confirmed.')
          )}
        </>
      )}
    </>
  );

  const closeBody = (
    <>
      <KpiStrip
        items={[
          { label: 'Income', value: formatMoney(history.income) },
          { label: 'Spent', value: formatBalance(history.spend) },
          { label: 'Saved', value: formatBalance(history.saved), tone: history.saved < 0 ? 'neg' : undefined, sub: history.rate == null ? null : `${Math.round(history.rate * 100)}% of income` },
          { label: 'Net worth', value: formatBalance(history.netWorth), sub: history.incomplete > 0 ? <Chip tone="warn" title="An account or holding has no value yet, so net worth leaves it out.">Provisional</Chip> : null },
        ]}
      />
      <div className="me-close">
        {stillOpen.length > 0 && (
          <WarningRow>{`${stillOpen.length > 1 ? 'Steps' : 'Step'} ${stillOpen.join(' and ')} ${stillOpen.length > 1 ? 'are' : 'is'} still open. You can close now and finish after.`}</WarningRow>
        )}
        {canClose && !close.draft && (
          <div>
            <button type="button" className={`ds-btn${steps.current === 3 ? ' ds-btn-primary' : ''}`} disabled={close.closing} onClick={close.open}>
              {`Close ${name}`}
            </button>
          </div>
        )}
        {canClose && <MonthCloseForm close={close} note={balanceNote || null} />}
        {closable && close.pending && unread.length > 0 && <WarningRow>{`${couldntLoad(unread)} ${name} can’t be closed until they load: its totals would leave them out.`}</WarningRow>}
      </div>
    </>
  );

  const bodies = { tidy: tidyBody, check: checkBody, close: closeBody };
  // Beside the step's name only while the step is open, where what it does,
  // and any failure, can be seen (the fresh review of 4d).
  const rights = { check: isOpen(2) ? <MarkTicked rows={statements} actions={statementActions} /> : null };

  const stepCards = steps.steps.map((s) => {
    const open = isOpen(s.n);
    const current = steps.current === s.n;
    return (
      <section key={s.n} className={`ds-card me-step${current ? ' ds-card-action' : ''}`} aria-label={`Step ${s.n}: ${s.title}`}>
        {/* The whole row opens the step, as in the prototype; the button is
            what a keyboard and a screen reader use. */}
        <div className="me-step-h" onClick={(e) => !e.target.closest('button, a, input, select') && toggle(s.n)}>
          <button type="button" className="me-step-toggle" aria-expanded={open} onClick={() => toggle(s.n)}>
            <span className="me-step-n" data-state={s.done ? 'done' : current ? 'cur' : undefined} aria-hidden="true">
              {s.done ? <Icon name="check" /> : s.n}
            </span>
            <span className="me-step-t">{s.title}</span>
            <span className="me-step-s">{s.status}</span>
          </button>
          {rights[s.id]}
          <span className="me-caret" data-on={open || undefined} aria-hidden="true" />
        </div>
        {open && <div className="me-step-b">{bodies[s.id]}</div>}
      </section>
    );
  });
  const errorLine = error && (
    <div className="me-error" role="alert">
      {error}
    </div>
  );

  // Beneath a closed month's page: its checks, still to be finished or
  // looked back on, without the close.
  if (closed) {
    return (
      <section className="me-checks" aria-labelledby="me-checks-title">
        <h2 className="me-checks-title" id="me-checks-title">
          Checks
        </h2>
        {errorLine}
        {stepCards}
      </section>
    );
  }

  return (
    <>
      <div className="me-head">
        <div>
          <h2 className="me-title">{closable ? `Close ${name}` : `${name} ${year}`}</h2>
          <div className="me-sub">{`${steps.done} of ${steps.total} steps done`}</div>
        </div>
        <span className="me-steps-bar" aria-hidden="true">
          {steps.steps.map((s) => (
            <i key={s.n} data-on={s.done || undefined} />
          ))}
        </span>
        <Chip title="A month closes for the whole household, whoever is selected.">Household</Chip>
        <span className="me-grow" />
        <Link className="ds-link ds-link-accent" to={tabHref('/money', 'budget', { month: monthParam(new Date(year, month - 1, 1)), who: 'both' })}>
          {`Budget for ${SHORT[month - 1]} →`}
        </Link>
      </div>
      {!closable && <div className="me-note">{`${name} was never closed, and it can’t be closed now: a close records today’s totals as the month just ended’s. Its records are still worth getting right.`}</div>}
      {errorLine}
      {stepCards}
    </>
  );
}
