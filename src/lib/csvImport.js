import { parseDay } from './day';
import { estimateAed } from './fxHistory';
import { firstMatchingRule } from './rules';
import { transferCandidates } from './transfers';

// Statement imports from a CSV file (SHR-302; docs/decisions.md, "A statement
// is imported in one reviewed batch"). Everything here runs in the browser on
// the file the person chose: it is read, mapped and reviewed before anything
// is written, and only the rows they keep are sent, to commit_import, which
// writes them all or none.
//
// The order of work: parseCsv turns the text into cells; findHeader and
// guessMapping find the columns; readRows reads each line into a date and a
// signed amount, or says why it could not; withImportKeys gives each row the
// key that makes a re-import add nothing; reviewRows decides what each row
// should become; reconcile compares the file with the statement's balances;
// commitPayload builds what is sent.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// ---------------------------------------------------------------- reading

// The cells of a CSV file. Quoted fields may hold the delimiter, doubled
// quotes and line breaks. The delimiter is whichever of comma, semicolon and
// tab splits the first lines most consistently: European banks export with
// semicolons, because their decimal separator is the comma.
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { delimiter, rows: rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== '')) };
}

function detectDelimiter(src) {
  const lines = src.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 8);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t']) {
    const counts = lines.map((l) => splitOutsideQuotes(l, d));
    const modal = mode(counts);
    // A delimiter that appears the same number of times on most lines, and at
    // least once, is the one.
    const score = modal > 0 ? counts.filter((c) => c === modal).length * 100 + modal : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function splitOutsideQuotes(line, d) {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount || (c === bestCount && v > best)) [best, bestCount] = [v, c];
  return best;
}

// ---------------------------------------------------------------- columns

const HEADER_PATTERNS = {
  date: /^(transaction|txn|trans\.?|posting|post|value|booking|book)?\s*date$|^date\b|\bdate$/i,
  description: /description|details|narration|particulars|merchant|payee|remarks|memo|reference|transaction$/i,
  amount: /^(transaction\s+)?amount\b|^amt\b|amount\s*\(/i,
  debit: /debit|withdrawal|money\s*out|paid\s*out|^dr\.?$/i,
  credit: /credit|deposit|money\s*in|paid\s*in|^cr\.?$/i,
  balance: /balance/i,
  currency: /^currency$|^ccy$|currency\s*code/i,
};

// The row the column names are on. Bank exports often start with a few lines
// about the account; the header is the first line, within the first fifteen,
// that names a date column and an amount, debit or credit column.
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i];
    if (cells.some((c) => HEADER_PATTERNS.date.test(c)) && cells.some((c) => HEADER_PATTERNS.amount.test(c) || HEADER_PATTERNS.debit.test(c) || HEADER_PATTERNS.credit.test(c))) {
      return i;
    }
  }
  return -1;
}

// A first guess at which column holds what, from the column names. The
// person sees it and can change any of it before anything is read.
export function guessMapping(header = []) {
  const find = (pattern, avoid = []) => header.findIndex((h, i) => pattern.test(h) && !avoid.includes(i));
  // "Transaction date" before "Value date" or "Posting date": the day the
  // money was spent is the day the household knows it by.
  let date = header.findIndex((h) => /^(transaction|txn|trans\.?)\s*date$/i.test(h));
  if (date === -1) date = find(HEADER_PATTERNS.date);
  const debit = find(HEADER_PATTERNS.debit, [date]);
  const credit = find(HEADER_PATTERNS.credit, [date, debit]);
  const amount = find(HEADER_PATTERNS.amount, [date, debit, credit]);
  const balance = find(HEADER_PATTERNS.balance, [date, debit, credit, amount]);
  const description = find(HEADER_PATTERNS.description, [date, debit, credit, amount, balance]);
  const currency = find(HEADER_PATTERNS.currency, [date, debit, credit, amount, balance, description]);
  return {
    date,
    description,
    amount,
    debit,
    credit,
    currency,
    amountMode: amount === -1 && (debit !== -1 || credit !== -1) ? 'split' : 'single',
  };
}

// ---------------------------------------------------------------- dates

// A date as yyyy-mm-dd in the given order of day, month and year ('DMY',
// 'MDY' or 'YMD'), or null when it is not one. Month names count ("02 Sep
// 2026", "Sep 2, 2026"), two-digit years are this century, and a time after
// the date is ignored.
export function parseDate(value, order = 'DMY') {
  const text = String(value ?? '')
    .trim()
    .replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?(z|[+-]\d{2}:?\d{2})?$/i, '')
    .trim();
  if (text === '') return null;
  const parts = text.split(/[\s/.\-,]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  let d;
  let m;
  let y;
  const named = parts.findIndex((p) => /^[a-z]+$/i.test(p));
  if (named !== -1) {
    m = MONTHS[parts[named].toLowerCase().slice(0, 4)] ?? MONTHS[parts[named].toLowerCase().slice(0, 3)];
    if (!m) return null;
    const rest = parts.filter((_, i) => i !== named);
    if (/^\d{4}$/.test(rest[0])) [y, d] = rest;
    else [d, y] = rest;
  } else {
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    if (/^\d{4}$/.test(parts[0])) [y, m, d] = parts;
    else if (order === 'MDY') [m, d, y] = parts;
    else if (order === 'YMD') [y, m, d] = parts;
    else [d, m, y] = parts;
  }
  d = Number(d);
  m = Number(m);
  y = Number(y);
  if (String(y).length <= 2) y += 2000;
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Which order a column of dates is written in. When the dates read correctly
// both day-first and month-first ("03/04/2026" could be either), the file
// does not say which: `ambiguous` is set, and the person must confirm the
// order before importing. Day-first is offered first, as UAE and Indian banks
// write it.
export function detectDateOrder(values = []) {
  const filled = values.filter((v) => String(v ?? '').trim() !== '');
  const orders = ['DMY', 'MDY', 'YMD'].filter((o) => filled.length > 0 && filled.every((v) => parseDate(v, o) !== null));
  if (orders.length === 0) return { order: 'DMY', ambiguous: false, readable: false };
  // A year-first date reads the same whatever the order, so it decides nothing.
  const distinct = new Set(orders.map((o) => filled.map((v) => parseDate(v, o)).join()));
  return { order: orders[0], ambiguous: distinct.size > 1, readable: true };
}

// ---------------------------------------------------------------- amounts

// Which character separates the decimals in a column of amounts: a comma when
// some amount ends in ",dd" and none in ".dd" ("1.234,56").
export function detectDecimal(values = []) {
  const comma = values.some((v) => /\d,\d{1,2}(\D*)$/.test(String(v ?? '')));
  const dot = values.some((v) => /\d\.\d{1,2}(\D*)$/.test(String(v ?? '')));
  return comma && !dot ? ',' : '.';
}

// An amount as a number, keeping its sign, or null when the text is not one.
// A minus before or after the number, brackets, and a DR marker make it
// money out; a CR marker makes it money in. Currency codes and symbols
// before or after the number are ignored. `decimal` is '.' or ','.
export function parseAmount(value, decimal = '.') {
  let text = String(value ?? '').trim();
  if (text === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  const marker = text.match(/(?<![a-z])(cr|dr)\.?$/i);
  if (marker) {
    if (marker[1].toLowerCase() === 'dr') negative = !negative;
    text = text.slice(0, marker.index);
  }
  // A currency code before or after the number, and currency symbols. Any
  // other letter makes it not a number: "1O.00" with a letter O is refused,
  // not read as 1.00.
  text = text.replace(/^[a-z]{3}\s*|\s*[a-z]{3}$/gi, '').replace(/[$€£₹¥]|د\.إ/g, '').trim();
  if (/^-/.test(text) || /-$/.test(text)) {
    negative = !negative;
    text = text.replace(/^-|-$/g, '').trim();
  }
  text = text.replace(/^\+/, '').replace(/[\s'’]/g, '');
  if (decimal === ',') text = text.replace(/\./g, '').replace(',', '.');
  else text = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return negative ? -n : n;
}

// ---------------------------------------------------------------- rows

// Every line after the header as { line, date, amount, description,
// currency, error }. `amount` is signed in the account's own terms: negative
// is money out of it. A line that cannot be read keeps its error and is never
// imported; the review shows it.
//
// mapping: the columns (guessMapping), plus
//   dateOrder  'DMY' | 'MDY' | 'YMD'
//   decimal    '.' | ','
//   outPositive  for one amount column: money out is written positive, as
//                most card statements list purchases
export function readRows(rows, headerIndex, mapping) {
  const cell = (cells, i) => (i >= 0 ? (cells[i] ?? '').trim() : '');
  return rows.slice(headerIndex + 1).map((cells, i) => {
    const line = headerIndex + i + 2;
    const rawDate = cell(cells, mapping.date);
    const date = parseDate(rawDate, mapping.dateOrder);
    const description = cell(cells, mapping.description).replace(/\s+/g, ' ');
    const currency = cell(cells, mapping.currency).toUpperCase() || null;
    let amount = null;
    let error = null;
    if (mapping.amountMode === 'split') {
      const out = cell(cells, mapping.debit);
      const inn = cell(cells, mapping.credit);
      const outValue = out === '' ? null : parseAmount(out, mapping.decimal);
      const inValue = inn === '' ? null : parseAmount(inn, mapping.decimal);
      if ((out !== '' && outValue === null) || (inn !== '' && inValue === null)) error = `The amount "${out || inn}" isn't a number.`;
      else if (outValue !== null && inValue !== null && outValue !== 0 && inValue !== 0) error = 'It has both a money-out and a money-in amount.';
      else if (outValue !== null && outValue !== 0) amount = -Math.abs(outValue);
      else if (inValue !== null && inValue !== 0) amount = Math.abs(inValue);
    } else {
      const raw = cell(cells, mapping.amount);
      const value = raw === '' ? null : parseAmount(raw, mapping.decimal);
      if (raw !== '' && value === null) error = `The amount "${raw}" isn't a number.`;
      else if (value !== null && value !== 0) amount = mapping.outPositive ? -value : value;
    }
    if (!error && rawDate === '' && amount === null) error = 'The line is empty.';
    else if (!error && date === null) error = rawDate === '' ? 'It has no date.' : `"${rawDate}" isn't a date written ${ORDER_LABELS[mapping.dateOrder]}.`;
    else if (!error && amount === null) error = 'It has no amount.';
    return { line, date, amount, description, currency, error };
  });
}

export const ORDER_LABELS = { DMY: 'day first (31/01/2026)', MDY: 'month first (01/31/2026)', YMD: 'year first (2026-01-31)' };

const normalise = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);

// The key each readable row is imported under: its date, amount and
// description, and, for the second and later of identical lines, which one
// it is. Two coffees for the same amount at the same café on one day are two
// purchases, and stay two however often the file is imported.
export function withImportKeys(rows) {
  const seen = new Map();
  return rows.map((r) => {
    if (r.error) return { ...r, key: null };
    const base = `${r.date}|${r.amount.toFixed(2)}|${normalise(r.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...r, key: n > 1 ? `${base}#${n}` : base };
  });
}

// ---------------------------------------------------------------- review

// Money between the household's own accounts, by the words statements use
// for it: a card payment, a transfer, a top-up of savings.
const TRANSFER_WORDS = /\b(payment received|thank you|card payment|credit card payment|cc payment|autopay|auto pay|transfer|trf|tfr|own account|standing order|sweep)\b/i;

// What each readable row should become, before the person changes any of it:
//   action  'import' | 'skip'
//   kind    'expense' | 'income' | 'refund' | 'transfer'
//   note    why it was set that way, when it was not obvious
// plus, for a transfer, the record on another account it is the other side
// of (pairId) or the account its other side goes on (otherAccountId), and a
// category from the household's rules or from how the same merchant was
// filed before.
//
// Not imported by default: a row already imported (the same key on this
// account, which commit_import would skip anyway) and a row that looks
// already recorded (the same account and amount to the cent within three
// days, each existing record matched once). That includes a record imported
// before under another key: a bank that rewords its descriptions between
// exports would otherwise get every line in twice.
export function reviewRows(rows, { account, transactions = [], rules = [] } = {}) {
  const onAccount = transactions.filter((t) => t.account_id === account?.id);
  const importedKeys = new Set(onAccount.map((t) => t.import_key).filter(Boolean));
  const matched = new Set();
  const usedPairs = new Set();
  const history = categoryHistory(transactions);
  const isCard = account?.type === 'credit_card';

  return rows.map((r) => {
    if (r.error) return { ...r, action: 'skip', kind: null, note: r.error, fixed: true };
    if (importedKeys.has(r.key)) return { ...r, action: 'skip', kind: kindFor(r, isCard), note: 'Already imported.', fixed: true };

    const amountOf = (t) => (account?.currency && account.currency !== 'AED' && t.native_amount != null ? Number(t.native_amount) : Number(t.amount));
    const twin = onAccount.find(
      (t) => !matched.has(t.id) && Math.round(amountOf(t) * 100) === Math.round(r.amount * 100) && Math.abs(parseDay(t.occurred_at) - parseDay(r.date)) <= 3 * 86400000,
    );
    const kind = kindFor(r, isCard);
    const base = { ...r, kind, category_id: null, pairId: null, otherAccountId: null, fixed: false };
    if (twin) {
      matched.add(twin.id);
      return { ...base, action: 'skip', twinId: twin.id, note: `Looks already recorded: ${twin.merchant?.trim() || 'a record'} on ${shortDay(twin.occurred_at)}.` };
    }
    if (kind === 'transfer') {
      const pair = transferCandidates({ id: `row-${r.line}`, account_id: account?.id, amount: r.amount, occurred_at: r.date, kind: r.amount < 0 ? 'expense' : 'income' }, transactions).find(
        (t) => !usedPairs.has(t.id),
      );
      if (pair) {
        usedPairs.add(pair.id);
        return { ...base, action: 'import', pairId: pair.id, otherAccountId: pair.account_id, note: `The other side is already recorded: ${pair.merchant?.trim() || 'a record'} on ${shortDay(pair.occurred_at)}.` };
      }
      return { ...base, action: 'import', note: 'Money between your own accounts: choose the other account.' };
    }
    const rule = firstMatchingRule(r.description, rules);
    return { ...base, action: 'import', category_id: rule?.category_id ?? history.get(normalise(r.description)) ?? null };
  });
}

// Pay is income even when the bank calls it a transfer ("SALARY TRANSFER").
const PAY_WORDS = /\b(salary|payroll|wps)\b/i;

function kindFor(r, isCard) {
  if (r.amount > 0 && PAY_WORDS.test(r.description)) return 'income';
  if (TRANSFER_WORDS.test(r.description)) return 'transfer';
  if (r.amount < 0) return 'expense';
  // Money coming back onto a card is a refund unless it is the payment.
  return isCard ? 'refund' : 'income';
}

// The category each merchant was last filed under most often, by its
// normalised name.
function categoryHistory(transactions) {
  const counts = new Map();
  for (const t of transactions) {
    if (!t.category_id || !t.merchant) continue;
    const key = normalise(t.merchant);
    if (!counts.has(key)) counts.set(key, new Map());
    const byCategory = counts.get(key);
    byCategory.set(t.category_id, (byCategory.get(t.category_id) ?? 0) + 1);
  }
  const best = new Map();
  for (const [key, byCategory] of counts) best.set(key, [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return best;
}

const shortDay = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// The record on `otherAccountId` that a transfer line is the other side of,
// when it is already recorded there and no other line has claimed it. Choosing
// a transfer's other account looks here first, so a side already in the
// ledger is joined rather than recorded a second time.
export function pairOnAccount(row, account, otherAccountId, transactions = [], review = []) {
  if (!otherAccountId) return null;
  const claimed = new Set(review.filter((x) => x.line !== row.line && x.action === 'import' && x.pairId).map((x) => x.pairId));
  const pseudo = { id: `row-${row.line}`, account_id: account?.id, amount: row.amount, occurred_at: row.date, kind: row.amount < 0 ? 'expense' : 'income' };
  return transferCandidates(pseudo, transactions).find((t) => t.account_id === otherAccountId && !claimed.has(t.id)) ?? null;
}

// Why a row cannot be imported as it stands, or null.
export function rowProblem(row) {
  if (row.action !== 'import') return null;
  if (row.kind === 'expense' && row.amount > 0) return 'An expense is money out; this is money in.';
  if ((row.kind === 'income' || row.kind === 'refund') && row.amount < 0) return `${row.kind === 'income' ? 'Income' : 'A refund'} is money in; this is money out.`;
  if (row.kind === 'transfer' && !row.pairId && !row.otherAccountId) return 'Choose the other account.';
  return null;
}

// ---------------------------------------------------------------- statement

// The statement against the file. A statement's change in balance should be
// the sum of its lines; what the file does not explain is shown as it is, not
// written off. A card's statement gives what is owed, so its balances are
// read as money owed: owing more is money out.
//
// opening, closing: the balances as the statement prints them, or null.
export function reconcile(rows, { opening = null, closing = null, account } = {}) {
  const readable = rows.filter((r) => !r.error);
  const fileChange = round2(readable.reduce((s, r) => s + r.amount, 0));
  const unreadable = rows.length - readable.length;
  if (opening === null || closing === null || !Number.isFinite(opening) || !Number.isFinite(closing)) {
    return { fileChange, statementChange: null, difference: null, unreadable };
  }
  const statementChange = round2(account?.type === 'credit_card' ? opening - closing : closing - opening);
  return { fileChange, statementChange, difference: round2(statementChange - fileChange), unreadable };
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- commit

// What commit_import receives for the rows the person kept, with amounts in
// AED. An account kept in another currency sends each amount as the
// statement gave it beside the AED it counts as: dollars at the peg, rupees at
// the day's rate (or today's), marked an estimate. Throws when a kept row
// still has a problem, or when there is no rupee rate to convert with.
export function commitPayload(review, { account, fxHistory = [], household = null } = {}) {
  const kept = review.filter((r) => r.action === 'import');
  const problem = kept.map(rowProblem).find(Boolean);
  if (problem) throw new Error(problem);
  const currency = account?.currency || 'AED';
  return kept.map((r) => {
    const out = { occurred_at: r.date, kind: r.kind, merchant: r.description || null, import_key: r.key };
    if (r.kind !== 'transfer' && r.category_id) out.category_id = r.category_id;
    if (r.kind === 'transfer') {
      if (r.pairId) out.pair_transaction_id = r.pairId;
      else out.other_account_id = r.otherAccountId;
    }
    if (currency === 'AED') return { ...out, amount: round2(r.amount) };
    const estimate = estimateAed(r.amount, currency, r.date, fxHistory, household?.inr_per_aed);
    if (!estimate) throw new Error(`There is no ${currency} rate to convert line ${r.line} with. Set one in Settings first.`);
    return { ...out, amount: estimate.aed, currency, native_amount: round2(r.amount), aed_estimated: estimate.source !== 'peg' };
  });
}

// The first and last day of the readable rows, the period the import covers
// when the statement's own is not given.
export function dateRange(rows) {
  const days = rows.filter((r) => !r.error).map((r) => r.date).sort();
  return days.length ? { start: days[0], end: days[days.length - 1] } : { start: null, end: null };
}
