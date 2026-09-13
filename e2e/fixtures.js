// A synthetic household, served to the browser in place of Supabase.
//
// These tests must never point at the real project: the ledger is one
// household's actual money, and a test that writes is a test that can lose it.
// Instead every PostgREST call is intercepted and answered from here, so the
// real React app, real CSS and real layout run against data we control.
//
// Column names are taken from the live schema rather than invented. A fixture
// missing a column the UI reads renders as a blank or a NaN and looks exactly
// like a layout bug, which would make this suite worse than useless -- it would
// manufacture findings.

const HH = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const PARTNER = '22222222-2222-4222-8222-333333333333';
const USER = '33333333-3333-4333-8333-333333333333';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const dayThisMonth = (day) => iso(new Date(now.getFullYear(), now.getMonth(), day));
const monthsAgo = (n) => iso(new Date(now.getFullYear(), now.getMonth() - n, 15));
const ts = (d) => `${d}T09:00:00+00:00`;

const acc = (id, name, type, extra = {}) => ({
  id, household_id: HH, owner_member_id: null, name, type, currency: 'AED',
  balance: 0, is_shared: true, created_at: ts(monthsAgo(6)), updated_at: ts(monthsAgo(1)),
  credit_limit: null, statement_day: null, due_day: null, principal: null,
  interest_rate_pct: null, compounding: null, opened_date: null, maturity_date: null,
  fd_status: 'active', balance_aed: null, archived_at: null, closing_note: null,
  balance_as_of: ts(dayThisMonth(1)), ...extra,
});

const cat = (id, name, kind) => ({
  id, household_id: HH, name, kind, parent_id: null, created_at: ts(monthsAgo(6)), archived: false,
});

const txn = (id, account_id, category_id, amount, occurred_at, extra = {}) => ({
  id, household_id: HH, account_id, owner_member_id: ME, category_id, amount,
  currency: 'AED', merchant: 'Merchant', note: null, occurred_at, is_shared: true,
  needs_review: false, created_at: ts(occurred_at), updated_at: ts(occurred_at),
  kind: 'expense', confidence: 0.9, ...extra,
});

const A_CURRENT = '44444444-4444-4444-8444-000000000001';
const A_SAVINGS = '44444444-4444-4444-8444-000000000002';
const A_CARD = '44444444-4444-4444-8444-000000000003';
const A_FD = '44444444-4444-4444-8444-000000000004';
const A_ARCHIVED = '44444444-4444-4444-8444-000000000005';

const C_GROCERIES = '55555555-5555-4555-8555-000000000001';
const C_RENT = '55555555-5555-4555-8555-000000000002';
const C_SALARY = '55555555-5555-4555-8555-000000000003';
const C_DINING = '55555555-5555-4555-8555-000000000004';

const H_STOCK = '66666666-6666-4666-8666-000000000001';
const H_GOLD = '66666666-6666-4666-8666-000000000002';

export const data = {
  households: [{
    id: HH, name: 'Test household', created_at: ts(monthsAgo(6)),
    inr_per_aed: 23.5, inr_rate_set_at: ts(dayThisMonth(1)), inr_rate_source: 'auto',
  }],

  household_members: [
    { id: ME, household_id: HH, user_id: USER, display_name: 'Alex', role: 'owner', created_at: ts(monthsAgo(6)), telegram_user_id: 123456, telegram_link_code: null, telegram_link_code_expires_at: null, telegram_last_question: null, telegram_last_answer: null, telegram_last_context_at: null },
    { id: PARTNER, household_id: HH, user_id: null, display_name: 'Sam', role: 'member', created_at: ts(monthsAgo(6)), telegram_user_id: null, telegram_link_code: null, telegram_link_code_expires_at: null, telegram_last_question: null, telegram_last_answer: null, telegram_last_context_at: null },
  ],

  accounts: [
    acc(A_CURRENT, 'Current account', 'checking', { balance: 24500.5, balance_aed: 24500.5 }),
    acc(A_SAVINGS, 'Savings', 'savings', { balance: 80000, balance_aed: 80000 }),
    // Statement day 10 and a limit, so the card panel renders a real cycle.
    acc(A_CARD, 'Platinum card', 'credit_card', { balance: 3200.75, balance_aed: 3200.75, credit_limit: 25000, statement_day: 10, due_day: 25 }),
    acc(A_FD, 'Term deposit', 'fd', { balance: 10600, balance_aed: 10600, principal: 10000, interest_rate_pct: 6, compounding: 'simple', opened_date: monthsAgo(12), maturity_date: dayThisMonth(28), balance_as_of: null }),
    // An unconfirmed balance and an archived account: both are states the UI
    // is meant to render differently, and both are easy to get wrong.
    acc(A_ARCHIVED, 'Old account', 'checking', { balance: 0, archived_at: ts(monthsAgo(2)), closing_note: 'Closed' }),
  ],

  categories: [cat(C_GROCERIES, 'Groceries', 'expense'), cat(C_RENT, 'Rent', 'expense'), cat(C_SALARY, 'Salary', 'income'), cat(C_DINING, 'Dining out', 'expense')],

  transactions: [
    txn('77777777-0000-4000-8000-000000000001', A_CURRENT, C_SALARY, 18000, dayThisMonth(1), { kind: 'income', merchant: 'Employer' }),
    txn('77777777-0000-4000-8000-000000000002', A_CURRENT, C_RENT, -6500, dayThisMonth(2), { merchant: 'Landlord' }),
    txn('77777777-0000-4000-8000-000000000003', A_CARD, C_GROCERIES, -412.4, dayThisMonth(11), { merchant: 'Spinneys' }),
    txn('77777777-0000-4000-8000-000000000004', A_CARD, C_DINING, -220, dayThisMonth(12), { merchant: 'Restaurant with a very long merchant name that should not break the layout' }),
    // A refund, which nets against spend rather than counting as income.
    txn('77777777-0000-4000-8000-000000000005', A_CARD, C_GROCERIES, 60, dayThisMonth(12), { kind: 'refund', merchant: 'Spinneys' }),
    // Needs review: drives the Overview attention list.
    txn('77777777-0000-4000-8000-000000000006', A_CURRENT, null, -95.25, dayThisMonth(13), { needs_review: true, merchant: 'Unknown', confidence: 0.3 }),
    txn('77777777-0000-4000-8000-000000000007', A_CURRENT, C_GROCERIES, -300, monthsAgo(1), { merchant: 'Carrefour' }),
    txn('77777777-0000-4000-8000-000000000008', A_CURRENT, C_GROCERIES, -280, monthsAgo(2), { merchant: 'Carrefour' }),
  ],

  recurring: [
    { id: '88888888-0000-4000-8000-000000000001', household_id: HH, name: 'Rent', account_id: A_CURRENT, category_id: C_RENT, owner_member_id: null, is_shared: true, amount: -6500, currency: 'AED', cadence: 'monthly', next_due_date: dayThisMonth(28), autopay: false, is_fixed: true, active: true, created_at: ts(monthsAgo(6)), updated_at: ts(monthsAgo(1)), interval_count: 1 },
    { id: '88888888-0000-4000-8000-000000000002', household_id: HH, name: 'Streaming', account_id: A_CARD, category_id: C_DINING, owner_member_id: ME, is_shared: false, amount: -55, currency: 'AED', cadence: 'monthly', next_due_date: dayThisMonth(20), autopay: true, is_fixed: true, active: true, created_at: ts(monthsAgo(6)), updated_at: ts(monthsAgo(1)), interval_count: 1 },
  ],

  budgets: [
    { id: '99999999-0000-4000-8000-000000000001', household_id: HH, category_id: C_GROCERIES, year: now.getFullYear(), month: now.getMonth() + 1, amount: 2000, created_at: ts(monthsAgo(1)), updated_at: ts(monthsAgo(1)), alerts_enabled: true },
    { id: '99999999-0000-4000-8000-000000000002', household_id: HH, category_id: C_DINING, year: now.getFullYear(), month: now.getMonth() + 1, amount: 150, created_at: ts(monthsAgo(1)), updated_at: ts(monthsAgo(1)), alerts_enabled: true },
  ],

  intake: [{
    id: 'aaaaaaaa-0000-4000-8000-000000000001', household_id: HH, source: 'telegram',
    raw_text: 'spent 45 on coffee', parsed_amount: 45, parsed_merchant: 'Coffee shop',
    parsed_category_id: C_DINING, parsed_date: dayThisMonth(13), confidence: 0.8,
    status: 'pending', created_at: ts(dayThisMonth(13)), member_id: ME, source_ref: 'tg:1',
    photo_path: null, transaction_id: null, parsed_currency: 'AED', parsed_account_id: A_CARD,
  }],

  holdings: [
    { id: H_STOCK, household_id: HH, owner_member_id: null, is_shared: true, name: 'Index fund', asset_class: 'equity', currency: 'USD', value_aed: 45000, last_refreshed: ts(dayThisMonth(13)), created_at: ts(monthsAgo(6)), updated_at: ts(dayThisMonth(13)), quantity: 100, avg_price: 100, current_price: 122.5, invested_value_aed: 36700, day_change_pct: 1.2, price_symbol: 'VOO', price_provider: 'stub', price_fetch_error: null, price_fetch_fail_count: 0, priced_at: ts(dayThisMonth(13)) },
    { id: H_GOLD, household_id: HH, owner_member_id: ME, is_shared: false, name: 'Gold', asset_class: 'commodity', currency: 'AED', value_aed: 12000, last_refreshed: ts(dayThisMonth(13)), created_at: ts(monthsAgo(6)), updated_at: ts(dayThisMonth(13)), quantity: 50, avg_price: 220, current_price: 240, invested_value_aed: 11000, day_change_pct: -0.4, price_symbol: 'XAU', price_provider: 'stub', price_fetch_error: null, price_fetch_fail_count: 0, priced_at: ts(dayThisMonth(13)) },
  ],

  holding_value_history: [
    { id: 'bbbbbbbb-0000-4000-8000-000000000001', holding_id: H_STOCK, as_of: monthsAgo(2), value_aed: 41000 },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', holding_id: H_STOCK, as_of: monthsAgo(1), value_aed: 43000 },
    { id: 'bbbbbbbb-0000-4000-8000-000000000003', holding_id: H_STOCK, as_of: dayThisMonth(1), value_aed: 45000 },
    { id: 'bbbbbbbb-0000-4000-8000-000000000004', holding_id: H_GOLD, as_of: dayThisMonth(1), value_aed: 12000 },
  ],

  net_worth_snapshots: [
    { id: 'cccccccc-0000-4000-8000-000000000001', household_id: HH, snapshot_date: monthsAgo(2), assets: 150000, liabilities: 4000, created_at: ts(monthsAgo(2)) },
    { id: 'cccccccc-0000-4000-8000-000000000002', household_id: HH, snapshot_date: monthsAgo(1), assets: 158000, liabilities: 3500, created_at: ts(monthsAgo(1)) },
  ],

  goals: [{ id: 'dddddddd-0000-4000-8000-000000000001', household_id: HH, owner_member_id: null, is_shared: true, name: 'Emergency fund', note: null, target_amount: 100000, target_date: `${now.getFullYear() + 1}-12-31`, funding_source: 'savings', created_at: ts(monthsAgo(6)), updated_at: ts(monthsAgo(1)) }],

  goal_allocations: [{ id: 'eeeeeeee-0000-4000-8000-000000000001', household_id: HH, goal_id: 'dddddddd-0000-4000-8000-000000000001', account_id: A_SAVINGS, holding_id: null, share_pct: 100, note: null, created_at: ts(monthsAgo(3)), updated_at: ts(monthsAgo(1)) }],

  goal_contributions: [{ id: 'ffffffff-0000-4000-8000-000000000001', goal_id: 'dddddddd-0000-4000-8000-000000000001', amount: 5000, occurred_at: monthsAgo(1), note: null, created_at: ts(monthsAgo(1)) }],

  debts: [{ id: 'a1a1a1a1-0000-4000-8000-000000000001', household_id: HH, owner_member_id: null, is_shared: true, name: 'Car loan', note: null, balance: 42000, apr_pct: 4.5, minimum_payment: 1200, custom_rank: null, created_at: ts(monthsAgo(6)), updated_at: ts(monthsAgo(1)), original_amount: 60000 }],

  planning_assumptions: [{ household_id: HH, nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4, lean_annual_spend: 90000, debt_extra_payment: 0, debt_assume_no_new_card_spend: true, baseline_set_at: ts(monthsAgo(1)), baseline_nominal_return_pct: 6, baseline_inflation_pct: 2.5, baseline_monthly_saving: 4000, updated_at: ts(monthsAgo(1)), custom_nominal_return_pct: null, custom_inflation_pct: null, custom_safe_withdrawal_pct: null, custom_updated_at: null }],

  category_rules: [{ id: 'b2b2b2b2-0000-4000-8000-000000000001', household_id: HH, category_id: C_GROCERIES, pattern: 'spinneys', match_type: 'contains', archived: false, created_at: ts(monthsAgo(3)), updated_at: ts(monthsAgo(1)) }],

  transaction_edits: [],
};

// transactions are fetched with `*, categories(id, name, kind)` embedded.
const categoryById = Object.fromEntries(data.categories.map((c) => [c.id, { id: c.id, name: c.name, kind: c.kind }]));
const EMBEDDED = {
  transactions: (row) => ({ ...row, categories: row.category_id ? categoryById[row.category_id] ?? null : null }),
  household_members: (row) => ({ ...row, households: data.households[0] }),
};

export const ids = { HH, ME, PARTNER, USER, A_CURRENT, A_CARD, A_FD, C_GROCERIES, C_DINING };

const SESSION = {
  access_token: 'e2e-access-token',
  refresh_token: 'e2e-refresh-token',
  token_type: 'bearer',
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: USER, aud: 'authenticated', role: 'authenticated', email: 'alex@example.test',
    app_metadata: { provider: 'email' }, user_metadata: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  },
};

/**
 * Answer every Supabase call from the fixtures above, and pre-seed a session so
 * ProtectedRoute lets the app through. Pass `{ empty: true }` for the
 * never-used-it state, which is a real screen the app has to render and the
 * one most likely to have been written blind.
 */
export async function stubSupabase(page, { empty = false, tables = {} } = {}) {
  const dataset = empty
    ? Object.fromEntries(Object.keys(data).map((k) => [k, k === 'households' || k === 'household_members' ? data[k] : []]))
    : { ...data, ...tables };

  await page.addInitScript((session) => {
    // supabase-js reads the session from storage before its first request.
    localStorage.setItem('rokda:keep-signed-in', 'true');
    localStorage.setItem('sb-e2e-auth-token', JSON.stringify(session));
  }, SESSION);

  // Web fonts are stubbed rather than fetched. Otherwise the suite needs
  // internet access to pass, and fails with a console error in any sandbox
  // whose egress is restricted -- a failure about the network, dressed up as a
  // failure about the app. Layout is measured in fallback fonts as a result,
  // so this suite is for structure and overflow, not letter-exact spacing.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  await page.route('**/auth/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/logout')) return route.fulfill({ status: 204, body: '' });
    if (url.includes('/user')) return route.fulfill({ json: SESSION.user });
    return route.fulfill({ json: SESSION });
  });

  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rest = url.pathname.split('/rest/v1/')[1] ?? '';
    const wantsObject = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object+json');

    if (rest.startsWith('rpc/')) return route.fulfill({ json: null });

    // Writes: acknowledge without persisting. These tests are about rendering,
    // and a stub that pretended to persist would invite tests that assert on a
    // lie. Nothing here is asserted after a write.
    if (request.method() !== 'GET') {
      return route.fulfill({ status: 200, json: wantsObject ? {} : [] });
    }

    const table = rest.split('?')[0];
    const rows = (dataset[table] ?? []).map(EMBEDDED[table] ?? ((r) => r));
    if (wantsObject) return route.fulfill({ json: rows[0] ?? null });
    return route.fulfill({ json: rows, headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } });
  });
}
