import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatSigned } from '../../lib/money';
import { parseDay } from '../../lib/day';
import { isArchived } from '../../lib/accounts';
import {
  ORDER_LABELS,
  commitPayload,
  dateRange,
  detectDateOrder,
  detectDecimal,
  findHeader,
  guessMapping,
  pairOnAccount,
  parseAmount,
  parseCsv,
  readRows,
  reconcile,
  reviewRows,
  rowProblem,
  withImportKeys,
} from '../../lib/csvImport';

// Statement imports from a CSV file (SHR-302; lib/csvImport.js): choose the
// account and the file, check how its columns are read, review every line,
// then import the kept lines together. Earlier imports are listed below with
// an undo. The file is read on this device; only the kept lines are sent.

const MAX_ROWS = 2000;
const KIND_LABELS = { expense: 'Expense', income: 'Income', refund: 'Refund', transfer: 'Transfer' };
const shortDate = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

export default function Import({ household, data, loading }) {
  const accounts = useMemo(() => (data.accounts ?? []).filter((a) => !isArchived(a)), [data.accounts]);
  const [accountId, setAccountId] = useState('');
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const [file, setFile] = useState(null); // { name, rows, header }
  const [mapping, setMapping] = useState(null);
  const [dateCheck, setDateCheck] = useState(null); // detectDateOrder's answer
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [balances, setBalances] = useState({ opening: '', closing: '' });
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [batches, setBatches] = useState([]);
  const [confirmingUndo, setConfirmingUndo] = useState(null);

  const householdId = household?.id;
  const fetchBatches = (id) =>
    supabase
      .from('import_batches')
      .select('*')
      .eq('household_id', id)
      .order('created_at', { ascending: false })
      .then(({ data: rows }) => rows ?? []);
  async function loadBatches() {
    if (householdId) setBatches(await fetchBatches(householdId));
  }
  useEffect(() => {
    if (!householdId) return;
    let cancelled = false;
    fetchBatches(householdId).then((rows) => {
      if (!cancelled) setBatches(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  function startOver() {
    setFile(null);
    setMapping(null);
    setDateCheck(null);
    setOrderConfirmed(false);
    setBalances({ opening: '', closing: '' });
    setReview(null);
    setError('');
  }

  async function chooseFile(chosen) {
    startOver();
    setMessage('');
    if (!chosen) return;
    let text;
    try {
      text = await readFileText(chosen);
    } catch (e) {
      setError(e.message);
      return;
    }
    const { rows } = parseCsv(text);
    const header = findHeader(rows);
    if (header === -1) {
      setError('No column names were found. The file needs a line naming its columns, with a date and an amount (or money out and money in).');
      return;
    }
    if (rows.length - header - 1 > MAX_ROWS) {
      setError(`The file has ${rows.length - header - 1} lines; one import takes at most ${MAX_ROWS}. Export a shorter period.`);
      return;
    }
    const guess = guessMapping(rows[header]);
    const body = rows.slice(header + 1);
    const amounts = body.map((r) => r[guess.amountMode === 'split' ? guess.debit : guess.amount]);
    const decimal = detectDecimal(amounts.concat(guess.amountMode === 'split' ? body.map((r) => r[guess.credit]) : []));
    const dates = detectDateOrder(body.map((r) => r[guess.date]));
    // Most card statements list purchases as positive amounts.
    const signs = amounts.map((v) => parseAmount(v, decimal)).filter((v) => v);
    const outPositive = account?.type === 'credit_card' && signs.filter((v) => v > 0).length > signs.length / 2;
    setFile({ name: chosen.name, rows, header });
    setMapping({ ...guess, dateOrder: dates.order, decimal, outPositive });
    setDateCheck(dates);
  }

  const columns = file ? file.rows[file.header] : [];
  const preview = file ? file.rows.slice(file.header + 1, file.header + 6) : [];
  const mappingProblem = !mapping
    ? null
    : mapping.date === -1
      ? 'Choose the date column.'
      : mapping.amountMode === 'single' && mapping.amount === -1
        ? 'Choose the amount column.'
        : mapping.amountMode === 'split' && mapping.debit === -1 && mapping.credit === -1
          ? 'Choose the money-out or money-in column.'
          : dateCheck?.ambiguous && !orderConfirmed
            ? 'These dates read correctly either way round. Confirm the order before going on.'
            : null;

  function readFile() {
    const rows = withImportKeys(readRows(file.rows, file.header, mapping));
    setReview(reviewRows(rows, { account, transactions: data.transactions ?? [], rules: data.categoryRules ?? [] }));
  }

  function setRow(line, changes) {
    setReview((rows) => rows.map((r) => (r.line === line ? { ...r, ...changes } : r)));
  }

  const opening = balances.opening.trim() === '' ? null : parseAmount(balances.opening);
  const closing = balances.closing.trim() === '' ? null : parseAmount(balances.closing);
  const check = review ? reconcile(review, { opening, closing, account }) : null;
  const kept = review ? review.filter((r) => r.action === 'import') : [];
  const problems = kept.filter((r) => rowProblem(r));
  const leftOut = review ? review.length - kept.length : 0;

  async function commit() {
    setError('');
    let payload;
    try {
      payload = commitPayload(review, { account, fxHistory: data.fxRateHistory ?? [], household });
    } catch (e) {
      setError(e.message);
      return;
    }
    const range = dateRange(review);
    setBusy(true);
    const { data: result, error: commitError } = await supabase.rpc('commit_import', {
      p_household_id: household.id,
      p_account_id: account.id,
      p_file_name: file.name,
      p_rows: payload,
      p_row_count: review.length,
      p_period_start: range.start,
      p_period_end: range.end,
      p_statement_opening: opening,
      p_statement_closing: closing,
    });
    setBusy(false);
    if (commitError) {
      setError(`Nothing was imported: ${commitError.message}`);
      return;
    }
    setMessage(
      `Imported ${result.imported} record${result.imported === 1 ? '' : 's'} into ${account.name}${
        result.already > 0 ? `; ${result.already} ${result.already === 1 ? 'was' : 'were'} already imported` : ''
      }.`,
    );
    startOver();
    await Promise.all([data.reload?.(), loadBatches()]);
  }

  async function undo(batch) {
    if (confirmingUndo !== batch.id) {
      setConfirmingUndo(batch.id);
      return;
    }
    setConfirmingUndo(null);
    setBusy(true);
    setError('');
    const { data: result, error: undoError } = await supabase.rpc('undo_import', { p_batch_id: batch.id });
    setBusy(false);
    if (undoError) {
      setError(undoError.message);
      return;
    }
    setMessage(
      `Removed ${result.removed} record${result.removed === 1 ? '' : 's'}${
        result.kept > 0 ? `; kept ${result.kept} that ${result.kept === 1 ? 'was' : 'were'} changed or joined to other records since` : ''
      }.`,
    );
    await Promise.all([data.reload?.(), loadBatches()]);
  }

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const accountName = (id) => (data.accounts ?? []).find((a) => a.id === id)?.name ?? 'Unknown account';
  const categories = (data.categories ?? []).filter((c) => !c.archived);
  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  return (
    <div className="im">
      <p className="ov-muted im-lede">
        Export a statement from your bank as a CSV file and import it here. The file is read on this device; only the lines you keep are saved, all
        together, and an import can be undone.
      </p>

      {message && (
        <p className="im-message" role="status">
          {message}
        </p>
      )}

      <div className="im-choose">
        <label className="te-fieldcell">
          <span className="te-fieldlabel">Account</span>
          <select
            className="te-fieldvalue"
            aria-label="Account"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              startOver();
            }}
          >
            <option value="">Choose the statement's account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.currency && a.currency !== 'AED' ? ` (${a.currency})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="te-fieldcell">
          <span className="te-fieldlabel">Statement file (CSV)</span>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Statement file"
            disabled={!account}
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {error && (
        <p className="ov-warn" role="alert">
          {error}
        </p>
      )}

      {file && mapping && !review && (
        <section className="im-section">
          <div className="ov-kicker">How the columns are read</div>
          <div className="im-table-wrap">
            <table className="im-table">
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th key={i} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i}>
                    {columns.map((_, j) => (
                      <td key={j}>{r[j] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="im-grid">
            <ColumnSelect label="Date" columns={columns} value={mapping.date} onChange={(v) => setMapping({ ...mapping, date: v })} />
            <ColumnSelect label="Description" columns={columns} value={mapping.description} onChange={(v) => setMapping({ ...mapping, description: v })} allowNone />
            <label className="te-fieldcell">
              <span className="te-fieldlabel">Amounts</span>
              <select className="te-fieldvalue" aria-label="Amounts" value={mapping.amountMode} onChange={(e) => setMapping({ ...mapping, amountMode: e.target.value })}>
                <option value="single">One amount column</option>
                <option value="split">Money out and money in columns</option>
              </select>
            </label>
            {mapping.amountMode === 'single' ? (
              <>
                <ColumnSelect label="Amount" columns={columns} value={mapping.amount} onChange={(v) => setMapping({ ...mapping, amount: v })} />
                <label className="te-fieldcell">
                  <span className="te-fieldlabel">Money out is written</span>
                  <select
                    className="te-fieldvalue"
                    aria-label="Money out is written"
                    value={mapping.outPositive ? 'positive' : 'negative'}
                    onChange={(e) => setMapping({ ...mapping, outPositive: e.target.value === 'positive' })}
                  >
                    <option value="negative">As a negative amount</option>
                    <option value="positive">As a positive amount (most card statements)</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <ColumnSelect label="Money out" columns={columns} value={mapping.debit} onChange={(v) => setMapping({ ...mapping, debit: v })} allowNone />
                <ColumnSelect label="Money in" columns={columns} value={mapping.credit} onChange={(v) => setMapping({ ...mapping, credit: v })} allowNone />
              </>
            )}
            <label className="te-fieldcell">
              <span className="te-fieldlabel">Dates are written</span>
              <select
                className="te-fieldvalue"
                aria-label="Dates are written"
                value={mapping.dateOrder}
                onChange={(e) => {
                  setMapping({ ...mapping, dateOrder: e.target.value });
                  setOrderConfirmed(true);
                }}
              >
                {Object.entries(ORDER_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label[0].toUpperCase() + label.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="te-fieldcell">
              <span className="te-fieldlabel">Decimals are marked with</span>
              <select className="te-fieldvalue" aria-label="Decimals" value={mapping.decimal} onChange={(e) => setMapping({ ...mapping, decimal: e.target.value })}>
                <option value=".">A point (1,234.50)</option>
                <option value=",">A comma (1.234,50)</option>
              </select>
            </label>
            <label className="te-fieldcell">
              <span className="te-fieldlabel">Statement's opening balance (optional)</span>
              <input className="te-fieldvalue" inputMode="decimal" aria-label="Opening balance" value={balances.opening} onChange={(e) => setBalances({ ...balances, opening: e.target.value })} />
            </label>
            <label className="te-fieldcell">
              <span className="te-fieldlabel">Statement's closing balance (optional)</span>
              <input className="te-fieldvalue" inputMode="decimal" aria-label="Closing balance" value={balances.closing} onChange={(e) => setBalances({ ...balances, closing: e.target.value })} />
            </label>
          </div>
          {account?.type === 'credit_card' && <p className="ov-muted im-note">For a card, enter the balances as the statement shows what you owe.</p>}
          {dateCheck?.ambiguous && (
            <label className="im-confirm">
              <input type="checkbox" checked={orderConfirmed} onChange={(e) => setOrderConfirmed(e.target.checked)} />
              <span>
                The dates in this file read correctly both day first and month first. They are written {ORDER_LABELS[mapping.dateOrder]}.
              </span>
            </label>
          )}
          {mappingProblem && <p className="ov-muted im-note">{mappingProblem}</p>}
          <div className="im-actions">
            <button type="button" className="om-btn" onClick={startOver}>
              Choose another file
            </button>
            <button type="button" className="om-btn ov-btn-primary" disabled={!!mappingProblem} onClick={readFile}>
              Read the lines
            </button>
          </div>
        </section>
      )}

      {review && (
        <section className="im-section">
          <div className="ov-kicker">
            {file.name} · {review.length} line{review.length === 1 ? '' : 's'}
          </div>
          <p className="im-summary">
            <b>{kept.length}</b> to import into {account.name}, <b>{leftOut}</b> left out
            {problems.length > 0 && (
              <span className="ov-warn">
                {' '}
                · {problems.length} need{problems.length === 1 ? 's' : ''} a choice
              </span>
            )}
            .
          </p>
          {check && (
            <p className="ov-muted im-note">
              The lines in this file add up to <span className="fig">{formatSigned(check.fileChange, { decimals: 2 })}</span>
              {check.statementChange !== null && (
                <>
                  ; the statement&rsquo;s balance moved <span className="fig">{formatSigned(check.statementChange, { decimals: 2 })}</span>.{' '}
                  {check.difference === 0 ? (
                    'They match.'
                  ) : (
                    <span className="ov-warn">
                      <span className="fig">{formatSigned(check.difference, { decimals: 2 })}</span> is not explained by the file&rsquo;s lines
                      {check.unreadable > 0 ? `; ${check.unreadable} line${check.unreadable === 1 ? '' : 's'} could not be read` : ''}.
                    </span>
                  )}
                </>
              )}
              {check.statementChange === null && '.'}
            </p>
          )}

          <div className="im-table-wrap">
            <table className="im-table im-review">
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Amount{account.currency && account.currency !== 'AED' ? ` (${account.currency})` : ''}</th>
                  <th scope="col">Becomes</th>
                  <th scope="col">Category or other account</th>
                </tr>
              </thead>
              <tbody>
                {review.map((r) => {
                  const problem = rowProblem(r);
                  return (
                    <tr key={r.line} data-action={r.action} data-problem={problem ? 'true' : undefined}>
                      <td className="fig">{r.line}</td>
                      <td>{r.date ? shortDate(r.date) : '—'}</td>
                      <td>
                        {r.description || '—'}
                        {(r.note || problem) && <div className={`im-row-note ${problem ? 'ov-warn' : 'ov-muted'}`}>{problem ?? r.note}</div>}
                      </td>
                      <td className="fig">{r.amount === null ? '—' : formatSigned(r.amount, { decimals: 2 })}</td>
                      <td>
                        {r.fixed ? (
                          <span className="ov-muted">Left out</span>
                        ) : (
                          <select
                            className="om-seg"
                            aria-label={`Line ${r.line} becomes`}
                            value={r.action === 'skip' ? 'skip' : r.kind}
                            onChange={(e) =>
                              setRow(
                                r.line,
                                e.target.value === 'skip'
                                  ? { action: 'skip' }
                                  : e.target.value === 'transfer' && r.kind !== 'transfer'
                                    ? { action: 'import', kind: 'transfer', otherAccountId: null, pairId: null, note: 'Money between your own accounts: choose the other account.' }
                                    : { action: 'import', kind: e.target.value },
                              )
                            }
                          >
                            {Object.entries(KIND_LABELS).map(([k, label]) => (
                              <option key={k} value={k}>
                                {label}
                              </option>
                            ))}
                            <option value="skip">Leave out</option>
                          </select>
                        )}
                      </td>
                      <td>
                        {r.action === 'import' && r.kind === 'transfer' && (
                          <select
                            className="om-seg"
                            aria-label={`Line ${r.line} other account`}
                            value={r.otherAccountId ?? ''}
                            onChange={(e) => {
                              const pair = pairOnAccount(r, account, e.target.value, data.transactions ?? [], review);
                              setRow(r.line, {
                                otherAccountId: e.target.value || null,
                                pairId: pair?.id ?? null,
                                note: pair ? `The other side is already recorded: ${pair.merchant?.trim() || 'a record'} on ${shortDate(pair.occurred_at)}.` : null,
                              });
                            }}
                          >
                            <option value="">Other account…</option>
                            {otherAccounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {r.amount < 0 ? 'To' : 'From'} {a.name}
                                {r.pairId && a.id === r.otherAccountId ? ' (joined to the record there)' : ''}
                              </option>
                            ))}
                          </select>
                        )}
                        {r.action === 'import' && r.kind !== 'transfer' && (
                          <select
                            className="om-seg"
                            aria-label={`Line ${r.line} category`}
                            value={r.category_id ?? ''}
                            onChange={(e) => setRow(r.line, { category_id: e.target.value || null })}
                          >
                            <option value="">Uncategorised</option>
                            {categories
                              .filter((c) => (r.kind === 'income' ? c.kind === 'income' : c.kind !== 'income'))
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="im-actions">
            <button type="button" className="om-btn" onClick={() => setReview(null)} disabled={busy}>
              Back to the columns
            </button>
            <button type="button" className="om-btn ov-btn-primary" onClick={commit} disabled={busy || kept.length === 0 || problems.length > 0}>
              {busy ? 'Importing…' : `Import ${kept.length} record${kept.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </section>
      )}

      <section className="im-section">
        <div className="ov-kicker">Earlier imports</div>
        {batches.length === 0 ? (
          <p className="ov-muted im-note">None yet.</p>
        ) : (
          <div className="mn-list">
            {batches.map((b) => (
              <div key={b.id} className="mn-row im-batch" style={{ cursor: 'default' }}>
                <div className="mn-row-main">
                  <div>
                    {b.file_name} · {accountName(b.account_id)}
                  </div>
                  <div className="ov-muted" style={{ fontSize: 12 }}>
                    {new Date(b.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · {b.imported_count} imported,{' '}
                    {b.skipped_count} not
                    {b.period_start && b.period_end ? ` · ${shortDate(b.period_start)} to ${shortDate(b.period_end)}` : ''}
                    {b.status === 'undone' ? ` · undone${b.kept_on_undo ? `, ${b.kept_on_undo} kept` : ''}` : ''}
                  </div>
                </div>
                {b.status === 'committed' && (
                  <button type="button" className="om-btn" onClick={() => undo(b)} disabled={busy}>
                    {confirmingUndo === b.id ? 'Remove its records?' : 'Undo'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ColumnSelect({ label, columns, value, onChange, allowNone = false }) {
  return (
    <label className="te-fieldcell">
      <span className="te-fieldlabel">{label} column</span>
      <select className="te-fieldvalue" aria-label={`${label} column`} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={-1}>{allowNone ? 'None' : 'Choose…'}</option>
        {columns.map((c, i) => (
          <option key={i} value={i}>
            {c || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}
