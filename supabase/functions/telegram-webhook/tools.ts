// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { accountValueAed, unvaluedAccounts } from "../_shared/applib/accounts.js";
import { monthActualsByCategory } from "../_shared/applib/budget.js";
import { cashCoverStatus, formatCashCoverLine } from "../_shared/applib/cashCover.js";
import { daysUntilDue, nextDueDate } from "../_shared/applib/creditCard.js";
import { householdDay, householdToday, householdYearMonth, isPosted, parseDay } from "../_shared/applib/day.js";
import { estimateAed } from "../_shared/applib/fxHistory.js";
import { allocationByClass, holdingGain, portfolioValueChange, scopedHoldingValue, visibleHoldings } from "../_shared/applib/holdings.js";
import { incompleteNote, netWorthSummary } from "../_shared/applib/overviewMath.js";
import { readAllPages } from "../_shared/applib/pagedRead.js";
import { upcomingItems } from "../_shared/applib/recurring.js";
import { scopedValue } from "../_shared/applib/scope.js";
import { isSpendRow, spendDelta } from "../_shared/applib/transactionKind.js";
import { isAwaitingFirstValuation } from "../_shared/applib/valuation.js";
import { supabase } from "./env.ts";
import { pickAccountByHint } from "./intake.ts";
import { ANSWER_HINT, normaliseSymbol } from "./trades.ts";

// ---------------------------------------------------------------------------
// SHR-240: conversational query tools. Each one queries real household data
// and returns a plain structured result -- never a phrased sentence, never a
// number the tool itself didn't compute. phraseAnswer() is the only thing
// that turns a tool result into a sentence, and it is instructed to use only
// what's in that result.
// ---------------------------------------------------------------------------

export const SCOPE_ENUM = ["me", "partner", "both"];


// update_last_expense is only offered when there's actually a recent pending
// entry to correct (see the caller) -- offering it unconditionally would
// invite the model to "correct" something that doesn't exist.
export function buildTools(hasRecentPending: boolean) {
  const tools: unknown[] = [
    {
      type: "function",
      function: {
        name: "log_expense",
        description:
          "The message reports a real expense, income, or refund that already happened (e.g. 'spent 40 on lunch', 'got paid 500'). Call this so it can be captured for review -- never estimate or state the amount yourself.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];
  if (hasRecentPending) {
    tools.push({
      type: "function",
      function: {
        name: "update_last_expense",
        description:
          "The message is explicitly correcting or amending the most recent pending entry just sent (not yet reviewed) -- e.g. 'actually it was 45 not 40', 'sorry I meant lunch', 'correction: ...'. Only use this for a clear, explicit correction signal on that specific recent entry. When in doubt, prefer log_expense instead -- a duplicate entry is caught and flagged for review anyway, but silently overwriting a different real expense is not recoverable.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    });
  }
  return [...tools, ...TOOLS_BASE];
}


export const TOOLS_BASE = [
  {
    type: "function",
    function: {
      name: "get_category_spend",
      description: "Real spend in one household expense category over a period, e.g. 'how much did we spend on groceries this month'.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "The category name as the user said it." },
          period: { type: "string", enum: ["this_month", "last_month", "this_year"] },
          scope: {
            type: "string",
            enum: SCOPE_ENUM,
            description: "Whose spend: default 'me' unless the question clearly asks about the whole household ('both') or names the other person ('partner').",
          },
        },
        required: ["category", "period"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_net_worth",
      description: "Real current net worth (accounts + holdings, minus liabilities), e.g. 'what's our net worth'.",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", enum: SCOPE_ENUM } },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_balance",
      description: "Real current balance of one specific named account or card, e.g. 'FAB Z card' or 'WIO savings'.",
      parameters: {
        type: "object",
        properties: { account_name: { type: "string" } },
        required: ["account_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_upcoming_bills",
      description: "Real recurring bills and credit-card due dates in the next 14 days, e.g. 'when's the FAB Z card due' or 'what bills are coming up'.",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", enum: SCOPE_ENUM } },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_budget_status",
      description: "Real budgeted amount vs actual spend so far this month for one category.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          scope: { type: "string", enum: SCOPE_ENUM },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_holdings",
      description:
        "Real investment/holdings data -- either the whole portfolio (total value, allocation by asset class, gain/loss) or one specific named holding (e.g. 'Apple stock', 'Bitcoin', 'HDFC mutual fund'). Use for any question about investments, stocks, crypto, mutual funds, or portfolio performance.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "A specific holding's name as the user said it, if they asked about one in particular. Omit for the whole portfolio.",
          },
          range: {
            type: "string",
            enum: ["1W", "1M", "3M", "6M", "YTD", "1Y"],
            description: "Only if asking how holdings have performed over a period, e.g. 'how are my investments doing this month'. Omit for a current snapshot.",
          },
          scope: { type: "string", enum: SCOPE_ENUM },
        },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trade_profit",
      description:
        "What a share, or every share, made from SALES in a year, from the recorded trades: realised profit, tax withheld and the number of sales (e.g. 'what did I make on ABC this year?', 'profit from selling shares in 2025'). Not the gain on shares still held: that is get_holdings.",
      parameters: {
        type: "object",
        properties: {
          stock: { type: "string", description: "The share's name or symbol, if one was named. Omit for every share." },
          year: { type: "number", description: "The calendar year asked about; omit for this year." },
          scope: { type: "string", enum: SCOPE_ENUM },
        },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_goal_contribution",
      description:
        "The message reports money being put toward a savings or debt-payoff GOAL specifically (e.g. 'put 500 toward emergency fund', 'added 1000 to the house downpayment goal', 'paid 300 extra on the car loan goal'). This is a goal-tracking entry only -- it never touches any account balance or the ledger, so never also call log_expense for the same message. If the message is just an ordinary purchase or bill with no named goal, use log_expense instead.",
      parameters: {
        type: "object",
        properties: {
          goal_name: { type: "string", description: "The goal's name as the user said it." },
          amount: { type: "number", description: "The AED amount put toward the goal." },
          occurred_at: { type: "string", description: "YYYY-MM-DD if a date is stated; omit to use today." },
        },
        required: ["goal_name", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_transfer",
      description:
        "The message reports money moved between two of the household's OWN accounts: paying the credit card from the bank account, moving money into savings, topping up one account from another (e.g. 'paid the card 3000 from current account', 'moved 5000 to savings from FAB'). A transfer is neither spending nor income, so never call log_expense for it. Not for paying someone else, a bill or a shop: that is log_expense.",
      parameters: {
        type: "object",
        properties: {
          from_account: { type: "string", description: "The account the money left, as the user named it. Omit if not stated." },
          to_account: { type: "string", description: "The account the money went into (a card being paid off counts), as the user named it. Omit if not stated." },
          amount: { type: "number", description: "The AED amount moved." },
          occurred_at: { type: "string", description: "YYYY-MM-DD if a date is stated; omit to use today." },
          note: { type: "string", description: "Anything else the message says about it, briefly. Omit if nothing." },
        },
        required: ["amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_trade",
      description:
        "The message reports buying or selling a share, fund or ETF, or a split or bonus of one (e.g. 'bought 10 ABC at 120.5', 'sold 2 ABC at 150 on 24 Oct, brokerage 1', 'Partner bought 3 XYZ at 600', 'ABC split 10 for 1'). A share bought is not spending, so never call log_expense for it. Give only what the message says; anything missing is asked for afterwards.",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["buy", "sell", "split"], description: "buy, sell, or split (a bonus issue is a split)." },
          stock: { type: "string", description: "The share's symbol or name as written, e.g. 'ABC' or 'abc.ns'." },
          units: { type: "number", description: "How many shares. Omit if not stated." },
          price: { type: "number", description: "The price per share, as stated. Omit if not stated." },
          currency: { type: "string", enum: ["USD", "INR", "AED"], description: "The price's currency, only if the message states it ('$', 'rs', 'AED'). Omit otherwise." },
          trade_date: { type: "string", description: "YYYY-MM-DD if a date is stated; a day and month with no year is in the current year. Omit for today." },
          traded_at: { type: "string", description: "ISO time of the trade if stated; omit otherwise." },
          brokerage: { type: "number", description: "Brokerage or fees, if stated." },
          tax: { type: "number", description: "Tax deducted on a sale, if stated." },
          member: { type: "string", description: "The household member whose trade it is, when the message names someone else ('Partner bought ...'); omit for the sender's own." },
          ratio: { type: "number", description: "For a split or bonus: new shares per old share, e.g. 10 for '10 for 1', 2 for a 1:1 bonus." },
        },
        required: ["side", "stock"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last_trade",
      description:
        "The member asks to undo, cancel or delete the last share trade they recorded (e.g. 'undo last trade', 'cancel that trade'). Proposes undoing it; nothing changes until they confirm.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "update_account_balances",
      description:
        "The message states the CURRENT balance of one or more accounts or cards -- a reply to the monthly balance check-in, or any 'bank balance is 10,000', 'the card owes 1,000', 'EPF 3,00,000'. Proposes those balances for the member to confirm. Never use this for a purchase or payment (that is log_expense), only for what an account holds or a card owes right now.",
      parameters: {
        type: "object",
        properties: {
          balances: {
            type: "array",
            description: "One entry per account or card named in the message.",
            items: {
              type: "object",
              properties: {
                account: { type: "string", description: "The account or card as the user named it." },
                balance: { type: "number", description: "The amount as stated, in the account's own currency. For a card or loan, the amount owed, as a positive number." },
              },
              required: ["account", "balance"],
            },
          },
        },
        required: ["balances"],
      },
    },
  },
];


// ---------------------------------------------------------------------------
// Reading what a figure is made of (docs/decisions.md, "The bot reads every
// row, and says when it cannot")
// ---------------------------------------------------------------------------
//
// A total the bot states could be wrong two ways without anyone seeing it.
// The API returns at most 1,000 rows and says nothing when it stops there, so
// a household past 1,000 transactions was summed from whichever 1,000 came
// back first, often none of this month's. And a failed read came back as no
// rows, so the bot summed nothing and said "AED 0". Every source a stated
// figure comes from is read through these instead: a page at a time in a
// stable order, and a failed read thrown as ReadFailed, so the figure is not
// stated at all rather than stated from part of the data.
export class ReadFailed extends Error {
  constructor(source: string) {
    super(`could not read ${source}`);
    this.name = "ReadFailed";
  }
}


export type PagedQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> };


// Every row the query matches. It must end in .order("id") or another unique
// column, or pages can overlap or skip a row.
export async function allRowsOf<T = Record<string, unknown>>(source: string, makeQuery: () => PagedQuery): Promise<T[]> {
  const { data, error } = await readAllPages(makeQuery as never);
  if (error) throw new ReadFailed(source);
  return (data ?? []) as T[];
}


// At most one row (a .maybeSingle() query); null when there is none, never
// when the read failed.
export async function rowOf<T = Record<string, unknown>>(source: string, query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new ReadFailed(source);
  return (data ?? null) as T | null;
}


// The first day of a month as stored, "2026-10-01". The month may run past
// 12 or below 1 and rolls into the next or previous year.
export function monthStartIso(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
}


export type SpendRow = {
  id: string;
  amount: number;
  kind: string;
  occurred_at: string;
  category_id: string | null;
  is_shared: boolean;
  owner_member_id: string | null;
  merchant: string | null;
  is_split: boolean;
  transaction_splits?: Array<{ category_id: string; amount: number }>;
};

// A split record's lines come with it, so every total by category counts each
// line under its own category (applib/splits.js).
export const SPEND_COLUMNS = "id, amount, kind, occurred_at, category_id, is_shared, owner_member_id, merchant, is_split, transaction_splits(category_id, amount)";


// A household's transactions dated from `from` up to but not including
// `until`, optionally in one category. The window is applied by the database,
// so a total for one month reads that month, not the whole history.
export function transactionsBetween(householdId: string, from: string, until: string, categoryId?: string): Promise<SpendRow[]> {
  return allRowsOf<SpendRow>("transactions", () => {
    let query = supabase.from("transactions").select(SPEND_COLUMNS).eq("household_id", householdId).gte("occurred_at", from).lt("occurred_at", until);
    // In one category: filed under it, or split with a line in it (the
    // category totals then count only that line).
    if (categoryId) query = query.or(`category_id.eq.${categoryId},is_split.eq.true`);
    return query.order("id");
  });
}


// Every row of one of the household's own tables (accounts, holdings,
// categories, bills). Each holds a handful of rows, but it is read the same
// way, so nothing depends on it staying small.
export function householdRows<T = Record<string, unknown>>(table: string, householdId: string, columns = "*", openOnly = false): Promise<T[]> {
  return allRowsOf<T>(table, () => {
    let query = supabase.from(table).select(columns).eq("household_id", householdId);
    if (openOnly) query = query.is("archived_at", null);
    return query.order("id");
  });
}


// What the bot says instead of a figure it could not read in full.
export function figuresUnavailableMessage(): string {
  return "I couldn't read all of your figures just now, so I won't guess at an answer. Please ask again in a minute.";
}


export function resolveCategoryByName(categories: Array<{ id: string; name: string }>, name: string) {
  const norm = name.trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === norm) ?? null;
}


// monthActualsByCategory is month-scoped; this sums it across whichever
// months a period actually covers rather than re-deriving the arithmetic.
export function categorySpendForPeriod(
  transactions: unknown[],
  categoryId: string,
  period: string,
  scopeMemberId: string | null,
  now: Date
): number {
  const { year, month } = householdYearMonth(now);
  if (period === "last_month") {
    const ly = month === 1 ? year - 1 : year;
    const lm = month === 1 ? 12 : month - 1;
    return monthActualsByCategory(transactions as never, ly, lm, scopeMemberId, now).get(categoryId) ?? 0;
  }
  if (period === "this_year") {
    let total = 0;
    for (let m = 1; m <= month; m++) {
      total += monthActualsByCategory(transactions as never, year, m, scopeMemberId, now).get(categoryId) ?? 0;
    }
    return total;
  }
  return monthActualsByCategory(transactions as never, year, month, scopeMemberId, now).get(categoryId) ?? 0;
}


export const round2 = (n: number) => Math.round(n * 100) / 100;


// Expense categories a question can name. Savings categories are targets,
// not spending (is_savings).
export async function spendingCategories(householdId: string): Promise<Array<{ id: string; name: string }>> {
  const categories = await householdRows<{ id: string; name: string; kind: string; archived: boolean; is_savings: boolean }>(
    "categories",
    householdId,
    "id, name, kind, archived, is_savings",
  );
  return categories.filter((c) => c.kind === "expense" && !c.archived && !c.is_savings);
}


export async function toolGetCategorySpend(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const categories = await spendingCategories(householdId);
  const cat = resolveCategoryByName(categories, String(args.category ?? ""));
  if (!cat) return { error: "category_not_found", available: categories.map((c) => c.name) };

  // Every period asked about (this month, last month, this year) falls
  // between the start of last month or of this year, whichever is earlier,
  // and the end of this month.
  const now = householdDay();
  const { year, month } = householdYearMonth(now);
  const from = month === 1 ? monthStartIso(year, 0) : monthStartIso(year, 1);
  const transactions = await transactionsBetween(householdId, from, monthStartIso(year, month + 1), cat.id);

  const spend = categorySpendForPeriod(transactions, cat.id, String(args.period ?? "this_month"), scopeMemberId, now);
  return { category: cat.name, period: args.period, spend_aed: round2(spend) };
}


export async function toolGetNetWorth(householdId: string, scopeMemberId: string | null) {
  const [accounts, holdings] = await Promise.all([householdRows("accounts", householdId), householdRows("holdings", householdId)]);
  const summary = netWorthSummary(accounts as never, scopeMemberId, holdings as never);
  // The count of accounts the total could not include travels with the
  // total. phraseAnswer is told to use only what a tool returns, so if this
  // is dropped here the bot cannot say the figure is incomplete -- and a net
  // worth quietly missing a foreign loan is the exact failure QA #4 found.
  return {
    net_worth_aed: round2(summary.netWorth),
    assets_aed: round2(summary.assets),
    liabilities_aed: round2(summary.liabilities),
    unconverted_accounts: summary.unvalued,
    unvalued_holdings: summary.unpricedHoldings,
    ...(incompleteNote({ accounts: summary.unvalued, holdings: summary.unpricedHoldings })
      ? { incomplete: incompleteNote({ accounts: summary.unvalued, holdings: summary.unpricedHoldings }) }
      : {}),
  };
}


export async function toolGetAccountBalance(householdId: string, args: Record<string, unknown>) {
  const accounts = await householdRows<{ name: string }>("accounts", householdId, "*", true);
  const norm = String(args.account_name ?? "").trim().toLowerCase();
  const matches = accounts.filter((a) => a.name.toLowerCase().includes(norm));
  if (matches.length === 0) return { error: "account_not_found", available: accounts.map((a) => a.name) };
  if (matches.length > 1) return { error: "ambiguous_account", matches: matches.map((a: { name: string }) => a.name) };
  const a = matches[0] as { name: string; balance: number; balance_aed: number | null; currency: string };
  const aed = accountValueAed(a);
  // No conversion yet: report the native balance as native rather than
  // relabelling it AED. `balance_aed ?? balance` answered "what's in the
  // India account" with "AED 20,000" when it holds 20,000 rupees (QA #4).
  if (aed === null) {
    return { account: a.name, balance: round2(Number(a.balance ?? 0)), currency: a.currency, balance_aed: null, note: "no AED conversion recorded for this account" };
  }
  return { account: a.name, balance_aed: round2(aed), currency: a.currency };
}


export async function toolGetUpcomingBills(householdId: string, scopeMemberId: string | null) {
  const [recurring, accounts] = await Promise.all([householdRows("recurring", householdId), householdRows("accounts", householdId, "*", true)]);
  // The Dubai day. new Date() here is UTC, which is still the previous day
  // until 04:00 Dubai, so a card due today read as due tomorrow and
  // yesterday's bill as still upcoming.
  const now = householdDay();
  const visibleRecurring = (recurring as Array<{ is_shared: boolean; owner_member_id: string | null }>).filter(
    (r: { is_shared: boolean; owner_member_id: string | null }) => scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId
  );
  // `amount` is always AED: for a bill in rupees or dollars the database
  // computes it from `native_amount` (the rupee rate follows households'),
  // so a premium of 89,554 rupees is never counted as 89,554 dirhams (QA #4).
  // The figure actually owed is passed alongside in its own currency.
  const bills = upcomingItems(visibleRecurring as never, 14, now).map(
    (r: { name: string; amount: number; currency: string | null; native_amount: number | null; dueDate: Date }) => {
      const isAed = String(r.currency ?? "AED").toUpperCase() === "AED";
      return {
        name: r.name,
        amount_aed: round2(Math.abs(Number(r.amount))),
        ...(isAed || r.native_amount == null ? {} : { amount: round2(Math.abs(Number(r.native_amount))), currency: r.currency }),
        due_date: r.dueDate.toISOString().slice(0, 10),
      };
    }
  );

  const cardBills: Array<{ name: string; amount_owed_aed: number; due_date: string }> = [];
  for (const a of accounts as Array<{ type: string; is_shared: boolean; owner_member_id: string | null; name: string; balance: number; balance_aed: number | null; currency: string; due_day: number | null }>) {
    if (a.type !== "credit_card") continue;
    if (!(scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId)) continue;
    // A card with no AED conversion has no AED amount owed. It is still a
    // bill, so it is still listed -- with its amount marked unknown rather
    // than with its native balance wearing an "_aed" label (QA #4).
    const aed = accountValueAed(a);
    if ((aed ?? Number(a.balance ?? 0)) <= 0) continue;
    const days = daysUntilDue(a.due_day, now);
    if (days === null || days < 0 || days > 14) continue;
    cardBills.push({
      name: a.name,
      amount_owed_aed: aed === null ? null : round2(aed),
      ...(aed === null ? { amount_owed: round2(Number(a.balance ?? 0)), currency: a.currency, note: "no AED conversion recorded" } : {}),
      due_date: nextDueDate(a.due_day, now)!.toISOString().slice(0, 10),
    } as never);
  }

  const unconverted = unvaluedAccounts(accounts as never).length;
  return {
    recurring: bills,
    credit_cards: cardBills,
    ...(unconverted > 0 ? { unconverted_accounts: unconverted } : {}),
  };
}


// Household-wide (scope=null), like /brief -- "can we cover what's due" is a
// shared question, not a personal one. Reuses toolGetUpcomingBills's 14-day
// bill list rather than re-querying recurring/credit-card rows a second
// time; cashCoverStatus narrows it down to the tighter `days` window itself.
export async function toolGetCashCover(householdId: string, days = 7) {
  const [accounts, bills] = await Promise.all([householdRows("accounts", householdId, "*", true), toolGetUpcomingBills(householdId, null)]);
  return cashCoverStatus(accounts as never, bills as never, { days, today: parseDay(householdToday()) });
}


export async function toolGetBudgetStatus(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const categories = await spendingCategories(householdId);
  const cat = resolveCategoryByName(categories, String(args.category ?? ""));
  if (!cat) return { error: "category_not_found", available: categories.map((c) => c.name) };

  const now = householdDay();
  const { year, month } = householdYearMonth(now);
  const [budgetRow, transactions] = await Promise.all([
    rowOf<{ amount: number }>(
      "budgets",
      supabase.from("budgets").select("amount").eq("household_id", householdId).eq("category_id", cat.id).eq("year", year).eq("month", month).maybeSingle(),
    ),
    transactionsBetween(householdId, monthStartIso(year, month), monthStartIso(year, month + 1), cat.id),
  ]);
  const actual = monthActualsByCategory(transactions as never, year, month, scopeMemberId, now).get(cat.id) ?? 0;
  const budgeted = budgetRow ? Number(budgetRow.amount) : null;
  return {
    category: cat.name,
    budgeted_aed: budgeted !== null ? round2(budgeted) : null,
    actual_aed: round2(actual),
    remaining_aed: budgeted !== null ? round2(budgeted - actual) : null,
    note: budgeted === null ? "No budget set for this category this month." : null,
  };
}


// Named-holding lookup uses the same "must resolve to exactly one" bar as
// account/category matching elsewhere in the bot -- a name two holdings
// share abstains rather than guessing which one. With no name, this returns
// a portfolio-level view instead: total value, allocation by asset class,
// and an invested-value-based gain (only over holdings that actually have a
// real invested figure -- see holdingGain, never a guessed cost basis).
// What a share, or every share, made from sales in a year: each sale's
// profit as the replay recorded it, the tax withheld, and its value in
// dirhams at the sale's own day's rate (a dollar at the peg). Every read is
// paged, so a failed or partial read is never summed: it throws, and the
// question is answered as unavailable.
export async function toolGetTradeProfit(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const year = Number.isInteger(Number(args.year)) && Number(args.year) > 1900 ? Number(args.year) : householdYearMonth(householdDay()).year;
  const holdings = visibleHoldings(await householdRows("holdings", householdId) as never, scopeMemberId) as Array<{
    id: string;
    name: string;
    currency: string;
    price_symbol: string | null;
  }>;
  const stock = typeof args.stock === "string" ? args.stock.trim() : "";
  let chosen = holdings;
  if (stock) {
    const wanted = normaliseSymbol(stock);
    chosen = holdings.filter((h) =>
      (h.price_symbol !== null && normaliseSymbol(h.price_symbol) === wanted) ||
      h.name.trim().toLowerCase() === stock.toLowerCase() ||
      normaliseSymbol(h.name) === wanted
    );
    if (!chosen.length) return { error: "holding_not_found", available: holdings.map((h) => h.name) };
  }
  const ids = chosen.map((h) => h.id);
  const sales = ids.length
    ? await allRowsOf<{ holding_id: string; trade_date: string; realised: number | null; tax_withheld: number | null }>("holding_trades", () =>
      supabase.from("holding_trades").select("id, holding_id, trade_date, realised, tax_withheld")
        .eq("household_id", householdId).eq("kind", "sell").in("holding_id", ids)
        .gte("trade_date", `${year}-01-01`).lt("trade_date", `${year + 1}-01-01`).order("id")
    )
    : [];
  const rupees = chosen.some((h) => h.currency === "INR");
  const history = rupees
    ? await allRowsOf("fx_rate_history", () =>
      supabase.from("fx_rate_history").select("base, quote, day, rate").eq("base", "AED").eq("quote", "INR")
        .lte("day", `${year}-12-31`).order("day")
    )
    : [];
  const household = rupees ? await rowOf<{ inr_per_aed: number | null }>("households", supabase.from("households").select("inr_per_aed").eq("id", householdId).maybeSingle()) : null;

  const rows = chosen.map((h) => {
    const own = sales.filter((t) => t.holding_id === h.id);
    // Unknown, not guessed, when a sale has no rate to value it at.
    let profitAed: number | null = 0;
    for (const t of own) {
      const value = estimateAed(Number(t.realised ?? 0), h.currency, t.trade_date, history as never, (household?.inr_per_aed ?? null) as never);
      profitAed = value && profitAed !== null ? round2(profitAed + value.aed) : null;
    }
    return {
      name: h.name,
      currency: h.currency,
      profit: round2(own.reduce((sum, t) => sum + Number(t.realised ?? 0), 0)),
      tax_withheld: round2(own.reduce((sum, t) => sum + Number(t.tax_withheld ?? 0), 0)),
      sales: own.length,
      profit_aed: profitAed,
    };
  }).filter((r) => stock || r.sales > 0);
  const totalAed = rows.every((r) => r.profit_aed !== null) ? round2(rows.reduce((sum, r) => sum + (r.profit_aed ?? 0), 0)) : null;
  return { year, holdings: rows, total_aed: totalAed };
}


export async function toolGetHoldings(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const holdings = await householdRows("holdings", householdId);
  const visible = visibleHoldings(holdings as never, scopeMemberId) as Array<{
    id: string;
    name: string;
    asset_class: string;
    quantity: number | null;
    value_aed: number;
    invested_value_aed: number | null;
    day_change_pct: number | null;
    priced_at: string | null;
    is_shared: boolean;
    owner_member_id: string | null;
  }>;

  const nameArg = typeof args.name === "string" ? args.name.trim() : "";
  if (nameArg) {
    const norm = nameArg.toLowerCase();
    const matches = visible.filter((h) => h.name.toLowerCase().includes(norm));
    if (matches.length === 0) return { error: "holding_not_found", available: visible.map((h) => h.name) };
    if (matches.length > 1) return { error: "ambiguous_holding", matches: matches.map((h) => h.name) };
    const h = matches[0];
    const gain = holdingGain(h as never, scopeMemberId);
    return {
      name: h.name,
      asset_class: h.asset_class,
      quantity: h.quantity,
      // A never-valued holding stores a placeholder 0; reporting it as a
      // value would have the bot say it is worth nothing (SHR-292).
      value_aed: isAwaitingFirstValuation(h as never) ? null : round2(scopedHoldingValue(h as never, scopeMemberId)),
      ...(isAwaitingFirstValuation(h as never) ? { note: "never valued yet" } : {}),
      day_change_pct: h.day_change_pct,
      gain_aed: gain ? round2(gain.absolute) : null,
      gain_pct: gain ? round2(gain.pct * 100) : null,
      priced_at: h.priced_at,
    };
  }

  const totalValue = visible.reduce((s, h) => s + scopedHoldingValue(h as never, scopeMemberId), 0);
  // Their placeholder 0 adds nothing to the total, which must not then read as
  // the whole portfolio -- the same note Investments shows (SHR-292).
  const unvaluedHoldings = visible.filter((h) => isAwaitingFirstValuation(h as never)).length;
  const allocation = allocationByClass(visible as never, scopeMemberId).map((a: { assetClass: string; value: number; share: number }) => ({
    asset_class: a.assetClass,
    value_aed: round2(a.value),
    share_pct: round2(a.share * 100),
  }));

  // Only holdings with a real invested_value_aed contribute to this --
  // mixing in holdings with no cost basis would silently understate the
  // gain rather than reflect an unknown one.
  let investedBasis = 0;
  let investedNowValue = 0;
  let anyInvested = false;
  for (const h of visible) {
    const gain = holdingGain(h as never, scopeMemberId);
    if (gain === null) continue;
    anyInvested = true;
    const nowValue = scopedHoldingValue(h as never, scopeMemberId);
    investedNowValue += nowValue;
    investedBasis += nowValue - gain.absolute;
  }
  const overallGain = anyInvested
    ? { gain_aed: round2(investedNowValue - investedBasis), gain_pct: investedBasis > 0 ? round2(((investedNowValue - investedBasis) / investedBasis) * 100) : null }
    : null;

  const result: Record<string, unknown> = {
    total_value_aed: round2(totalValue),
    ...(unvaluedHoldings > 0
      ? { unvalued_holdings: unvaluedHoldings, incomplete: incompleteNote({ holdings: unvaluedHoldings }) }
      : {}),
    allocation,
    overall_gain: overallGain,
  };

  const range = typeof args.range === "string" ? args.range : null;
  if (range) {
    const ids = visible.map((h) => h.id);
    // A day's value per holding: past 1,000 rows this soon after a year or
    // two of daily prices, so it is read in pages like everything else here.
    const history = ids.length
      ? await allRowsOf("holding_value_history", () =>
        supabase.from("holding_value_history").select("id, holding_id, as_of, value_aed").in("holding_id", ids).order("id")
      )
      : [];
    const change = portfolioValueChange(visible as never, history as never, range, scopeMemberId);
    result.range = range;
    // Deliberately not called "performance" any more. It moves when money is
    // added or withdrawn exactly as it moves on a price change, and
    // phraseAnswer may only use what a tool returns -- so if the caveat is not
    // in the result, the bot cannot help reporting a deposit as a gain
    // (QA #5).
    result.range_value_change = change.available
      ? {
          start_value_aed: round2(change.startTotal!),
          now_value_aed: round2(change.nowTotal),
          change_aed: round2(change.absolute!),
          change_pct: change.pct !== null ? round2(change.pct * 100) : null,
          includes_contributions: true,
          note: "Change in portfolio value. Includes money added or withdrawn during the range, so it is not investment return on its own.",
        }
      : { available: false, note: "Not enough price history to cover that range yet." };
  }

  return result;
}


// What a goal contribution in a message would record: the goal it names
// (which must resolve to exactly one, the same bar as account, category and
// holding matching elsewhere in the bot), the amount and the day. It writes
// nothing: the contribution is proposed, and recorded only on a "yes" (see
// "Proposals" in confirmations.ts). An error is phrased for the member, as
// before.
//
// Only open goals take money. A goal marked done is said to be done rather
// than missing, so the member knows to reopen it (docs/decisions.md, "A goal
// can be done, and has a plan"). A goal list that could not be read throws
// ReadFailed: it used to read as no goals at all, and the reply named none.
export async function goalContributionDraft(householdId: string, args: Record<string, unknown>) {
  const goals = await householdRows<{ id: string; name: string; done_at: string | null }>("goals", householdId, "id, name, done_at");
  const open = goals.filter((g) => g.done_at == null);
  const norm = String(args.goal_name ?? "").trim().toLowerCase();
  const matches = open.filter((g) => g.name.toLowerCase().includes(norm));
  if (matches.length === 0) {
    const done = goals.filter((g) => g.done_at != null && g.name.toLowerCase().includes(norm));
    if (done.length > 0) return { error: "goal_done", goals: done.map((g) => g.name), note: "Marked done in Rokda. Reopen it on Goals to add to it." };
    return { error: "goal_not_found", available: open.map((g) => g.name) };
  }
  if (matches.length > 1) return { error: "ambiguous_goal", matches: matches.map((g) => g.name) };

  const amount = Number(args.amount);
  if (!amount || amount <= 0) return { error: "invalid_amount" };
  const occurredAt = typeof args.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.occurred_at) ? args.occurred_at : householdToday();
  const goal = matches[0] as { id: string; name: string };
  return { goal, amount: round2(amount), occurredAt };
}


// A transfer between two of the household's own accounts (docs/decisions.md,
// "The bot records transfers"). Both accounts are matched the way a card
// named in an expense is (pickAccountByHint), and only when each names
// exactly one open account: a transfer is never recorded against a guess.
// The amount is AED, as every record's is.
export function transferDraftFrom(accounts: Array<{ id: string; name: string }>, args: Record<string, unknown>, today: string) {
  const available = accounts.map((a) => a.name);
  const fromHint = String(args.from_account ?? "").trim();
  const toHint = String(args.to_account ?? "").trim();
  const from = fromHint ? pickAccountByHint(accounts, fromHint) : null;
  const to = toHint ? pickAccountByHint(accounts, toHint) : null;
  if (!from) return { error: fromHint ? "from_account_not_found" : "from_account_missing", said: fromHint || null, available };
  if (!to) return { error: toHint ? "to_account_not_found" : "to_account_missing", said: toHint || null, available };
  if (from.id === to.id) return { error: "same_account", account: from.name };
  // The model sometimes signs the money leaving; the size is what is moved.
  const amount = Math.abs(Number(args.amount));
  if (!amount) return { error: "invalid_amount" };
  const occurredAt = typeof args.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.occurred_at) ? args.occurred_at : today;
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, 200) : null;
  return { from, to, amount: round2(amount), occurredAt, note };
}


export async function transferDraft(householdId: string, args: Record<string, unknown>) {
  const { data: accounts } = await supabase.from("accounts").select("id, name").eq("household_id", householdId).is("archived_at", null);
  return transferDraftFrom((accounts ?? []) as Array<{ id: string; name: string }>, args, householdToday());
}


// The question a transfer proposal asks, in exact figures.
export function transferPrompt(draft: { from: { name: string }; to: { name: string }; amount: number; occurredAt: string }): string {
  return `Record a transfer of AED ${draft.amount.toFixed(2)} from ${draft.from.name} to ${draft.to.name}, dated ${draft.occurredAt}? It counts as neither spending nor income. If either side is already in Rokda (the payment pasted from your bank's SMS, say), it becomes that side rather than a second copy. Nothing is recorded until you say yes.\n\n${ANSWER_HINT}`;
}


// ---------------------------------------------------------------------------
// /brief digest -- deterministic, template-built from the same real tools
// above rather than another LLM call: cheaper, and there's no room for a
// phrasing pass to drift from the actual numbers on something meant to be
// glanced at daily. Household-wide (scope=null) rather than "me", since the
// point is a shared status check, not a personal one.
// ---------------------------------------------------------------------------

export const BRIEF_TRIGGERS = new Set(["brief", "/brief", "digest", "/digest", "summary", "daily brief"]);


// Total spend for a given month across every category combined -- the tools
// above only ever total one category at a time, so this reuses the same
// scope/posted-only rules by hand rather than looping every category through
// monthActualsByCategory. Takes an explicit year/month (rather than always
// "now") so the month-end review can total the month that just ended, not
// whatever month it happens to be when the check runs.
export async function toolGetMonthSpendTotalFor(householdId: string, year: number, month: number, scopeMemberId: string | null): Promise<number> {
  const transactions = await transactionsBetween(householdId, monthStartIso(year, month), monthStartIso(year, month + 1));
  const now = householdDay();
  let total = 0;
  for (const t of transactions) {
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) continue;
    if (!isPosted(t, now)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (!isSpendRow(t, v)) continue;
    total += spendDelta(t, v);
  }
  return round2(total);
}


export async function toolGetMonthSpendTotal(householdId: string, scopeMemberId: string | null): Promise<number> {
  const { year, month } = householdYearMonth(new Date());
  return toolGetMonthSpendTotalFor(householdId, year, month, scopeMemberId);
}


// Every category with a budget set this month that's at or over 90% used --
// the same threshold the frontend budget bars treat as "watch this".
export async function toolGetBudgetAlerts(householdId: string, scopeMemberId: string | null): Promise<Array<{ category: string; pct: number }>> {
  const now = householdDay();
  const { year, month } = householdYearMonth(now);
  const [budgetRows, categories, transactions] = await Promise.all([
    allRowsOf<{ category_id: string; amount: number }>("budgets", () =>
      supabase.from("budgets").select("id, category_id, amount").eq("household_id", householdId).eq("year", year).eq("month", month).order("id")
    ),
    householdRows<{ id: string; name: string }>("categories", householdId, "id, name"),
    transactionsBetween(householdId, monthStartIso(year, month), monthStartIso(year, month + 1)),
  ]);
  const actualsMap = monthActualsByCategory(transactions as never, year, month, scopeMemberId, now);
  const alerts: Array<{ category: string; pct: number }> = [];
  for (const b of budgetRows) {
    const budgeted = Number(b.amount);
    if (budgeted <= 0) continue;
    const cat = categories.find((c) => c.id === b.category_id);
    if (!cat) continue;
    const actual = actualsMap.get(b.category_id) ?? 0;
    const pct = round2((actual / budgeted) * 100);
    if (pct >= 90) alerts.push({ category: cat.name, pct });
  }
  return alerts.sort((a, b) => b.pct - a.pct);
}


// A part of a brief whose figures could not all be read: its line says so,
// and the rest of the brief is sent as usual. Anything other than a failed
// read still fails the brief, as before.
export const NOT_READ = Symbol("not read");

export async function orNotRead<T>(work: Promise<T>): Promise<T | typeof NOT_READ> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof ReadFailed) return NOT_READ;
    throw err;
  }
}


export async function buildBriefMessage(householdId: string): Promise<string> {
  const [netWorth, monthSpend, bills, budgetAlerts, cashCover, pendingCount] = await Promise.all([
    orNotRead(toolGetNetWorth(householdId, null)),
    orNotRead(toolGetMonthSpendTotal(householdId, null)),
    orNotRead(toolGetUpcomingBills(householdId, null)),
    orNotRead(toolGetBudgetAlerts(householdId, null)),
    orNotRead(toolGetCashCover(householdId)),
    orNotRead(
      (async () => {
        const { count, error } = await supabase.from("intake").select("id", { count: "exact", head: true }).eq("household_id", householdId).eq("status", "pending");
        if (error) throw new ReadFailed("intake");
        return count ?? 0;
      })(),
    ),
  ]);

  const lines: string[] = [];
  // The incompleteness rides on the same line as the figure it qualifies --
  // a separate footnote at the bottom of a digest is a footnote nobody reads
  // (QA #4).
  lines.push(
    netWorth === NOT_READ
      ? "Net worth: couldn't be read just now."
      : `Net worth: AED ${netWorth.net_worth_aed.toLocaleString()}${netWorth.incomplete ? ` (${netWorth.incomplete})` : ""}`
  );
  lines.push(monthSpend === NOT_READ ? "Spent this month: couldn't be read just now." : `Spent this month: AED ${monthSpend.toLocaleString()}`);

  if (bills === NOT_READ) {
    lines.push("Bills due: couldn't be read just now.");
  } else {
    const billLines = [
      ...bills.recurring.map((r: { name: string; amount_aed: number; due_date: string }) => `${r.name} AED ${r.amount_aed} (${r.due_date})`),
      ...bills.credit_cards.map((c: { name: string; amount_owed_aed: number | null; amount_owed?: number; currency?: string; due_date: string }) =>
        c.amount_owed_aed === null
          ? `${c.name} ${c.currency} ${c.amount_owed} not converted (${c.due_date})`
          : `${c.name} AED ${c.amount_owed_aed} (${c.due_date})`
      ),
    ];
    lines.push(billLines.length ? `Due in 14 days: ${billLines.join(", ")}` : "Nothing due in the next 14 days.");
  }

  if (budgetAlerts === NOT_READ) {
    lines.push("Budget watch: couldn't be read just now.");
  } else if (budgetAlerts.length) {
    lines.push(`Budget watch: ${budgetAlerts.map((a) => `${a.category} ${a.pct}%`).join(", ")}`);
  }

  lines.push(cashCover === NOT_READ ? "Cash cover: couldn't be read just now." : formatCashCoverLine(cashCover));

  if (pendingCount === NOT_READ) lines.push("Inbox: couldn't be read just now.");
  else lines.push(pendingCount ? `Inbox: ${pendingCount} item${pendingCount === 1 ? "" : "s"} to review.` : "Inbox is clear.");

  return lines.join("\n");
}


// Fires once, right after a month closes (see runMonthlyBriefCheck), summing
// up the month that just ended rather than "this month" -- by the time this
// runs, householdYearMonth(now) already names the new month.
export async function buildMonthlyReviewMessage(householdId: string, year: number, month: number): Promise<string> {
  const [netWorth, monthSpend, cashCover] = await Promise.all([
    orNotRead(toolGetNetWorth(householdId, null)),
    orNotRead(toolGetMonthSpendTotalFor(householdId, year, month, null)),
    orNotRead(toolGetCashCover(householdId)),
  ]);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const lines: string[] = [
    `${monthLabel} in review:`,
    monthSpend === NOT_READ ? "Spent: couldn't be read just now." : `Spent: AED ${monthSpend.toLocaleString()}`,
    netWorth === NOT_READ
      ? "Net worth now: couldn't be read just now."
      : `Net worth now: AED ${netWorth.net_worth_aed.toLocaleString()}${netWorth.incomplete ? ` (${netWorth.incomplete})` : ""}`,
    cashCover === NOT_READ ? "Cash cover: couldn't be read just now." : formatCashCoverLine(cashCover),
  ];
  return lines.join("\n");
}
