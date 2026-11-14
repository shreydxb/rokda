/* Overview (the cockpit) and Inbox. */
(function () {
  const RK = window.RK;
  const { fmt, q, ui, charts } = RK;
  const D = RK.data, S = RK.state, A = RK.actions;
  const esc = fmt.esc;

  /* ================= Overview ================= */
  const periodMonths = () => {
    const cur = D.today.slice(0, 7), y = cur.slice(0, 4), m = +cur.slice(5, 7);
    if (S.period === 'MTD') return [cur];
    const from = S.period === 'QTD' ? Math.floor((m - 1) / 3) * 3 + 1 : 1;
    return D.months.filter((x) => x.slice(0, 4) === y && +x.slice(5, 7) >= from && x <= cur);
  };
  const periodTotals = () => periodMonths().map(q.totals).reduce((a, t) => ({ income: a.income + t.income, spent: a.spent + t.spent, count: a.count + t.count }), { income: 0, spent: 0, count: 0 });

  function netWorthCard() {
    const nw = q.netWorth();
    const scale = S.scope === 'both' ? 1 : 0.5;
    const hist = D.netWorthHistory.map((h) => h[1] * scale).concat([nw.net]);
    const tips = D.netWorthHistory.map((h) => fmt.month(h[0]) + ' · ' + fmt.money(h[1] * scale)).concat(['Today · ' + fmt.money(nw.net)]);
    return ui.card({
      title: 'Net worth', right: ui.link('Net worth', 'wealth/networth'),
      body: '<div class="row" style="align-items:baseline;gap:10px"><div class="hero-fig"><span class="code">' + S.currency + '</span>' + fmt.money(nw.net) + '</div>' +
        (nw.provisional.length ? ui.chip('Provisional', 'warn', 'open-health') : '') + '</div>' +
        '<div class="kpi-s"><span class="delta ' + (nw.change >= 0 ? 'pos' : 'neg') + '">' + (nw.change >= 0 ? '▲ ' : '▼ ') + fmt.money(Math.abs(nw.change)) + '</span> this month<span class="muted">· 12 months</span></div>' +
        '<div style="margin-top:10px">' + charts.slot('ov-nw', 78, (w, h) => charts.spark(w, h, hist, tips)) + '</div>',
    });
  }

  function monthCard() {
    const t = periodTotals(), saved = t.income - t.spent, rate = t.income ? (saved / t.income) * 100 : 0;
    const cur = D.today.slice(0, 7), b = q.budget(cur), el = q.elapsed(cur);
    const pay = D.recurring.filter((r) => r.kind === 'income' && r.status === 'expected' && q.share(r.owner) > 0);
    const names = { MTD: 'This month', QTD: 'Quarter to date', YTD: 'Year to date' };
    const used = b.spentBudgeted / b.budgeted;
    return ui.card({
      title: names[S.period], right: '<span>' + t.count + ' transactions</span>' + ui.link('Budget', 'money/budget'),
      body: '<div class="kpis" style="margin:-4px -18px 0">' +
        '<div class="kpi"><div class="kpi-l">Income</div><div class="fig">' + fmt.money(t.income) + '</div>' + (S.period === 'MTD' && pay.length ? '<div class="kpi-s">+' + fmt.money(pay.reduce((s, r) => s + r.amount * q.share(r.owner), 0)) + ' expected ' + fmt.date(pay[0].next) + '</div>' : '') + '</div>' +
        '<div class="kpi"><div class="kpi-l">Spent' + ui.info('Purchases less refunds. Transfers between your own accounts count as neither income nor spending.') + '</div><div class="fig">' + fmt.money(t.spent) + '</div></div>' +
        '<div class="kpi"><div class="kpi-l">Saved</div><div class="fig ' + (saved < 0 ? 'neg' : '') + '">' + fmt.money(saved) + '</div><div class="kpi-s">' + fmt.pct(rate) + ' of income</div></div></div>' +
        (S.period === 'MTD' ? '<div style="border-top:1px solid var(--rule-soft);margin:0 -18px;padding:14px 18px 0"><div class="row between small" style="margin-bottom:8px"><span class="ink2">Budget · ' + fmt.money(b.spentBudgeted) + ' of ' + fmt.money(b.budgeted) + '</span><span class="muted">' + fmt.pct(used * 100) + ' spent · ' + fmt.pct(el * 100) + ' of month gone</span></div>' + ui.bar(used, { lg: true, tick: el, tone: used > 1 ? 'neg' : '' }) + '</div>' : ''),
    });
  }

  function todoCard() {
    const items = q.todo(), cap = 6;
    let html = '', group = '';
    (S.todoAll ? items : items.slice(0, cap)).forEach((x) => {
      if (x.group !== group) { group = x.group; html += '<div class="sub-h">' + group + '</div>'; }
      const act = x.kind === 'categorise' ? ui.catSelect(D.transactions.find((t) => t.id === x.id)) : ui.btn(x.label, x.action, { sm: true, data: { id: x.id || '', route: x.route || '', month: x.month || '' } });
      html += '<div class="rw"><span class="dot ' + (x.tone || 'muted') + '" style="color:var(--' + (x.tone === 'neg' ? 'neg' : x.tone === 'warn' ? 'warn-mark' : 'control') + ')"></span><div class="rw-main truncate"><span class="rw-t">' + esc(x.title) + '</span> <span class="rw-s">· ' + esc(x.status) + '</span></div>' + act + '</div>';
    });
    if (items.length > cap) html += '<div class="rw click small ink2" data-action="todo-all" style="min-height:38px">' + (S.todoAll ? 'Show fewer' : 'Show all ' + items.length) + '</div>';
    return ui.card({ title: 'To do', right: items.length ? items.length + ' open' : '', flush: true, body: items.length ? '<div class="rows">' + html + '</div>' : ui.empty('All clear', 'Nothing needs a decision.', '', 'check') });
  }
  A['todo-all'] = () => { S.todoAll = !S.todoAll; RK.render(); };

  function upcomingCard() {
    const up = q.upcoming(30).filter((r) => q.share(r.owner) > 0);
    const marks = up.map((r) => ({ day: fmt.days(r.next), amount: r.amount, tone: r.kind === 'income' ? 'pos' : r.status === 'late' ? 'neg' : r.status === 'unconfirmed' ? 'warn' : '', tip: fmt.date(r.next) + ' · ' + r.name + ' · ' + fmt.money(r.kind === 'income' ? r.amount : -r.amount, { plus: true }) }));
    const committed = up.filter((r) => r.kind === 'bill').reduce((s, r) => s + r.amount * q.share(r.owner), 0);
    const cash = q.cashOnHand();
    const rows = up.slice(0, 5).map((r) => '<div class="rw click" data-action="open-bill" data-id="' + r.id + '"><span class="rw-date">' + fmt.date(r.next) + '</span><div class="rw-main truncate"><span class="rw-t">' + esc(r.name) + '</span></div>' +
      (r.status === 'late' ? ui.chip('Late', 'neg') : r.status === 'unconfirmed' ? ui.chip('Not confirmed', 'warn') : '<span class="small muted">' + (r.kind === 'income' ? 'expected' : r.autopay ? 'autopay' : 'manual') + '</span>') +
      '<span class="num ' + (r.kind === 'income' ? 'pos' : '') + '" style="width:76px">' + fmt.money(r.kind === 'income' ? r.amount : -r.amount, { plus: true }) + '</span></div>').join('');
    return ui.card({
      title: 'Next 30 days', right: ui.link('Recurring', 'money/recurring'), flush: true,
      body: '<div style="padding:4px 18px 6px">' + charts.slot('ov-next', 52, (w, h) => charts.timeline(w, h, { days: 30, marks })) + '</div><div class="rows">' + rows + '</div>' +
        '<div class="rw small muted" style="min-height:38px">Committed ' + fmt.money(committed) + ' · cash on hand ' + fmt.money(cash) + '<span class="grow"></span>' + (cash >= committed ? ui.chip('Covered', 'pos') : ui.chip('Short by ' + fmt.money(committed - cash), 'neg')) + '</div>',
    });
  }

  function flowCard() {
    const cur = D.today.slice(0, 7);
    const groups = D.months.map((m) => { const t = q.totals(m); return { label: fmt.monthShort(m) + (m === cur ? ' · so far' : ''), a: t.income, b: t.spent, line: t.saved, empty: !q.hasData(m), current: m === cur, tip: q.hasData(m) ? fmt.month(m) + ' · income ' + fmt.money(t.income) + ' · spent ' + fmt.money(t.spent) + ' · saved ' + fmt.money(t.saved) : fmt.month(m) + ' · no transactions' }; });
    return ui.card({
      title: 'Income and spending · 6 months', right: ui.link('Activity', 'money/activity'),
      body: charts.slot('ov-flow', 190, (w, h) => charts.columns(w, h, { groups })) + ui.readout([['Income', null, 'var(--context)'], ['Spent', null, 'var(--accent)'], ['Saved', null, 'var(--pos)'], ['Jun and Jul have no transactions', null]]),
    });
  }

  function whereCard() {
    const cur = D.today.slice(0, 7), el = q.elapsed(cur);
    const cats = q.byCat(cur).slice(0, 5).map((c) => Object.assign(c, { usual: q.usual(c.id, cur) }));
    const max = Math.max.apply(null, cats.map((c) => Math.max(c.spent, c.usual || 0)).concat([1]));
    const moved = cats.filter((c) => c.usual && c.spent > c.usual * 1.1 && c.id);
    const list = ui.barList(cats.map((c) => ({ label: c.name, value: fmt.money(c.spent), frac: c.spent / max, tick: c.usual ? c.usual / max : null, tone: c.id ? '' : 'ctx', action: 'see-cat', data: { cat: c.id || 'none' } })));
    const changes = moved.slice(0, 3).map((c) => { const n = q.inMonth(cur).filter((t) => t.cat === c.id).length; return '<div class="rw click" style="padding:6px 0;min-height:36px" data-action="see-cat" data-cat="' + c.id + '">' + ui.chip('+' + Math.round((c.spent / c.usual - 1) * 100) + '% vs usual', 'warn') + '<div class="rw-main truncate small"><b style="font-weight:500">' + esc(c.name) + '</b> <span class="muted">· ' + n + ' transactions, ' + fmt.pct(el * 100) + ' into the month</span></div><span class="muted">→</span></div>'; }).join('');
    return ui.card({
      title: 'Where it went', info: 'Top five categories this month, before refunds are spread. The tick on each bar marks that category\'s usual month: the average of up to three earlier months.', right: ui.link('Budget', 'money/budget'),
      body: (cats.length ? list : '<div class="muted small">No spending this month.</div>') + (changes ? '<div class="sub-h" style="padding:16px 0 2px">What changed</div>' + changes : ''),
    });
  }

  function planStrip() {
    const P = D.plan, base = q.project(P.stopYear, 'Baseline'), cons = q.project(P.stopYear, 'Conservative');
    const verdict = (name, r) => ui.chip(name + ': ' + (r.runsOut ? 'runs out ' + r.runsOut : 'lasts to ' + r.end), r.runsOut ? 'neg' : 'pos');
    const soon = D.goals.filter((g) => g.kind === 'soon'), sSaved = soon.reduce((s, g) => s + g.saved, 0), sTarget = soon.reduce((s, g) => s + g.target, 0);
    const owed = D.debts.reduce((s, b) => s + b.owed, 0), pay = q.payoff(D.debtPlan.extra);
    const ended = D.months.filter((m) => m < D.today.slice(0, 7) && q.hasData(m)), avg = ended.reduce((s, m) => s + q.totals(m).spent, 0) / (ended.length || 1);
    const cash = q.cashOnHand(), kept = D.goals.filter((g) => g.kind === 'kept').reduce((s, g) => s + g.saved, 0);
    const tile = (label, route, fig, sub) => '<div class="kpi click" data-action="go" data-route="' + route + '" style="cursor:pointer"><div class="kpi-l">' + label + '<span class="grow"></span><span class="muted">→</span></div><div class="fig">' + fig + '</div><div class="kpi-s">' + sub + '</div></div>';
    return ui.card({
      title: 'Plan', flush: true,
      body: '<div class="kpis">' +
        tile('Stop working', 'planning/plan', P.stopYear, verdict('Baseline', base) + verdict('Conservative', cons)) +
        tile('Goals · next 3 years', 'planning/goals', fmt.money(sSaved) + ' <span class="muted" style="font-size:13px;font-weight:400">of ' + fmt.money(sTarget) + '</span>', '<div style="width:100%;margin-top:4px">' + ui.bar(sSaved / sTarget) + '</div>') +
        tile('Debts', 'planning/goals', fmt.money(-owed), 'Clears ' + fmt.month(pay.last) + (D.debts.some((b) => !b.account) ? ui.chip('Not all in net worth', 'warn') : '')) +
        tile('Cash reserve', 'planning/goals', (cash / avg).toFixed(1) + ' <span class="muted" style="font-size:13px;font-weight:400">months of spending</span>', cash >= kept ? ui.chip('Covers kept goals', 'pos') : ui.chip('Short of kept goals', 'warn')) + '</div>',
    });
  }

  function recentCard() {
    const rows = D.transactions.filter((t) => !t.scheduled && q.share(t.owner) > 0).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
    return ui.card({
      title: 'Recent', right: ui.link('Activity', 'money/activity'), flush: true,
      body: ui.table({ compact: true, cols: [{ label: 'Date', width: '84px' }, { label: 'Merchant' }, { label: 'Category', width: '200px' }, { label: 'Account', width: '170px' }, { label: 'Amount', num: true, width: '110px' }],
        rows: rows.map((t) => ({ action: 'open-txn', data: { id: t.id }, cells: ['<span class="mono muted">' + fmt.date(t.date) + '</span>', '<div class="truncate" style="max-width:420px" title="' + esc(t.merchant) + '"><span class="name">' + esc(t.merchant) + '</span></div>', t.transfer ? '<span class="muted">Transfer</span>' : t.cat ? esc(q.catName(t.cat)) : ui.chip('Uncategorised', 'warn'), '<span class="ink2">' + esc(q.acc(t.account).name) + '</span>', '<span class="' + (t.amount > 0 ? 'pos' : '') + '">' + fmt.money(q.amt(t), { plus: true }) + '</span>'] })) }),
    });
  }

  A['see-cat'] = (el) => { S.activity.cat = el.dataset.cat; S.month = D.today.slice(0, 7); RK.go('money/activity'); };

  RK.screens.overview = {
    kicker: () => { const d = new Date(D.today); const n = q.dataHealth().length; return d.toLocaleDateString('en-GB', { weekday: 'long' }) + ' ' + fmt.date(D.today) + (n ? ui.chip('Data: ' + n + ' to check', 'warn', 'open-health') : ui.chip('Data: all clear', 'pos')); },
    title: () => { const n = q.todo().length; return n ? n + ' thing' + (n === 1 ? ' needs' : 's need') + ' a decision' : 'All clear'; },
    tools: () => ui.seg('set-period', [['MTD', 'Month'], ['QTD', 'Quarter'], ['YTD', 'Year']], S.period) + ui.btn('Transaction', 'open-txn', { kind: 'primary', icon: 'plus' }),
    render: () =>
      '<div class="grid stretch"><div class="c-5 stack-v">' + netWorthCard() + '</div><div class="c-7 stack-v">' + monthCard() + '</div></div>' +
      '<div class="grid"><div class="c-7">' + todoCard() + '</div><div class="c-5">' + upcomingCard() + '</div></div>' +
      '<div class="grid"><div class="c-7">' + flowCard() + '</div><div class="c-5">' + whereCard() + '</div></div>' +
      planStrip() + recentCard(),
  };

  /* ================= Inbox ================= */
  const sel = () => D.inbox.find((x) => x.id === S.inboxSel) || D.inbox[0];
  const needsCheck = (it) => Object.keys(it.flags).length > 0;

  function queue(cur) {
    return '<div class="rows">' + D.inbox.map((it) => '<div class="rw click' + (cur && it.id === cur.id ? ' sel' : '') + '" data-action="inbox-pick" data-id="' + it.id + '"><span class="tag">' + it.via + '</span><div class="rw-main"><div class="row between"><span class="rw-t truncate">' + esc(it.merchant) + '</span><span class="num small">' + (it.native ? fmt.native(it.native[0], it.native[1], 0) : fmt.money(it.amount)) + '</span></div><div class="rw-s row" style="gap:6px">' + esc(q.ownerName(it.from)) + ' · ' + fmt.ago(it.sent) + (it.noDate ? ui.chip('No date', 'warn') : '') + (it.confident ? ui.chip('Read cleanly', 'pos') : '') + '</div></div></div>').join('') + '</div>';
  }
  function detail(it) {
    const flag = (k) => (it.flags[k] ? '<div class="small warn row" style="gap:6px;margin-top:4px"><span class="dot"></span>' + esc(it.flags[k]) + '</div>' : '');
    const row = (label, k, control) => '<dt>' + label + '</dt><dd>' + control + flag(k) + '</dd>';
    const inp = (k, v, type) => '<input class="inp sm" style="width:100%" data-input="inbox-edit" data-field="' + k + '" type="' + (type || 'text') + '" value="' + esc(v) + '">';
    return '<div class="grid" style="gap:0"><div class="c-5" style="padding:16px 18px;border-right:1px solid var(--rule)"><div class="card-t" style="margin-bottom:10px">Message</div>' +
      (it.via === 'photo' ? '<div class="quote photo">' + ui.icon('photo') + '<span>' + esc(it.raw) + '</span></div>' : '<div class="quote">' + esc(it.raw) + '</div>') +
      '<div class="small muted" style="margin-top:10px">From ' + esc(q.ownerName(it.from)) + ' · ' + fmt.time(it.sent) + ' · Telegram</div></div>' +
      '<div class="c-7" style="padding:16px 18px"><div class="row between" style="margin-bottom:10px"><div class="card-t">What was read</div>' + (needsCheck(it) ? ui.chip('Check ' + Object.keys(it.flags).length, 'warn') : ui.chip('Read cleanly', 'pos')) + '</div>' +
      '<dl class="kv">' +
      row('Merchant', 'merchant', inp('merchant', it.merchant)) +
      row('Amount', 'amount', '<div class="row">' + inp('amount', Math.abs(it.amount)) + '<span class="small muted nowrap">AED' + (it.native ? ' · ' + fmt.native(it.native[0], it.native[1], 0) + ' paid' : '') + '</span></div>') +
      row('Date', 'date', inp('date', it.date, 'date')) +
      row('Category', 'cat', ui.select('inbox-edit', ui.catOptions('Choose…'), it.cat || '', { sm: true, data: { field: 'cat' } })) +
      row('Account', 'account', ui.select('inbox-edit', ui.accOptions(), it.account, { sm: true, data: { field: 'account' } })) +
      '</dl><div class="row" style="margin-top:18px">' + ui.btn('Approve', 'inbox-approve', { kind: 'primary', data: { id: it.id } }) + ui.btn('Reject', 'inbox-reject', { data: { id: it.id } }) + '</div><div class="small muted" style="margin-top:12px"><kbd>A</kbd> approve &nbsp; <kbd>R</kbd> reject &nbsp; <kbd>↑</kbd> <kbd>↓</kbd> move</div></div></div>';
  }

  A['inbox-pick'] = (el) => { S.inboxSel = el.dataset.id; RK.render(); };
  RK.inputs['inbox-edit'] = (el, e) => {
    const it = sel(); if (!it) return;
    const k = el.dataset.field;
    it[k] = k === 'amount' ? -Math.abs(Number(el.value) || 0) : el.value || null;
    if (e.type === 'change') { delete it.flags[k]; if (k === 'date') it.noDate = false; if (el.tagName === 'SELECT') RK.render(); else RK.renderSoon(); }
  };
  function leave(it, text, apply) {
    const i = D.inbox.indexOf(it); if (i < 0) return;
    D.inbox.splice(i, 1);
    const added = apply ? apply() : null;
    S.inboxSel = (D.inbox[i] || D.inbox[i - 1] || {}).id;
    RK.toast(text, () => { D.inbox.splice(i, 0, it); if (added) D.transactions.splice(D.transactions.indexOf(added), 1); S.inboxSel = it.id; });
    RK.render();
  }
  const approve = (it) => {
    if (!it.cat) { RK.toast('Choose a category first'); return; }
    leave(it, 'Approved ' + it.merchant, () => { const t = { id: 't' + Date.now(), date: it.date, merchant: it.merchant, cat: it.cat, account: it.account, owner: it.from === 'dev' && it.account === 'nre' ? 'dev' : 'shared', amount: it.amount, native: it.native }; D.transactions.unshift(t); return t; });
  };
  A['inbox-approve'] = () => { const it = sel(); if (it) approve(it); };
  A['inbox-reject'] = () => { const it = sel(); if (it) leave(it, 'Rejected ' + it.merchant); };
  A['inbox-approve-confident'] = () => {
    const ok = D.inbox.filter((x) => x.confident); if (!ok.length) return;
    const added = ok.map((it) => { D.inbox.splice(D.inbox.indexOf(it), 1); const t = { id: 't' + Date.now() + it.id, date: it.date, merchant: it.merchant, cat: it.cat, account: it.account, owner: 'shared', amount: it.amount }; D.transactions.unshift(t); return t; });
    S.inboxSel = null;
    RK.toast('Approved ' + ok.length + ' read cleanly', () => { ok.forEach((it) => D.inbox.unshift(it)); added.forEach((t) => D.transactions.splice(D.transactions.indexOf(t), 1)); });
    RK.render();
  };
  const move = (d) => { const i = D.inbox.indexOf(sel()), n = D.inbox[i + d]; if (n) { S.inboxSel = n.id; RK.render(); } };
  RK.keys = RK.keys || {};
  RK.keys.inbox = { a: () => A['inbox-approve'](), r: () => A['inbox-reject'](), ArrowDown: () => move(1), ArrowUp: () => move(-1) };

  RK.screens.inbox = {
    title: () => 'Inbox' + (D.inbox.length ? ' <span class="muted" style="font-weight:400">· ' + D.inbox.length + ' waiting</span>' : ''),
    tools: () => { const n = D.inbox.filter((x) => x.confident).length; return n ? ui.btn('Approve ' + n + ' read cleanly', 'inbox-approve-confident') : ''; },
    render: () => {
      const it = sel();
      if (!it) return ui.card({ body: ui.empty('Nothing waiting', 'Everything the bot sent has been filed.', ui.btn('Open Activity', 'go', { data: { route: 'money/activity' } }), 'check') });
      return '<div class="grid stretch"><div class="c-4">' + ui.card({ title: 'Waiting', right: String(D.inbox.length), flush: true, body: queue(it) }) + '</div><div class="c-8"><section class="card">' + detail(it) + '</section></div></div>';
    },
  };
})();
