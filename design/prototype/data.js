/* Rokda prototype — all made-up data in one file.
   Nothing here is real: names, merchants, balances and prices are invented.
   Amounts are AED unless a row says otherwise. The prototype's clock is fixed
   at `today`, so "due in 6 days" stays true whenever the file is opened. */

window.RK = window.RK || {};

RK.data = (function () {
  const today = '2026-11-14';

  const household = { name: 'Sample household', inrPerAed: 23.5, usdAed: 3.6725, rateUpdated: '2026-11-13' };

  const members = [
    { id: 'maya', name: 'Maya', initial: 'M', tone: 'a', role: 'Owner', login: true, telegram: true, born: 1990, you: true },
    { id: 'dev', name: 'Dev', initial: 'D', tone: 'b', role: 'Member', login: false, telegram: false, born: 1988 },
  ];

  /* kind: income | expense. group is the budget group. stops: ends when work stops. */
  const categories = [
    { id: 'salary', name: 'Salary', kind: 'income' },
    { id: 'other-income', name: 'Other income', kind: 'income' },
    { id: 'rent', name: 'Rent', group: 'Housing', kind: 'expense', stops: true },
    { id: 'utilities', name: 'Utilities', group: 'Housing', kind: 'expense' },
    { id: 'internet', name: 'Internet & phone', group: 'Housing', kind: 'expense' },
    { id: 'groceries', name: 'Groceries', group: 'Food', kind: 'expense' },
    { id: 'dining', name: 'Dining out', group: 'Food', kind: 'expense' },
    { id: 'fuel', name: 'Fuel', group: 'Transport', kind: 'expense' },
    { id: 'taxi', name: 'Taxi & tolls', group: 'Transport', kind: 'expense' },
    { id: 'loan', name: 'Car loan', group: 'Transport', kind: 'expense', stops: true },
    { id: 'shopping', name: 'Shopping', group: 'Living', kind: 'expense' },
    { id: 'health', name: 'Health', group: 'Living', kind: 'expense' },
    { id: 'subs', name: 'Subscriptions', group: 'Living', kind: 'expense' },
    { id: 'fitness', name: 'Fitness', group: 'Living', kind: 'expense', owner: 'maya' },
    { id: 'travel', name: 'Travel', group: 'Living', kind: 'expense' },
    { id: 'family', name: 'Money sent home', group: 'Family', kind: 'expense', owner: 'dev' },
    { id: 'emergency', name: 'Emergency fund', kind: 'expense', savings: true },
  ];

  /* Monthly limits. Categories without one are "outside budget". */
  const budgets = { rent: 8500, utilities: 900, internet: 600, groceries: 2400, dining: 1000, fuel: 500, taxi: 400, loan: 1200, shopping: 1000, health: 400, subs: 250, fitness: 300 };
  const savingsTarget = 8000;

  const accounts = [
    { id: 'cur', name: 'Current account', type: 'Current', owner: 'shared', ccy: 'AED', balance: 24500, confirmed: '2026-11-12' },
    { id: 'sav', name: 'Savings', type: 'Savings', owner: 'shared', ccy: 'AED', balance: 80000, confirmed: '2026-11-01' },
    { id: 'msal', name: 'Salary account', type: 'Current', owner: 'maya', ccy: 'AED', balance: 12300, confirmed: '2026-11-01' },
    { id: 'cash', name: 'Cash wallet', type: 'Cash', owner: 'shared', ccy: 'AED', balance: 600, confirmed: null },
    { id: 'fd', name: 'Fixed deposit', type: 'Fixed deposit', owner: 'shared', ccy: 'AED', balance: 50000, confirmed: '2026-11-13', matures: '2027-03-28', rate: 4.6 },
    { id: 'nre', name: 'Rupee savings', type: 'Savings', owner: 'dev', ccy: 'INR', balance: 420000, confirmed: '2026-10-02' },
    { id: 'brk', name: 'Broker funds', type: 'Broker funds', owner: 'shared', ccy: 'USD', balance: 1250, confirmed: '2026-11-10' },
    { id: 'sky', name: 'Skyline card', type: 'Credit card', owner: 'shared', ccy: 'AED', balance: -3240, confirmed: '2026-11-12', limit: 25000, statementDay: 10, dueDay: 25, last4: '0000' },
    { id: 'trv', name: 'Travel card', type: 'Credit card', owner: 'dev', ccy: 'AED', balance: -1180, confirmed: '2026-11-05', limit: 15000, statementDay: 20, dueDay: 5, last4: '0000' },
    { id: 'loan', name: 'Car loan', type: 'Loan', owner: 'shared', ccy: 'AED', balance: -42000, confirmed: '2026-11-05' },
    { id: 'old', name: 'Old savings pot', type: 'Savings', owner: 'maya', ccy: 'AED', balance: 0, confirmed: '2026-03-01', closed: true },
  ];

  /* units × price, in the holding's own currency. `stale` = last price refresh failed. */
  const holdings = [
    { id: 'gif', name: 'Global index fund', cls: 'US equity', sector: 'Spread across sectors', owner: 'shared', ccy: 'USD', units: 120, avg: 98.0, price: 121.4, day: 0.6, feed: true },
    { id: 'tech', name: 'Tech sector fund', cls: 'US equity', sector: 'Technology', owner: 'maya', ccy: 'USD', units: 40, avg: 310.0, price: 352.0, day: -0.9, feed: true },
    { id: 'gold', name: 'Gold', cls: 'Commodity', sector: null, owner: 'maya', ccy: 'AED', units: 60, avg: 280.0, price: 318.0, day: 0.2, feed: true },
    { id: 'ilc', name: 'India large-cap fund', cls: 'India equity', sector: 'Spread across sectors', owner: 'dev', ccy: 'INR', units: 6000, avg: 62.0, price: 74.0, day: 0.4, feed: true },
    { id: 'infra', name: 'Infra company', cls: 'India equity', sector: 'Infrastructure', owner: 'dev', ccy: 'INR', units: 300, avg: 410.0, price: 388.0, day: 0, feed: true, stale: '2026-11-06' },
    { id: 'sukuk', name: 'Sukuk', cls: 'Sukuk', sector: null, owner: 'shared', ccy: 'AED', units: 1, avg: 20000, price: 20000, day: 0, feed: false, valued: '2026-09-30' },
  ];
  const sold = [{ name: 'Retail company', owner: 'maya', soldOn: '2026-05-19', profit: 1840 }];
  const concentrationCap = 25;
  const prices = { lastGood: '2026-11-13T09:00', failed: true };

  /* [date, merchant, category, account, owner, amount, extra]
     amount: negative = money out. extra: { refund, transfer:{to}, review, scheduled, native:[amount, ccy], note } */
  const T = [
    // November 2026 (month in progress)
    ['2026-11-01', 'Meridian Engineering', 'salary', 'cur', 'dev', 22000],
    ['2026-11-01', 'Marina Heights Leasing', 'rent', 'cur', 'shared', -8500],
    ['2026-11-02', 'Greenleaf Market', 'groceries', 'sky', 'shared', -386],
    ['2026-11-03', 'Remit to family', 'family', 'cur', 'dev', -1277, { native: [30000, 'INR'] }],
    ['2026-11-03', 'City Fuel', 'fuel', 'sky', 'shared', -180],
    ['2026-11-04', 'Harbour Grill', 'dining', 'sky', 'shared', -245],
    ['2026-11-05', 'Car loan instalment', 'loan', 'cur', 'shared', -1200],
    ['2026-11-05', 'Streamly', 'subs', 'trv', 'maya', -55],
    ['2026-11-06', 'Greenleaf Market', 'groceries', 'sky', 'shared', -412],
    ['2026-11-07', 'MetroCab', 'taxi', 'trv', 'dev', -62],
    ['2026-11-08', 'Cedar Pharmacy', 'health', 'sky', 'shared', -134],
    ['2026-11-09', 'Orbit Electronics', 'shopping', 'sky', 'shared', -899],
    ['2026-11-10', 'Orbit Electronics', 'shopping', 'sky', 'shared', 120, { refund: true }],
    ['2026-11-10', 'Corner Bakery', 'dining', 'sky', 'shared', -48],
    ['2026-11-11', 'Greenleaf Market', 'groceries', 'sky', 'shared', -455],
    ['2026-11-11', 'Toll top-up', 'taxi', 'cur', 'shared', -100],
    ['2026-11-12', 'Harbour Grill', 'dining', 'sky', 'shared', -390],
    ['2026-11-12', 'City Fuel', 'fuel', 'sky', 'shared', -175],
    ['2026-11-13', 'The Old Spice Route Restaurant & Banquet Hall, Lakeside Towers Cluster Y Branch (Card Terminal 04)', 'dining', 'sky', 'shared', -318],
    ['2026-11-13', 'POS 4471 DXB', null, 'cur', 'shared', -95, { review: true }],
    ['2026-11-13', 'To Savings', null, 'cur', 'shared', -5000, { transfer: { to: 'sav' } }],
    ['2026-11-14', 'Greenleaf Market', 'groceries', 'sky', 'shared', -128],
    ['2026-11-14', 'Corner Bakery', 'dining', 'sky', 'shared', -36],
    ['2026-11-20', 'Bluewave Telecom', 'internet', 'cur', 'shared', -389, { scheduled: true }],
    ['2026-11-28', 'Northlight Power & Water', 'utilities', 'cur', 'shared', -780, { scheduled: true }],
    // October 2026 (ended, not yet closed)
    ['2026-10-01', 'Meridian Engineering', 'salary', 'cur', 'dev', 22000],
    ['2026-10-01', 'Marina Heights Leasing', 'rent', 'cur', 'shared', -8500],
    ['2026-10-02', 'Greenleaf Market', 'groceries', 'sky', 'shared', -420],
    ['2026-10-03', 'Remit to family', 'family', 'cur', 'dev', -1277, { native: [30000, 'INR'] }],
    ['2026-10-05', 'Car loan instalment', 'loan', 'cur', 'shared', -1200],
    ['2026-10-05', 'Streamly', 'subs', 'trv', 'maya', -55],
    ['2026-10-06', 'City Fuel', 'fuel', 'sky', 'shared', -170],
    ['2026-10-08', 'Greenleaf Market', 'groceries', 'sky', 'shared', -388],
    ['2026-10-09', 'Harbour Grill', 'dining', 'sky', 'shared', -210],
    ['2026-10-10', 'Atlas Fitness', 'fitness', 'msal', 'maya', -250],
    ['2026-10-12', 'Skyways Air', 'travel', 'trv', 'dev', -2300],
    ['2026-10-14', 'Greenleaf Market', 'groceries', 'sky', 'shared', -512],
    ['2026-10-15', 'MetroCab', 'taxi', 'trv', 'dev', -60],
    ['2026-10-16', 'Cedar Pharmacy', 'health', 'sky', 'shared', -220],
    ['2026-10-17', 'Harbour Grill', 'dining', 'sky', 'shared', -185, { dup: 'a' }],
    ['2026-10-18', 'Harbour Grill', 'dining', 'sky', 'shared', -185, { dup: 'a' }],
    ['2026-10-19', 'Orbit Electronics', 'shopping', 'sky', 'shared', -640],
    ['2026-10-20', 'Bluewave Telecom', 'internet', 'cur', 'shared', -389],
    ['2026-10-21', 'Greenleaf Market', 'groceries', 'sky', 'shared', -446],
    ['2026-10-22', 'City Fuel', 'fuel', 'sky', 'shared', -170],
    ['2026-10-23', 'POS 2210 SHJ', null, 'cur', 'shared', -140, { review: true }],
    ['2026-10-24', 'Corner Bakery', 'dining', 'sky', 'shared', -240],
    ['2026-10-26', 'Toll top-up', 'taxi', 'cur', 'shared', -130],
    ['2026-10-27', 'Greenleaf Market', 'groceries', 'sky', 'shared', -384],
    ['2026-10-28', 'Northlight Power & Water', 'utilities', 'cur', 'shared', -742],
    ['2026-10-28', 'Lumen Studio', 'salary', 'msal', 'maya', 18000],
    ['2026-10-30', 'Harbour Grill', 'dining', 'sky', 'shared', -125],
    // September 2026 (closed)
    ['2026-09-01', 'Meridian Engineering', 'salary', 'cur', 'dev', 22000],
    ['2026-09-01', 'Marina Heights Leasing', 'rent', 'cur', 'shared', -8500],
    ['2026-09-03', 'Remit to family', 'family', 'cur', 'dev', -1277, { native: [30000, 'INR'] }],
    ['2026-09-04', 'Greenleaf Market', 'groceries', 'sky', 'shared', -560],
    ['2026-09-05', 'Car loan instalment', 'loan', 'cur', 'shared', -1200],
    ['2026-09-05', 'Streamly', 'subs', 'trv', 'maya', -55],
    ['2026-09-07', 'Harbour Grill', 'dining', 'sky', 'shared', -230],
    ['2026-09-10', 'Atlas Fitness', 'fitness', 'msal', 'maya', -250],
    ['2026-09-11', 'Greenleaf Market', 'groceries', 'sky', 'shared', -610],
    ['2026-09-12', 'City Fuel', 'fuel', 'sky', 'shared', -350],
    ['2026-09-14', 'Orbit Electronics', 'shopping', 'sky', 'shared', -1450],
    ['2026-09-16', 'Corner Bakery', 'dining', 'sky', 'shared', -230],
    ['2026-09-18', 'Greenleaf Market', 'groceries', 'sky', 'shared', -540],
    ['2026-09-19', 'MetroCab', 'taxi', 'trv', 'dev', -160],
    ['2026-09-20', 'Bluewave Telecom', 'internet', 'cur', 'shared', -389],
    ['2026-09-22', 'Cedar Pharmacy', 'health', 'sky', 'shared', -90],
    ['2026-09-25', 'Greenleaf Market', 'groceries', 'sky', 'shared', -570],
    ['2026-09-26', 'Harbour Grill', 'dining', 'sky', 'shared', -230],
    ['2026-09-28', 'Northlight Power & Water', 'utilities', 'cur', 'shared', -815],
    ['2026-09-28', 'Lumen Studio', 'salary', 'msal', 'maya', 18000],
    // August 2026 (closed; the first month with records)
    ['2026-08-01', 'Meridian Engineering', 'salary', 'cur', 'dev', 22000],
    ['2026-08-01', 'Marina Heights Leasing', 'rent', 'cur', 'shared', -8500],
    ['2026-08-03', 'Remit to family', 'family', 'cur', 'dev', -1277, { native: [30000, 'INR'] }],
    ['2026-08-04', 'Greenleaf Market', 'groceries', 'sky', 'shared', -520],
    ['2026-08-05', 'Car loan instalment', 'loan', 'cur', 'shared', -1200],
    ['2026-08-05', 'Streamly', 'subs', 'trv', 'maya', -55],
    ['2026-08-08', 'Harbour Grill', 'dining', 'sky', 'shared', -310],
    ['2026-08-10', 'Atlas Fitness', 'fitness', 'msal', 'maya', -250],
    ['2026-08-11', 'Greenleaf Market', 'groceries', 'sky', 'shared', -505],
    ['2026-08-13', 'City Fuel', 'fuel', 'sky', 'shared', -365],
    ['2026-08-15', 'Corner Bakery', 'dining', 'sky', 'shared', -280],
    ['2026-08-18', 'Greenleaf Market', 'groceries', 'sky', 'shared', -515],
    ['2026-08-19', 'MetroCab', 'taxi', 'trv', 'dev', -210],
    ['2026-08-20', 'Bluewave Telecom', 'internet', 'cur', 'shared', -389],
    ['2026-08-23', 'Orbit Electronics', 'shopping', 'sky', 'shared', -380],
    ['2026-08-25', 'Greenleaf Market', 'groceries', 'sky', 'shared', -520],
    ['2026-08-27', 'Harbour Grill', 'dining', 'sky', 'shared', -290],
    ['2026-08-28', 'Northlight Power & Water', 'utilities', 'cur', 'shared', -905],
    ['2026-08-28', 'Lumen Studio', 'salary', 'msal', 'maya', 18000],
  ];
  const transactions = T.map((r, i) => Object.assign({ id: 't' + (i + 1), date: r[0], merchant: r[1], cat: r[2], account: r[3], owner: r[4], amount: r[5] }, r[6] || {}));

  /* The Money screens can step back to June. June and July have no records. */
  const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
  const closedMonths = ['2026-08', '2026-09'];

  /* status: posted | upcoming | due-soon | late | unconfirmed (autopay date passed, not confirmed) | expected | ended */
  const recurring = [
    { id: 'r1', kind: 'bill', name: 'Rent', cat: 'rent', amount: 8500, every: 'Month', next: '2026-12-01', owner: 'shared', account: 'cur', autopay: false, status: 'posted' },
    { id: 'r2', kind: 'bill', name: 'Atlas Fitness', cat: 'fitness', amount: 250, every: 'Month', next: '2026-11-10', owner: 'maya', account: 'msal', autopay: false, status: 'late' },
    { id: 'r3', kind: 'bill', name: 'Car loan instalment', cat: 'loan', amount: 1200, every: 'Month', next: '2026-12-05', owner: 'shared', account: 'cur', autopay: true, status: 'posted' },
    { id: 'r4', kind: 'bill', name: 'Streamly', cat: 'subs', amount: 55, every: 'Month', next: '2026-12-05', owner: 'maya', account: 'trv', autopay: true, status: 'posted' },
    { id: 'r5', kind: 'bill', name: 'Cloud storage', cat: 'subs', amount: 37, every: 'Month', next: '2026-11-12', owner: 'dev', account: 'trv', autopay: true, status: 'unconfirmed' },
    { id: 'r6', kind: 'bill', name: 'Bluewave Telecom', cat: 'internet', amount: 389, every: 'Month', next: '2026-11-20', owner: 'shared', account: 'cur', autopay: true, status: 'due-soon' },
    { id: 'r7', kind: 'bill', name: 'Skyline card payment', cat: null, amount: 3912, every: 'Month', next: '2026-11-25', owner: 'shared', account: 'cur', autopay: false, status: 'upcoming', card: 'sky' },
    { id: 'r8', kind: 'bill', name: 'Northlight Power & Water', cat: 'utilities', amount: 780, every: 'Month', next: '2026-11-28', owner: 'shared', account: 'cur', autopay: true, status: 'upcoming', varies: true },
    { id: 'r9', kind: 'bill', name: 'Remit to family', cat: 'family', amount: 1277, every: 'Month', next: '2026-12-03', owner: 'dev', account: 'cur', autopay: false, status: 'posted', native: [30000, 'INR'] },
    { id: 'r10', kind: 'bill', name: 'Home insurance', cat: 'health', amount: 3400, every: 'Year', next: '2026-12-09', owner: 'shared', account: 'cur', autopay: false, status: 'upcoming' },
    { id: 'r11', kind: 'income', name: 'Salary · Lumen Studio', cat: 'salary', amount: 18000, every: 'Month', next: '2026-11-28', owner: 'maya', account: 'msal', status: 'expected' },
    { id: 'r12', kind: 'income', name: 'Salary · Meridian Engineering', cat: 'salary', amount: 22000, every: 'Month', next: '2026-12-01', owner: 'dev', account: 'cur', status: 'posted' },
    { id: 'r13', kind: 'bill', name: 'Language classes', cat: 'shopping', amount: 450, every: 'Month', next: null, owner: 'maya', account: 'msal', autopay: false, status: 'ended', last: '2026-06-15' },
  ];

  /* What the bot was not sure about. conf: per-field flag with a reason when it needs a look. */
  const inbox = [
    { id: 'i1', from: 'maya', sent: '2026-11-14T09:12', via: 'text', raw: 'spent 45 on coffee', merchant: 'Coffee shop', amount: -45, date: '2026-11-14', cat: 'dining', account: 'sky', ccy: 'AED', confident: true, flags: {} },
    { id: 'i2', from: 'dev', sent: '2026-11-13T19:40', via: 'text', raw: 'Purchase of AED 212.50 at GREENLEAF MKT on card ending 0000. Avl limit AED 21,000.', merchant: 'Greenleaf Market', amount: -212.5, date: '2026-11-13', cat: 'groceries', account: 'sky', ccy: 'AED', noDate: true, flags: { date: 'Not in the message' } },
    { id: 'i3', from: 'maya', sent: '2026-11-12T13:05', via: 'photo', raw: 'Receipt photo · total 86.00', merchant: 'Unrecognised merchant', amount: -86, date: '2026-11-12', cat: null, account: 'sky', ccy: 'AED', flags: { merchant: 'Hard to read', cat: 'No rule matched' } },
    { id: 'i4', from: 'dev', sent: '2026-11-11T08:22', via: 'text', raw: 'paid 2400 rupees for train tickets', merchant: 'Train tickets', amount: -102, date: '2026-11-11', cat: 'travel', account: 'nre', ccy: 'INR', native: [2400, 'INR'], flags: { amount: 'AED estimated at the day\'s rate' } },
  ];

  /* status: to-check | waiting | mismatch | done */
  const statements = [
    { id: 's1', card: 'sky', from: '2026-10-11', to: '2026-11-10', due: '2026-11-25', recorded: 3912.45, statement: null, status: 'to-check' },
    { id: 's2', card: 'sky', from: '2026-09-11', to: '2026-10-10', due: '2026-10-25', recorded: 4120.1, statement: 4180.1, status: 'mismatch' },
    { id: 's3', card: 'sky', from: '2026-08-11', to: '2026-09-10', due: '2026-09-25', recorded: 3876.0, statement: 3876.0, status: 'done', by: 'maya', on: '2026-09-14' },
    { id: 's4', card: 'trv', from: '2026-09-21', to: '2026-10-20', due: '2026-11-05', recorded: 2415.0, statement: 2415.0, status: 'done', by: 'dev', on: '2026-10-23' },
    { id: 's5', card: 'trv', from: '2026-08-21', to: '2026-09-20', due: '2026-10-05', recorded: 215.0, statement: 215.0, status: 'done', by: 'dev', on: '2026-09-22' },
  ];

  /* Net worth at each month end (closed months) — tracked since Dec 2025. Oct is ended but not closed. */
  const netWorthHistory = [
    ['2025-12', 236400], ['2026-01', 241900], ['2026-02', 247300], ['2026-03', 251800], ['2026-04', 249600], ['2026-05', 258200],
    ['2026-06', 266900], ['2026-07', 274300], ['2026-08', 281700], ['2026-09', 289500], ['2026-10', 301200],
  ];

  /* Investments value, AED, one point a day for 180 days ending today. A smooth made-up path. */
  const investHistory = (function () {
    const out = [];
    for (let i = 0; i < 180; i++) {
      const drift = 138000 + i * 168;
      const wave = Math.sin(i / 9) * 2600 + Math.sin(i / 23 + 1) * 4100;
      out.push(Math.round(drift + wave));
    }
    return out;
  })();

  const dividends = {
    /* AED by month. received: Dec 2025 … Nov 2026. expected: Dec 2026 … Nov 2027. presumed: index of months presumed, not checked. */
    received: [310, 0, 0, 420, 0, 180, 455, 0, 0, 470, 0, 95],
    presumed: [5],
    expected: [330, 0, 190, 480, 0, 0, 495, 0, 200, 510, 0, 0],
    firstMonth: '2025-12',
    spendShare: 0.9,
    feed: { us: '2026-11-13T02:10', india: '2026-11-13T02:14', failing: null },
    needs: [{ id: 'd1', holding: 'infra', text: 'paid INR 8 a share on 3 Oct, twice its usual. Was part of it a one-off?' }],
    coming: [
      { date: '2026-12-05', holding: 'infra', amount: 102, native: [2400, 'INR'], state: 'Declared' },
      { date: '2026-12-18', holding: 'gif', amount: 116, native: [31.5, 'USD'], state: 'Earned' },
      { date: '2027-01-12', holding: 'tech', amount: 44, native: [12, 'USD'], state: 'Expected' },
    ],
    byHolding: [
      { holding: 'gif', market: 'US', rhythm: 'Quarterly', last: 116, received: 1235, expected: 1290, yieldValue: 2.4, yieldCost: 3.0, next: '2026-12-18' },
      { holding: 'tech', market: 'US', rhythm: 'Quarterly', last: 44, received: 180, expected: 195, yieldValue: 0.4, yieldCost: 0.4, next: '2027-01-12' },
      { holding: 'ilc', market: 'India', rhythm: 'Yearly', last: 310, received: 310, expected: 330, yieldValue: 1.7, yieldCost: 2.1, next: '2026-12-22' },
      { holding: 'infra', market: 'India', rhythm: 'Twice a year', last: 102, received: 205, expected: 190, yieldValue: 3.8, yieldCost: 3.6, next: '2026-12-05' },
    ],
    notPaying: [{ holding: 'gold', why: 'Pays nothing' }, { holding: 'sukuk', why: 'Not checked yet' }],
    withholding: { US: 30, India: 20.8 },
    taxYears: [
      { year: '2025–26', member: 'dev', dividends: 8400, withheld: 1747, check: 'Agrees with AIS and 26AS', checkTone: 'pos', ret: 'Filed 28 Jul', refund: 'INR 1,120 credited 5 Oct' },
      { year: '2026–27', member: 'dev', dividends: 2400, withheld: 499, check: '26AS not added', checkTone: 'warn', ret: 'Not filed', refund: null, provisional: true },
    ],
  };

  /* Planning. Figures are in today's money. */
  const plan = {
    basis: { kind: 'Your budget', spending: 17650, saving: 8000, why: 'Recorded months take over once three have ended. Two have so far.' },
    planToAge: 95, stopYear: 2046, stopSaved: true,
    scenarios: { Baseline: { ret: 6.0, after: 5.0 }, Conservative: { ret: 4.0, after: 3.0 }, Optimistic: { ret: 8.0, after: 7.0 } },
    inflation: 2.5, cashReturn: 3.0,
    spendingAfter: { Planned: 216000, Budgeted: 211800, Essentials: 168000 },
    costsAfter: 30000, otherIncome: 24000,
  };

  /* kind: soon (next 3 years, from cash) | kept | later | undated | done */
  const goals = [
    { id: 'g1', name: 'Emergency fund', kind: 'kept', target: 100000, saved: 90000, needs: 800, pace: 1100, by: '2027-12', status: 'Saving', owner: 'shared', planMonthly: 1000 },
    { id: 'g2', name: 'Car', kind: 'soon', target: 65000, saved: 0, needs: 3420, pace: 0, by: '2028-06', status: 'Plan short', tone: 'warn', owner: 'shared', planMonthly: 1500 },
    { id: 'g3', name: 'Trip home', kind: 'soon', target: 12000, saved: 6000, needs: 1500, pace: 1600, by: '2027-03', status: 'Covered', tone: 'pos', owner: 'shared', planMonthly: 1500 },
    { id: 'g4', name: 'Education fund', kind: 'later', target: 250000, saved: 0, by: '2038-09', status: 'Paid 2038', tone: 'pos', owner: 'shared' },
    { id: 'g5', name: 'Sabbatical', kind: 'undated', target: 80000, saved: 0, by: null, status: 'No date', owner: 'maya' },
    { id: 'g6', name: 'New laptop', kind: 'done', target: 6500, saved: 6500, by: '2026-07', status: 'Done', owner: 'maya' },
  ];
  const debts = [
    { id: 'b1', name: 'Car loan', owed: 42000, rate: 4.5, minimum: 1200, original: 60000, account: 'loan', owner: 'shared' },
    { id: 'b2', name: 'Appliance instalments', owed: 6000, rate: 0, minimum: 500, original: 9000, account: null, owner: 'shared' },
  ];
  const debtPlan = { order: 'Avalanche', extra: 0 };

  /* Empty on purpose: Planning → Notes shows its empty state until a note is added. */
  const notes = [];

  const rules = [
    { id: 'u1', match: 'Contains', pattern: 'greenleaf', cat: 'groceries', active: true },
    { id: 'u2', match: 'Contains', pattern: 'city fuel', cat: 'fuel', active: true },
    { id: 'u3', match: 'Starts with', pattern: 'metro', cat: 'taxi', active: true },
    { id: 'u4', match: 'Contains', pattern: 'streamly', cat: 'subs', active: false },
  ];

  const telegram = {
    morning: [
      { id: 'm1', name: 'Missed bills', when: 'When a bill\'s date passes with nothing recorded', on: true },
      { id: 'm2', name: 'Card due dates', when: 'A day or two before, and again if still owing', on: true },
      { id: 'm3', name: 'Cash cover', when: 'Once a week, if cash can\'t cover the next 7 days', on: true },
      { id: 'm4', name: 'Unusual spending', when: 'Once, when a category runs well past its usual', on: false },
      { id: 'm5', name: 'Weekly and month-end brief', when: 'Every Monday, and when a month ends', on: true },
    ],
    questions: [
      { id: 'q1', name: 'Card statements', when: 'When one closes, and 3 days before it is due', on: true },
      { id: 'q2', name: 'Dividends', when: 'When dividends are paid into a broker fund', on: true },
      { id: 'q3', name: 'Month-end balances', when: 'On the 1st, with the monthly brief', on: true },
    ],
    stats: { calls: 184, success: 98.4, days: [['2026-11-14', 6], ['2026-11-13', 9], ['2026-11-12', 4], ['2026-11-11', 7]] },
  };

  const backups = {
    dueEvery: 35,
    history: [
      { kind: 'Export', date: '2026-11-01', result: 'Passed', by: 'maya', note: 'Copied to the offline drive' },
      { kind: 'Restore drill', date: '2026-10-15', result: 'Passed', by: 'maya', note: '' },
      { kind: 'Export', date: '2026-09-28', result: 'Failed', by: 'maya', note: 'Export file was incomplete; ran it again' },
      { kind: 'Export', date: '2026-09-28', result: 'Passed', by: 'maya', note: '' },
    ],
  };

  return { today, household, members, categories, budgets, savingsTarget, accounts, holdings, sold, concentrationCap, prices, transactions, months, closedMonths, recurring, inbox, statements, netWorthHistory, investHistory, dividends, plan, goals, debts, debtPlan, notes, rules, telegram, backups };
})();
