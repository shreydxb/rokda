/* Core: state, formatting, and read-only queries over RK.data.
   Screens register themselves on RK.screens, click handlers on RK.actions,
   and input handlers on RK.inputs. Nothing here touches the DOM. */
(function () {
  const RK = window.RK;
  const D = RK.data;

  RK.state = {
    route: 'overview',
    month: D.today.slice(0, 7),   // shared by Activity, Budget and Month end (N12)
    scope: 'both',                // both | maya | dev
    currency: 'AED',              // display only
    theme: 'light',
    period: 'MTD',
    loadedAt: '14:32',
    activity: { q: '', cat: '', account: '', type: '', status: 'posted', review: false, sort: 'date', dir: 'desc', view: 'list', range: 'month' },
  };
  RK.screens = {};
  RK.actions = {};
  RK.inputs = {};

  /* ---------- formatting ---------- */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const fmt = (RK.fmt = {});
  fmt.conv = (aed) => (RK.state.currency === 'USD' ? aed / D.household.usdAed : RK.state.currency === 'INR' ? aed * D.household.inrPerAed : aed);
  fmt.num = (v, dec) => Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  /* money(aed, {plus, dec, code}) — converts to the display currency; one true minus sign. */
  fmt.money = (aed, o) => {
    o = o || {};
    const v = fmt.conv(aed);
    const r = Math.abs(v) < 0.005 ? 0 : v;
    const sign = r < 0 ? '−' : o.plus && r > 0 ? '+' : '';
    return sign + (o.code ? RK.state.currency + ' ' : '') + fmt.num(r, o.dec);
  };
  fmt.native = (v, ccy, dec) => {
    const s = Math.abs(v).toLocaleString(ccy === 'INR' ? 'en-IN' : 'en-GB', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec == null ? 2 : dec });
    return (v < 0 ? '−' : '') + ccy + ' ' + s;
  };
  fmt.pct = (v, dec) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(dec || 0) + '%';
  fmt.compact = (v) => {
    const a = Math.abs(fmt.conv(v));
    const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a));
    return (v < 0 ? '−' : '') + s;
  };
  fmt.date = (iso) => {
    if (!iso) return '—';
    const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    return d + ' ' + MON[m - 1] + (y !== +D.today.slice(0, 4) ? ' ' + y : '');
  };
  fmt.time = (iso) => fmt.date(iso) + ', ' + iso.slice(11, 16);
  fmt.month = (ym) => MON[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);
  fmt.monthShort = (ym) => MON[+ym.slice(5, 7) - 1];
  fmt.monthLong = (ym) => MONL[+ym.slice(5, 7) - 1];
  fmt.days = (iso) => Math.round((new Date(iso.slice(0, 10)) - new Date(D.today)) / 864e5);
  fmt.ago = (iso) => { const n = -fmt.days(iso); return n <= 0 ? 'today' : n + 'd ago'; };
  fmt.esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  fmt.ord = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

  /* ---------- queries ---------- */
  const q = (RK.q = {});
  q.cat = (id) => D.categories.find((c) => c.id === id);
  q.catName = (id) => (id ? (q.cat(id) || {}).name : 'Uncategorised');
  q.acc = (id) => D.accounts.find((a) => a.id === id);
  q.member = (id) => D.members.find((m) => m.id === id);
  q.ownerName = (o) => (o === 'shared' ? 'Shared' : (q.member(o) || {}).name);
  q.holding = (id) => D.holdings.find((h) => h.id === id);
  q.toAed = (v, ccy) => (ccy === 'USD' ? v * D.household.usdAed : ccy === 'INR' ? v / D.household.inrPerAed : v);
  /* The share of a row that counts in the chosen scope: shared rows split evenly. */
  q.share = (owner) => (RK.state.scope === 'both' ? 1 : owner === 'shared' ? 0.5 : owner === RK.state.scope ? 1 : 0);
  q.kind = (t) => (t.transfer ? 'transfer' : t.refund ? 'refund' : t.amount > 0 ? 'income' : 'expense');
  q.addMonth = (ym, n) => { const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  q.inMonth = (ym, includeScheduled) => D.transactions.filter((t) => t.date.slice(0, 7) === ym && (includeScheduled || !t.scheduled) && q.share(t.owner) > 0);
  q.hasData = (ym) => D.transactions.some((t) => t.date.slice(0, 7) === ym && !t.scheduled);
  q.amt = (t) => t.amount * q.share(t.owner);
  /* Income, spent (purchases less refunds) and saved for a month, in the chosen scope. */
  q.totals = (ym) => {
    let income = 0, spent = 0, count = 0;
    q.inMonth(ym).forEach((t) => {
      const k = q.kind(t);
      if (k === 'transfer') return;
      count++;
      if (k === 'income') income += q.amt(t); else spent -= q.amt(t);
    });
    return { income, spent, saved: income - spent, rate: income ? ((income - spent) / income) * 100 : 0, count };
  };
  q.byCat = (ym) => {
    const m = {};
    q.inMonth(ym).forEach((t) => { const k = q.kind(t); if (k === 'expense' || k === 'refund') m[t.cat || ''] = (m[t.cat || ''] || 0) - q.amt(t); });
    return Object.keys(m).map((id) => ({ id: id || null, name: q.catName(id || null), spent: m[id] })).sort((a, b) => b.spent - a.spent);
  };
  /* A category's usual month: the average of up to three earlier months that have records. */
  q.usual = (catId, ym) => {
    const prior = D.months.filter((m) => m < ym && q.hasData(m)).slice(-3);
    if (!prior.length) return null;
    const sum = prior.reduce((s, m) => s + ((q.byCat(m).find((c) => c.id === catId) || {}).spent || 0), 0);
    return sum / prior.length;
  };
  q.elapsed = (ym) => { const cur = D.today.slice(0, 7); return ym < cur ? 1 : ym > cur ? 0 : +D.today.slice(8, 10) / 30; };
  q.budget = (ym) => {
    const cats = q.byCat(ym);
    const spentOf = (id) => (cats.find((c) => c.id === id) || {}).spent || 0;
    const lines = Object.keys(D.budgets).map((id) => ({ id, name: q.catName(id), group: q.cat(id).group, limit: D.budgets[id], spent: spentOf(id), usual: q.usual(id, ym) }));
    const budgeted = lines.reduce((s, l) => s + l.limit, 0);
    const spentBudgeted = lines.reduce((s, l) => s + l.spent, 0);
    const total = cats.reduce((s, c) => s + c.spent, 0);
    return { lines, budgeted, spentBudgeted, outside: total - spentBudgeted, uncategorised: spentOf(null), total };
  };

  q.accAed = (a) => q.toAed(a.balance, a.ccy);
  q.holdNative = (h) => h.units * h.price;
  q.holdAed = (h) => q.toAed(h.units * h.price, h.ccy);
  q.holdCostAed = (h) => q.toAed(h.units * h.avg, h.ccy);
  q.investments = () => D.holdings.filter((h) => q.share(h.owner) > 0).reduce((s, h) => s + q.holdAed(h) * q.share(h.owner), 0);
  /* Net worth in the chosen scope. An unconfirmed balance counts as zero and makes the figure provisional. */
  q.netWorth = () => {
    let assets = 0, liabilities = 0;
    const provisional = [];
    const parts = { Cash: 0, Deposits: 0 };
    D.accounts.filter((a) => !a.closed && q.share(a.owner) > 0).forEach((a) => {
      if (!a.confirmed) { provisional.push(a); return; }
      const v = q.accAed(a) * q.share(a.owner);
      if (v < 0) liabilities -= v;
      else { assets += v; parts[a.type === 'Fixed deposit' ? 'Deposits' : 'Cash'] += v; }
    });
    D.holdings.filter((h) => q.share(h.owner) > 0).forEach((h) => { const v = q.holdAed(h) * q.share(h.owner); assets += v; parts[h.cls] = (parts[h.cls] || 0) + v; });
    const last = D.netWorthHistory[D.netWorthHistory.length - 1][1];
    const net = assets - liabilities;
    const scale = RK.state.scope === 'both' ? 1 : 0.5;
    return { assets, liabilities, net, provisional, parts, change: net - last * scale };
  };
  q.cashOnHand = () => D.accounts.filter((a) => !a.closed && a.confirmed && ['Current', 'Savings', 'Cash'].includes(a.type) && a.ccy === 'AED').reduce((s, a) => s + a.balance * q.share(a.owner), 0);

  /* ---------- planning sums (made-up arithmetic, good enough for a prototype) ---------- */
  q.householdNet = () => D.accounts.filter((a) => !a.closed && a.confirmed).reduce((s, a) => s + q.accAed(a), 0) + D.holdings.reduce((s, h) => s + q.holdAed(h), 0);
  /* The pot year by year, in today's money. Returns {years, pot, stop, end, runsOut, atStop, needed, spend}. */
  q.project = (stopYear, scenario, spendKey) => {
    const P = D.plan, sc = P.scenarios[scenario || 'Baseline'];
    const start = +D.today.slice(0, 4);
    const end = Math.max.apply(null, D.members.map((m) => m.born + P.planToAge));
    const rW = (1 + sc.ret / 100) / (1 + P.inflation / 100) - 1, rA = (1 + sc.after / 100) / (1 + P.inflation / 100) - 1;
    const spend = P.spendingAfter[spendKey || 'Planned'] + P.costsAfter - P.otherIncome;
    const later = D.goals.filter((g) => g.kind === 'later');
    let pot = q.householdNet(), runsOut = null;
    const years = [], pots = [];
    for (let y = start; y <= end; y++) {
      years.push(y); pots.push(Math.max(0, pot));
      if (pot <= 0 && y >= stopYear && runsOut == null) runsOut = y;
      pot = y < stopYear ? pot * (1 + rW) + P.basis.saving * 12 : pot * (1 + rA) - spend;
      later.forEach((g) => { if (+g.by.slice(0, 4) === y) pot -= g.target; });
    }
    const n = end - stopYear + 1;
    return { years, pot: pots, stop: stopYear, end, runsOut, atStop: pots[stopYear - start] || 0, needed: (spend * (1 - Math.pow(1 + rA, -n))) / rA, spend, left: Math.max(0, pot) };
  };
  /* The earliest stop year whose money lasts to the end of the plan. */
  q.earliestStop = (scenario, spendKey) => { const y0 = +D.today.slice(0, 4); for (let y = y0; y <= y0 + 50; y++) if (!q.project(y, scenario, spendKey).runsOut) return y; return null; };
  /* When the debts clear and what interest is still to pay, with an optional extra payment a month. */
  q.payoff = (extra) => {
    const order = D.debts.filter((b) => b.owed > 0).map((b) => Object.assign({}, b)).sort((a, b) => (D.debtPlan.order === 'Snowball' ? a.owed - b.owed : b.rate - a.rate));
    let month = D.today.slice(0, 7), interest = 0, guard = 0;
    const clears = {};
    while (order.some((b) => b.owed > 0) && guard++ < 600) {
      month = q.addMonth(month, 1);
      let spare = extra || 0;
      order.forEach((b) => {
        if (b.owed <= 0) return;
        const i = (b.owed * b.rate) / 1200; interest += i; b.owed += i;
        const pay = Math.min(b.owed, b.minimum + spare); spare = Math.max(0, spare - Math.max(0, pay - b.minimum)); b.owed -= pay;
        if (b.owed <= 0.005) { b.owed = 0; clears[b.id] = month; spare += b.minimum; }
      });
    }
    return { clears, last: month, interest, never: guard >= 600 };
  };

  q.inboxCount = () => D.inbox.length;
  q.billsDue = () => D.recurring.filter((r) => r.kind === 'bill' && ['late', 'unconfirmed'].includes(r.status));
  q.upcoming = (days) => D.recurring.filter((r) => r.next && r.status !== 'ended' && r.status !== 'posted' && fmt.days(r.next) <= days).sort((a, b) => (a.next < b.next ? -1 : 1));
  q.openMonth = () => { const prev = q.addMonth(D.today.slice(0, 7), -1); return D.closedMonths.includes(prev) ? null : prev; };
  q.dataHealth = () => {
    const out = [];
    D.accounts.filter((a) => !a.closed && !a.confirmed).forEach((a) => out.push({ text: a.name + ' · balance not confirmed', note: 'Counted as zero in net worth', action: 'open-account', id: a.id, label: 'Confirm balance' }));
    D.holdings.filter((h) => h.stale).forEach((h) => out.push({ text: h.name + ' · price is stale', note: 'Last priced ' + fmt.date(h.stale), action: 'open-holding', id: h.id, label: 'Open holding' }));
    D.holdings.filter((h) => !h.sector && h.cls !== 'Sukuk').forEach((h) => out.push({ text: h.name + ' · no sector', note: 'Counts only on its own in concentration', action: 'open-holding', id: h.id, label: 'Tag sector' }));
    D.debts.filter((b) => !b.account && b.owed > 0).forEach((b) => out.push({ text: b.name + ' · not in net worth', note: 'No account linked', action: 'open-debt', id: b.id, label: 'Link account' }));
    return out;
  };
  /* The one list of everything that needs someone (N13). Each item names its action. */
  q.todo = () => {
    const out = [];
    const cur = D.today.slice(0, 7);
    q.inMonth(cur).filter((t) => !t.cat && !t.transfer).forEach((t) => out.push({ group: 'Today', kind: 'categorise', id: t.id, title: t.merchant, status: 'Uncategorised · ' + fmt.money(t.amount) }));
    D.recurring.filter((r) => r.status === 'late').forEach((r) => out.push({ group: 'Today', title: r.name, status: 'Late · was due ' + fmt.date(r.next), tone: 'neg', action: 'mark-paid', id: r.id, label: 'Mark paid' }));
    D.recurring.filter((r) => r.status === 'unconfirmed').forEach((r) => out.push({ group: 'Today', title: r.name, status: 'Autopay not confirmed · ' + fmt.date(r.next), tone: 'warn', action: 'mark-paid', id: r.id, label: 'Mark paid' }));
    D.accounts.filter((a) => !a.closed && !a.confirmed).forEach((a) => out.push({ group: 'Today', title: a.name, status: 'Balance not confirmed', tone: 'warn', action: 'open-account', id: a.id, label: 'Confirm balance' }));
    D.dividends.needs.forEach((n) => out.push({ group: 'Today', title: q.holding(n.holding).name + ' dividend', status: 'One-off question', tone: 'warn', action: 'go', route: 'wealth/dividends', label: 'Answer' }));
    D.statements.filter((s) => s.status === 'to-check' || s.status === 'mismatch').forEach((s) => out.push({ group: 'Month end', title: q.acc(s.card).name + ' statement', status: (s.status === 'mismatch' ? 'Doesn\'t match · ' : 'To check · ') + fmt.date(s.from) + ' – ' + fmt.date(s.to), tone: s.status === 'mismatch' ? 'neg' : 'warn', action: 'go', route: 'money/monthend', label: 'Check' }));
    const open = q.openMonth();
    if (open) out.push({ group: 'Month end', title: fmt.monthLong(open), status: 'Not closed', tone: 'warn', action: 'go-month-end', month: open, label: 'Close month' });
    D.goals.filter((g) => g.tone === 'warn').forEach((g) => out.push({ group: 'Planning', title: g.name, status: 'Short of cash · ' + fmt.money(g.needs) + ' a month needed', tone: 'warn', action: 'open-goal', id: g.id, label: 'Open goal' }));
    return out;
  };
})();
