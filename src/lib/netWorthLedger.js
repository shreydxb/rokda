import { atDayOfMonth, isPosted, parseDay, startOfDay } from './day';
import { scopedValue } from './scope';
import { accountTypeLabel, accountValueAed, isArchived, isLiabilityAccount } from './accounts';
import { balanceStatus, daysSinceBalanceConfirmed } from './balance';
import { nextDueDate, utilisation } from './creditCard';
import { isoDay, statementDueDate } from './statements';
import { spendDelta } from './transactionKind';

// Wealth -> Net worth's accounts ledger (the revamp, phase 5a;
// design/prototype assetsCard, liabilitiesCard, cycleBody): the assets as
// groups of rows with their totals, the liabilities with a card's running
// cycle and the share of its limit used, and a card's payment due. The values
// are the shared basis's (lib/accounts.js accountValueAed, lib/scope.js), so
// the ledger adds up to the figure Overview and the hero show.

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso) => {
  const d = parseDay(iso);
  return `${d.getDate()} ${SHORT[d.getMonth()]} ${d.getFullYear()}`;
};
const DAY_MS = 86400000;

// The groups By type lays the assets out in, as the prototype does.
const TYPE_GROUPS = [
  { id: 'current', label: 'Current accounts', types: ['checking'] },
  { id: 'savings', label: 'Savings', types: ['savings'] },
  { id: 'cash', label: 'Cash', types: ['cash'] },
  { id: 'deposits', label: 'Deposits and broker funds', types: ['fd', 'broker_funds'] },
  { id: 'other', label: 'Other', types: ['investment', 'other'] },
];

// Open accounts the person in view has a share in.
const inView = (accounts, scopeMemberId) => accounts.filter((a) => !isArchived(a) && (scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId));

// One ledger row: what to say beneath the name, whether its balance needs
// confirming, and its value in AED for the person in view. A balance nobody
// confirmed is counted as it stands, as the shared basis counts it
// (overviewMath.netWorthSummary), so the ledger adds up to the total; its
// status says it isn't confirmed (QA-02). One not converted to AED is not
// counted at all (QA #4), and gives its own currency instead.
function ledgerRow(a, { scopeMemberId, now, showType }) {
  const sub = [];
  if (showType) sub.push(accountTypeLabel(a.type));
  const currency = String(a.currency ?? 'AED').toUpperCase();
  const native = `${currency} ${Number(a.balance ?? 0).toLocaleString('en-AE')}`;
  const aed = accountValueAed(a);
  if (currency !== 'AED' && aed !== null) sub.push(native);
  if (a.type === 'fd' && a.maturity_date) {
    sub.push(`${a.fd_status === 'matured' ? 'matured' : 'matures'} ${dayLabel(a.maturity_date)}${a.interest_rate_pct != null ? ` · ${Number(a.interest_rate_pct)}%` : ''}`);
  }
  const balance = balanceStatus(a, now);
  const status = balance === 'unset' ? { kind: 'unset' } : balance === 'stale' ? { kind: 'stale', days: daysSinceBalanceConfirmed(a, now) } : null;
  const value = aed === null ? null : scopedValue(aed, a, scopeMemberId);
  return { account: a, sub: sub.length ? sub.join(' · ') : null, status, value, native: aed === null ? native : null };
}

const total = (rows) => rows.reduce((s, r) => s + (r.value ?? 0), 0);

// The assets, grouped By type (the prototype's groups) or By owner (Shared
// first, then each person in the household's order). A row names its type
// where its group doesn't: By owner, or in a group of several types.
export function assetGroups(accounts, { by = 'type', members = [], scopeMemberId = null, now = new Date() } = {}) {
  const assets = inView(accounts, scopeMemberId).filter((a) => !isLiabilityAccount(a));
  let groups;
  if (by === 'owner') {
    const owners = [{ id: 'shared', label: 'Shared', test: (a) => a.is_shared }, ...members.map((m) => ({ id: m.id, label: m.display_name, test: (a) => !a.is_shared && a.owner_member_id === m.id }))];
    const known = new Set(members.map((m) => m.id));
    owners.push({ id: 'unassigned', label: 'Unassigned', test: (a) => !a.is_shared && !known.has(a.owner_member_id) });
    groups = owners.map((g) => ({ id: g.id, label: g.label, accounts: assets.filter(g.test), showType: true }));
  } else {
    groups = TYPE_GROUPS.map((g) => ({ id: g.id, label: g.label, accounts: assets.filter((a) => g.types.includes(a.type)), showType: g.types.length > 1 }));
  }
  return groups
    .filter((g) => g.accounts.length)
    .map((g) => {
      const rows = g.accounts.map((a) => ledgerRow(a, { scopeMemberId, now, showType: g.showType }));
      return { id: g.id, label: g.label, total: total(rows), rows };
    });
}

// A card's running cycle: from the day after its last statement closed
// through the day the next one closes, counted as a statement counts
// (lib/statements.js), so it agrees with the statement it becomes. Posted
// records only, refunds netted; newest first. On the statement day itself the
// cycle closes today. In one person's view, `spent` is their part, as their
// owed figure is: their own records and half the shared ones (the fresh
// review of 5a); with no one chosen, the whole card.
export function cardCycle(account, transactions = [], now = new Date(), scopeMemberId = null) {
  if (!account?.statement_day) return null;
  const today = startOfDay(now);
  const thisMonth = atDayOfMonth(today.getFullYear(), today.getMonth(), account.statement_day);
  const next = thisMonth >= today ? thisMonth : atDayOfMonth(today.getFullYear(), today.getMonth() + 1, account.statement_day);
  const last = atDayOfMonth(next.getFullYear(), next.getMonth() - 1, account.statement_day);
  const from = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  const rows = transactions
    .filter((t) => t.account_id === account.id && isPosted(t, now))
    .filter((t) => scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)
    .filter((t) => {
      const d = parseDay(t.occurred_at);
      return d >= from && d <= next;
    })
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
  const spent = Math.round(rows.reduce((s, t) => s + spendDelta(t, scopedValue(Number(t.amount), t, scopeMemberId)), 0) * 100) / 100;
  return { from: isoDay(from), to: isoDay(next), closesIn: Math.round((next - today) / DAY_MS), transactions: rows, spent };
}

// The share of a card's limit in use, the whole card's whoever is shown. With
// a statement day it is the running cycle's spending; that is in AED, so a
// limit in another currency gives no share rather than a wrong one, and says
// why (`reason: 'currency'`), which is not the same as having no limit.
// Without one, the balance against the limit, both in the card's currency.
function limitUsed(account, cycle) {
  const limit = Number(account.credit_limit);
  if (!(limit > 0)) return null;
  const currency = String(account.currency ?? 'AED').toUpperCase();
  if (cycle) return currency === 'AED' ? { share: cycle.spent / limit, limit, currency } : { share: null, limit, currency, reason: 'currency' };
  return { share: utilisation(account), limit, currency };
}

// The cards and loans, with what is owed (positive; a card in credit is
// negative), and for a card its running cycle (the person in view's part) and
// the share of its limit used (the whole card's).
export function liabilityRows(accounts, transactions = [], { scopeMemberId = null, now = new Date() } = {}) {
  return inView(accounts, scopeMemberId)
    .filter(isLiabilityAccount)
    .map((a) => {
      const card = a.type === 'credit_card';
      const whole = card ? cardCycle(a, transactions, now) : null;
      const cycle = card && scopeMemberId !== null ? cardCycle(a, transactions, now, scopeMemberId) : whole;
      const row = ledgerRow(a, { scopeMemberId, now, showType: !card });
      return { ...row, cycle, limitUsed: card ? limitUsed(a, whole) : null };
    });
}

// When the card is next due: the latest statement's due date while it is
// still ahead, with what that statement holds (its closing balance when one
// was recorded, else what Rokda recorded over its period, when anything was:
// nothing recorded is not nothing owed); after that, the running cycle's.
// `statementRows` are lib/statements.js's.
export function paymentDue(account, statementRows = [], now = new Date()) {
  if (!account?.due_day) return null;
  const today = isoDay(startOfDay(now));
  const latest = statementRows
    .filter((r) => r.account.id === account.id)
    .sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1))[0];
  if (latest?.dueDate && latest.dueDate >= today) {
    const amount = latest.statementBalance ?? (latest.recordedSpend > 0 ? latest.recordedSpend : null);
    return { date: latest.dueDate, amount, statementTo: latest.statementDate };
  }
  const cycle = cardCycle(account, [], now);
  if (!cycle) return { date: isoDay(nextDueDate(account.due_day, now)) };
  return { date: isoDay(statementDueDate(cycle.to, account.due_day)), cycleTo: cycle.to };
}
