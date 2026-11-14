/* Money: Activity, Budget, Recurring and Month end (which holds the card statements). */
(function () {
  const RK = window.RK;
  const { fmt, q, ui } = RK;
  const D = RK.data, S = RK.state, A = RK.actions;
  const esc = fmt.esc;
  const CUR = D.today.slice(0, 7);
  const LATEST = D.months[D.months.length - 1];
  const blank = '&nbsp;';
  const yearOf = (ym) => ym.slice(0, 4);
  const monthName = (ym) => fmt.monthLong(ym) + ' ' + yearOf(ym);
  const lastDay = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
  const firstData = () => D.months.find((m) => q.hasData(m));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  S.budgetView = S.budgetView || 'month';
  S.budExpanded = null;
  S.calDay = null;
  S.meOpen = null;
  S.meTicks = {};

  /* A month before the records start (Activity, Budget, Month end). */
  const emptyMonth = () => ui.card({
    body: ui.empty('No transactions in ' + monthName(S.month), 'Records start in ' + fmt.month(firstData()) + '.',
      '<div class="row" style="justify-content:center">' + ui.btn('Transaction', 'open-txn', { kind: 'primary', icon: 'plus' }) + ui.btn('Back to ' + fmt.month(LATEST), 'act-latest', { kind: 'text' }) + '</div>', 'search'),
  });
  A['act-latest'] = () => { S.month = LATEST; RK.render(); };

  /* ================= Activity ================= */
  const F = () => S.activity;
  const TYPES = [['', 'All types'], ['expense', 'Expenses'], ['income', 'Income'], ['refund', 'Refunds'], ['transfer', 'Transfers']];

  function actRows() {
    const f = F(), term = f.q.trim().toLowerCase();
    let rows = D.transactions.filter((t) => q.share(t.owner) > 0);
    if (f.range !== 'all') rows = rows.filter((t) => t.date.slice(0, 7) === S.month);
    if (f.status === 'posted') rows = rows.filter((t) => !t.scheduled);
    else if (f.status === 'scheduled') rows = rows.filter((t) => t.scheduled);
    if (f.cat) rows = rows.filter((t) => (f.cat === 'none' ? !t.cat && !t.transfer : t.cat === f.cat));
    if (f.account) rows = rows.filter((t) => t.account === f.account);
    if (f.type) rows = rows.filter((t) => q.kind(t) === f.type);
    if (f.review) rows = rows.filter((t) => t.review);
    if (term) rows = rows.filter((t) => (t.merchant + ' ' + (t.note || '') + ' ' + Math.abs(t.amount)).toLowerCase().includes(term));
    const dir = f.dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => (f.sort === 'amount' ? (Math.abs(a.amount) - Math.abs(b.amount)) * dir : (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * dir));
  }
  function actSum(rows) {
    const s = { spent: 0, income: 0, purchases: 0, refunds: 0, transfers: 0 };
    rows.forEach((t) => {
      if (t.scheduled) return;
      const k = q.kind(t), a = q.amt(t);
      if (k === 'transfer') s.transfers++;
      else if (k === 'income') s.income += a;
      else { s.spent -= a; if (k === 'refund') s.refunds += a; else s.purchases -= a; }
    });
    return s;
  }
  function actChips() {
    const f = F(), out = [];
    if (f.q) out.push(['q', 'Search: ' + f.q]);
    if (f.range === 'all') out.push(['range', 'All dates']);
    if (f.cat) out.push(['cat', f.cat === 'none' ? 'Uncategorised' : q.catName(f.cat)]);
    if (f.account) out.push(['account', q.acc(f.account).name]);
    if (f.type) out.push(['type', TYPES.find((x) => x[0] === f.type)[1]]);
    if (f.status !== 'posted') out.push(['status', f.status === 'all' ? 'Posted and scheduled' : 'Scheduled only']);
    if (f.review) out.push(['review', 'Needs review']);
    return out;
  }
  const txnChips = (t) => (t.review ? ui.chip('Needs review', 'warn') : '') + (t.refund ? ui.chip('Refund', 'pos') : '') + (t.scheduled ? ui.chip('Scheduled') : '') + (t.dup ? ui.chip('Possible duplicate', 'warn') : '');
  function txnRow(t) {
    const acc = q.acc(t.account), a = q.amt(t);
    const cat = t.transfer ? '<span class="muted">Transfer → ' + esc(q.acc(t.transfer.to).name) + '</span>' : t.cat ? esc(q.catName(t.cat)) : ui.catSelect(t);
    const sub = (t.native ? '<div class="sub">' + fmt.native(t.native[0], t.native[1], 0) + '</div>' : '') + (S.scope !== 'both' && t.owner === 'shared' ? '<div class="sub">half of ' + fmt.money(t.amount, { plus: true }) + '</div>' : '');
    return {
      action: 'open-txn', data: { id: t.id },
      cells: [
        '<span class="mono muted nowrap">' + fmt.date(t.date) + '</span>',
        { cls: 'two', html: '<div class="act-m"><span class="name clamp2" title="' + esc(t.merchant) + '">' + esc(t.merchant) + '</span>' + txnChips(t) + '</div>' },
        cat,
        '<span class="row">' + ui.avatar(t.owner) + '<span class="ink2 truncate">' + esc(acc.name) + '</span></span>',
        { cls: 'two', html: '<span class="' + (t.amount > 0 ? 'pos' : t.scheduled ? 'muted' : '') + '">' + fmt.money(a, { plus: true }) + '</span>' + sub },
      ],
    };
  }
  const txnTable = (rows, sortable) => ui.table({
    sort: sortable ? { key: F().sort, dir: F().dir, action: 'act-sort' } : null,
    cols: [{ label: 'Date', width: '88px', sort: 'date' }, { label: 'Merchant' }, { label: 'Category', width: '230px' }, { label: 'Account', width: '190px' }, { label: 'Amount', num: true, width: '120px', sort: 'amount' }],
    rows: rows.map(txnRow),
  });

  function actFilters() {
    const f = F(), more = (f.type ? 1 : 0) + (f.status !== 'posted' ? 1 : 0) + (f.review ? 1 : 0), chips = actChips();
    return '<div class="filters"><div class="search">' + ui.icon('search') + '<input class="inp" data-input="act-q" value="' + esc(f.q) + '" placeholder="Search merchant, note or amount"></div>' +
      ui.select('act-f', [['month', fmt.month(S.month)], ['all', 'All dates']], f.range, { data: { key: 'range' } }) +
      ui.select('act-f', ui.catOptions('All categories').concat([['none', 'Uncategorised']]), f.cat, { data: { key: 'cat' } }) +
      ui.select('act-f', ui.accOptions('All accounts'), f.account, { data: { key: 'account' } }) +
      '<button class="btn" data-action="act-more">More' + (more ? ' <span class="chip accent">' + more + '</span>' : '') + ui.icon('down') + '</button></div>' +
      (chips.length ? '<div class="row wrap">' + chips.map((c) => '<button class="chip" data-action="act-clear" data-key="' + c[0] + '">' + esc(c[1]) + ' ×</button>').join('') + '<button class="link accent" data-action="act-clear" data-key="all">Clear</button></div>' : '');
  }
  function actList() {
    const rows = actRows(), s = actSum(rows);
    const sched = F().status === 'posted' && F().range !== 'all' ? D.transactions.filter((t) => t.scheduled && t.date.slice(0, 7) === S.month && q.share(t.owner) > 0).length : 0;
    const info = 'Spent is purchases ' + fmt.money(s.purchases) + ' less refunds ' + fmt.money(s.refunds) + '. ' + plural(s.transfers, 'transfer') + ' between your own accounts count as neither.' + (S.scope !== 'both' ? ' Shared transactions count half.' : '');
    return ui.card({
      title: plural(rows.length, 'transaction'), flush: true,
      right: (sched ? ui.chip(sched + ' scheduled not counted', '', 'act-set', { key: 'status', value: 'all' }) : '') + '<span>Spent <b class="sum">' + fmt.money(s.spent) + '</b></span><span>Income <b class="sum">' + fmt.money(s.income) + '</b></span>' + ui.info(info),
      body: rows.length ? txnTable(rows, true) : ui.empty('Nothing matches', 'Try fewer filters.', ui.btn('Clear filters', 'act-clear', { data: { key: 'all' } }), 'search'),
    });
  }
  function actCalendar() {
    const y = +S.month.slice(0, 4), mo = +S.month.slice(5, 7), days = lastDay(S.month), first = (new Date(y, mo - 1, 1).getDay() + 6) % 7;
    const byDay = {};
    q.inMonth(S.month, true).forEach((t) => { const d = +t.date.slice(8, 10); (byDay[d] = byDay[d] || []).push(t); });
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div class="cal-c off"></div>';
    for (let d = 1; d <= days; d++) {
      const list = byDay[d] || [];
      let out = 0, inc = 0, sch = false;
      list.forEach((t) => { const k = q.kind(t); if (k === 'transfer') return; if (t.scheduled) sch = true; if (k === 'income') inc += q.amt(t); else out += q.amt(t); });
      const today = S.month === CUR && d === +D.today.slice(8, 10);
      cells += '<button class="cal-c' + (today ? ' today' : '') + (S.calDay === d ? ' sel' : '') + (list.length ? '' : ' none') + '" data-action="act-day" data-day="' + d + '"><span class="cal-d">' + d + '</span>' +
        (out ? '<span class="cal-v' + (sch ? ' muted' : out > 0 ? ' pos' : '') + '">' + fmt.money(out, { plus: true }) + '</span>' : '') + (inc ? '<span class="cal-v pos">' + fmt.money(inc, { plus: true }) + '</span>' : '') + '</button>';
    }
    const dayRows = S.calDay ? (byDay[S.calDay] || []) : null;
    const iso = S.month + '-' + String(S.calDay).padStart(2, '0');
    return ui.card({ title: monthName(S.month), right: 'Net amount each day · click a day', body: '<div class="cal cal-h">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => '<div>' + x + '</div>').join('') + '</div><div class="cal">' + cells + '</div>' }) +
      (dayRows ? ui.card({ title: fmt.date(iso) + ' · ' + plural(dayRows.length, 'transaction'), flush: true, body: dayRows.length ? txnTable(dayRows) : '<div class="muted small" style="padding:6px 18px 10px">Nothing on this day.</div>' }) : '');
  }
  function actMerchants() {
    const m = {};
    q.inMonth(S.month).forEach((t) => { const k = q.kind(t); if (k !== 'expense' && k !== 'refund') return; const e = (m[t.merchant] = m[t.merchant] || { name: t.merchant, spent: 0, n: 0 }); e.spent -= q.amt(t); e.n++; });
    const list = Object.keys(m).map((k) => m[k]).sort((a, b) => b.spent - a.spent), max = list.length ? list[0].spent : 1, total = list.reduce((s, x) => s + x.spent, 0);
    const top3 = list.slice(0, 3).reduce((s, x) => s + x.spent, 0);
    return '<div class="grid"><div class="c-8">' + ui.card({
      title: 'Merchants · ' + fmt.month(S.month), info: 'Spending by merchant, net of refunds. Click one to see its transactions.',
      body: ui.barList(list.map((x) => ({ label: x.name, note: '· ' + x.n, value: fmt.money(x.spent), frac: x.spent / max, action: 'act-merchant', data: { name: x.name } }))),
    }) + '</div><div class="c-4">' + ui.card({ flush: true, body: '<div class="kpi" style="border:0"><div class="kpi-l">Merchants paid</div><div class="fig">' + list.length + '</div></div><div class="kpi" style="border-left:0;border-top:1px solid var(--rule-soft)"><div class="kpi-l">Top three</div><div class="fig">' + fmt.pct(total ? (top3 / total) * 100 : 0) + '</div><div class="kpi-s">of ' + fmt.money(total) + ' spent</div></div>' }) + '</div></div>';
  }

  RK.inputs['act-q'] = (el, e) => { if (e && e.type === 'change') return; F().q = el.value; RK.render(); };
  RK.inputs['act-f'] = (el) => { F()[el.dataset.key] = el.value; RK.popClose(); RK.render(); };
  A['act-view'] = (el) => { F().view = el.dataset.value; S.calDay = null; RK.render(); };
  A['act-sort'] = (el) => { const f = F(); if (f.sort === el.dataset.key) f.dir = f.dir === 'asc' ? 'desc' : 'asc'; else { f.sort = el.dataset.key; f.dir = 'desc'; } RK.render(); };
  A['act-set'] = (el) => { const k = el.dataset.key; F()[k] = k === 'review' ? !F().review : el.dataset.value; RK.popClose(); RK.render(); };
  A['act-clear'] = (el) => {
    const f = F(), k = el.dataset.key, def = { q: '', range: 'month', cat: '', account: '', type: '', status: 'posted', review: false };
    if (k === 'all') Object.assign(f, def); else f[k] = def[k];
    RK.render();
  };
  A['act-more'] = (el) => RK.pop(el,
    '<div class="pop-f"><div class="m-l">Type</div>' + ui.select('act-f', TYPES, F().type, { data: { key: 'type' } }) +
    '<div class="m-l">Which dates count</div>' + ui.seg('act-set', [['posted', 'Posted'], ['scheduled', 'Scheduled'], ['all', 'All']], F().status, { key: 'status' }, true) +
    '<div class="row between" style="padding-top:12px"><span style="color:var(--ink)">Needs review only</span>' + ui.sw(F().review, 'act-set', { key: 'review' }) + '</div></div>');
  A['act-day'] = (el) => { S.calDay = S.calDay === +el.dataset.day ? null : +el.dataset.day; RK.render(); };
  A['act-merchant'] = (el) => { F().q = el.dataset.name; F().view = 'list'; RK.render(); };
  A['act-uncat'] = () => { F().cat = 'none'; F().view = 'list'; RK.go('money/activity'); };
  A['act-all'] = () => { F().cat = ''; F().view = 'list'; RK.go('money/activity'); };

  RK.screens['money/activity'] = {
    tools: () => ui.monthStepper() + ui.seg('act-view', [['list', 'List'], ['calendar', 'Calendar'], ['merchants', 'Merchants']], F().view) + ui.btn('Transaction', 'open-txn', { kind: 'primary', icon: 'plus' }),
    render: () => {
      const anySched = D.transactions.some((t) => t.scheduled && t.date.slice(0, 7) === S.month);
      if (F().range !== 'all' && !q.hasData(S.month) && !anySched) return emptyMonth();
      if (F().view === 'calendar') return actCalendar();
      if (F().view === 'merchants') return actMerchants();
      return actFilters() + actList();
    },
  };

  /* ================= Budget ================= */
  const GROUPS = ['Housing', 'Food', 'Transport', 'Living'];
  const scopeScale = () => (S.scope === 'both' ? 1 : 0.5);

  function shareCalc(m) {
    const own = {}, part = {}, paid = {}, mem = D.members;
    mem.forEach((x) => { own[x.id] = 0; part[x.id] = 0; paid[x.id] = 0; });
    let shared = 0;
    Object.keys(D.budgets).forEach((id) => { const o = q.cat(id).owner; if (o && own[o] != null) own[o] += D.budgets[id]; else shared += D.budgets[id]; });
    D.transactions.filter((t) => t.date.slice(0, 7) === m && !t.scheduled && !t.transfer && (t.amount < 0 || t.refund)).forEach((t) => {
      const v = -t.amount, ao = q.acc(t.account).owner;
      if (t.owner === 'shared') mem.forEach((x) => (part[x.id] += v / mem.length)); else part[t.owner] += v;
      if (ao === 'shared') mem.forEach((x) => (paid[x.id] += v / mem.length)); else paid[ao] += v;
    });
    return { own, each: shared / mem.length, part, paid };
  }
  function budShare(m) {
    const c = shareCalc(m), a = D.members[0], b = D.members[1], diff = c.paid[a.id] - c.part[a.id];
    const head = Math.abs(diff) < 0.5 ? 'All even' : fmt.money(Math.abs(diff)) + ' <span class="of">from ' + esc(diff > 0 ? b.name : a.name) + ' to ' + esc(diff > 0 ? a.name : b.name) + '</span>';
    return ui.card({
      title: 'Household share', flush: true, right: 'Shared costs split evenly',
      info: 'Each person\'s part is their own costs plus half of the shared ones. Paid is what left each person\'s accounts, with shared accounts counted half each. The difference is the one transfer that evens it up.',
      body: '<div style="padding:6px 18px 12px"><div class="kpi-l">To even up so far</div><div class="fig">' + head + '</div></div>' + ui.table({
        compact: true,
        cols: [{ label: '' }, { label: 'Own', num: true }, { label: 'Share of shared', num: true }, { label: 'Planned', num: true }, { label: 'Part so far', num: true }, { label: 'Paid so far', num: true }],
        rows: D.members.map((x) => ({ cells: ['<span class="row">' + ui.avatar(x.id) + '<span class="name">' + esc(x.name) + '</span></span>', fmt.money(c.own[x.id]), fmt.money(c.each), fmt.money(c.own[x.id] + c.each), fmt.money(c.part[x.id]), fmt.money(c.paid[x.id])] })),
      }),
    });
  }
  function budSavings(m) {
    const t = q.totals(m), target = D.savingsTarget * scopeScale(), ended = m < CUR, gap = target - t.saved;
    return ui.card({
      title: 'Savings target', info: 'Saved is income less all spending this month. The target is not part of the budget: money set aside is not money spent.',
      right: gap <= 0 ? ui.chip('Target met', 'pos') : ui.chip(fmt.money(gap) + ' short' + (ended ? '' : ' so far'), ended ? 'neg' : ''),
      body: '<div class="fig" style="margin-bottom:12px">' + fmt.money(t.saved) + ' <span class="of">of ' + fmt.money(target) + '</span></div>' + ui.bar(Math.max(0, t.saved) / target, { lg: true, tone: 'pos' }) +
        '<div class="kpi-s" style="margin-top:10px">' + fmt.pct(t.rate) + ' of income saved</div>',
    });
  }
  function budMonth() {
    const m = S.month;
    if (!q.hasData(m)) return emptyMonth();
    const b = q.budget(m), el = q.elapsed(m), used = b.spentBudgeted / b.budgeted, ended = m < CUR;
    const pace = used > 1 ? ui.chip('Over by ' + fmt.money(b.spentBudgeted - b.budgeted), 'neg') : !ended && used > el + 0.1 ? ui.chip('Over pace', 'warn') : ui.chip(ended ? 'Within budget' : 'On pace', 'pos');
    const hero = '<section class="card"><div class="bud-hero"><div><div class="kpi-l">Spent of budget</div><div class="hero-fig">' + fmt.money(b.spentBudgeted) + ' <span class="of">of ' + fmt.money(b.budgeted) + '</span></div></div>' +
      '<div class="grow"><div class="row between small" style="margin-bottom:10px"><span class="ink2">' + fmt.pct(used * 100) + ' spent · ' + (ended ? 'month complete' : fmt.pct(el * 100) + ' of month gone') + '</span><span class="row">' + (S.scope !== 'both' ? ui.chip('Limits are the household’s') : '') + pace + '</span></div>' + ui.bar(used, { lg: true, tick: ended ? null : el, tone: used > 1 ? 'neg' : '' }) + '</div></div></section>';
    const rows = [];
    GROUPS.forEach((g) => {
      const lines = b.lines.filter((l) => l.group === g);
      if (!lines.length) return;
      rows.push({ cls: 'group', cells: [esc(g), fmt.money(lines.reduce((s, l) => s + l.spent, 0)), '<span class="lim-t">' + fmt.money(lines.reduce((s, l) => s + l.limit, 0)) + '</span>', blank, blank] });
      lines.forEach((l) => {
        const over = l.spent - l.limit, open = S.budExpanded === l.id, owner = q.cat(l.id).owner;
        const high = l.usual && l.spent > l.usual * 1.1;
        rows.push({
          action: 'bud-expand', data: { id: l.id }, cls: open ? 'open' : '',
          cells: [
            '<span class="row"><span class="caret' + (open ? ' on' : '') + '"></span><span class="name">' + esc(l.name) + '</span>' + (owner ? ui.avatar(owner) : '') + '</span>',
            fmt.money(l.spent),
            '<input class="inp sm lim" data-input="bud-limit" data-id="' + l.id + '" value="' + fmt.num(l.limit) + '" inputmode="numeric" aria-label="' + esc(l.name) + ' limit">',
            l.usual == null ? '' : (high ? '<span class="warn small">+' + Math.round((l.spent / l.usual - 1) * 100) + '%</span> ' : '') + '<span class="ink2">' + fmt.money(l.usual) + '</span>',
            '<div class="row"><div class="grow">' + ui.bar(l.spent / l.limit, { tick: ended ? null : el, tone: over > 0 ? 'neg' : '' }) + '</div>' + (over > 0 ? ui.chip('Over by ' + fmt.money(over), 'neg') : '') + '</div>',
          ],
        });
        if (open) {
          const tx = q.inMonth(m).filter((t) => t.cat === l.id).sort((x, y) => (x.date < y.date ? 1 : -1));
          rows.push({ cls: 'bud-exp', cells: [{ span: 5, html: tx.length ? '<div class="rows">' + tx.map((t) => '<div class="rw click" data-action="open-txn" data-id="' + t.id + '"><span class="rw-date">' + fmt.date(t.date) + '</span><div class="rw-main truncate">' + esc(t.merchant) + (t.refund ? ' ' + ui.chip('Refund', 'pos') : '') + '</div><span class="num">' + fmt.money(q.amt(t), { plus: true }) + '</span></div>').join('') + '</div>' : '<div class="muted small" style="padding:10px 18px 10px 44px">Nothing spent here this month.</div>' }] });
        }
      });
    });
    rows.push({ cls: 'total', cells: ['Budgeted', fmt.money(b.spentBudgeted), '<span class="lim-t">' + fmt.money(b.budgeted) + '</span>', blank, '<div class="row"><div class="grow">' + ui.bar(used, { tone: used > 1 ? 'neg' : '' }) + '</div></div>'] });
    rows.push({ action: 'act-all', cells: ['<span class="row"><span class="name">Outside budget</span>' + (b.uncategorised ? ui.chip(fmt.money(b.uncategorised) + ' uncategorised', 'warn', 'act-uncat') : '') + '</span>', fmt.money(b.outside), '', blank, '<span class="link">Activity →</span>'] });
    const table = ui.card({
      title: 'By category', flush: true, info: 'Usual is the average of up to three earlier months. The tick on each bar is how far through the month it is. Click a category to see its transactions.',
      body: ui.table({ cols: [{ label: 'Category' }, { label: 'Spent', num: true, width: '110px' }, { label: 'Limit', num: true, width: '120px' }, { label: 'Usual', num: true, width: '150px' }, { label: 'Pace', width: '300px' }], rows }),
    });
    return hero + table + '<div class="grid stretch"><div class="c-5 stack-v">' + budSavings(m) + '</div><div class="c-7 stack-v">' + budShare(m) + '</div></div>';
  }
  function budYear() {
    const y = yearOf(S.month), months = [];
    for (let i = 1; i <= 12; i++) months.push(y + '-' + String(i).padStart(2, '0'));
    const cats = {}, tot = {};
    months.forEach((m) => { if (q.hasData(m)) { cats[m] = q.byCat(m); tot[m] = q.totals(m); } });
    const cell = (v, kind) => (kind === 'plan' ? '<i class="muted">' + fmt.money(v) + '</i>' : kind === 'none' ? '<span class="muted">—</span>' : fmt.money(v));
    const line = (label, fn, planFn, cls) => {
      let sum = 0;
      const tds = months.map((m) => {
        if (cats[m]) { const v = fn(m); sum += v; return '<td class="num' + (m === CUR ? ' cur' : '') + '">' + cell(v) + '</td>'; }
        if (m > CUR && planFn) { const v = planFn(m); sum += v; return '<td class="num">' + cell(v, 'plan') + '</td>'; }
        return '<td class="num">' + cell(0, 'none') + '</td>';
      }).join('');
      return '<tr class="' + (cls || '') + '"><td>' + label + '</td>' + tds + '<td class="num"><b style="font-weight:600">' + fmt.money(sum) + '</b></td></tr>';
    };
    const spentOf = (m, id) => (cats[m].find((c) => c.id === id) || {}).spent || 0;
    let body = '';
    GROUPS.forEach((g) => {
      const ids = Object.keys(D.budgets).filter((id) => q.cat(id).group === g);
      if (!ids.length) return;
      body += '<tr class="group"><td colspan="14">' + esc(g) + '</td></tr>';
      ids.forEach((id) => (body += line(esc(q.catName(id)), (m) => spentOf(m, id), () => D.budgets[id])));
    });
    const budgetedIds = Object.keys(D.budgets), planAll = budgetedIds.reduce((s, id) => s + D.budgets[id], 0);
    body += line('Outside budget', (m) => cats[m].filter((c) => !budgetedIds.includes(c.id)).reduce((s, c) => s + c.spent, 0), null);
    body += line('All spending', (m) => tot[m].spent, () => planAll, 'total');
    body += line('Income', (m) => tot[m].income, null);
    body += line('Saved', (m) => tot[m].saved, null, 'total');
    return ui.card({
      title: y + ' by month', flush: true, right: '<span><i>Italic</i> = budgeted, months ahead</span>',
      info: 'Months with records show what was spent. Months ahead show the budget. Months before the records start show a dash.',
      body: '<table class="tbl compact yr"><thead><tr><th>Category</th>' + months.map((m) => '<th class="num">' + fmt.monthShort(m) + '</th>').join('') + '<th class="num">Total</th></tr></thead><tbody>' + body + '</tbody></table>',
    });
  }

  /* Deep link: #/money/budget?bview=year */
  const budHash = () => { const hv = (location.hash.match(/[?&]bview=(month|year)/) || [])[1]; if (hv && S._budHash !== location.hash) { S._budHash = location.hash; S.budgetView = hv; } };
  A['bud-view'] = (el) => { S.budgetView = el.dataset.value; RK.render(); };
  A['bud-expand'] = (el) => { S.budExpanded = S.budExpanded === el.dataset.id ? null : el.dataset.id; RK.render(); };
  A['bud-open'] = () => {
    const free = D.categories.filter((c) => c.kind === 'expense' && !c.savings && D.budgets[c.id] == null);
    RK.drawer.open({
      kicker: 'New budget', title: 'Set a category budget',
      body: ui.field('Category', ui.select(null, free.map((c) => [c.id, (c.group ? c.group + ' › ' : '') + c.name]), '', { name: 'cat' })) +
        '<div class="field"><label>Monthly limit</label><div class="amount"><span>AED</span><input name="limit" inputmode="decimal" placeholder="0"></div></div>' +
        ui.field('Apply to', ui.segField('apply', [['month', fmt.month(S.month)], ['year', 'Whole year']], 'year')) +
        ui.switchField('alerts', true, 'Budget alerts', 'Telegram at 80%, 90% and over'),
      footer: ui.drawerFooter({ save: 'bud-save', saveLabel: 'Add budget' }),
    });
  };
  A['bud-save'] = () => {
    const f = RK.drawer.values(), v = Number(f.limit);
    if (!f.cat || !(v > 0)) { RK.toast('Choose a category and a limit above zero'); return; }
    D.budgets[f.cat] = v; RK.drawer.close(); RK.toast('Budget set for ' + q.catName(f.cat), () => delete D.budgets[f.cat]); RK.render();
  };

  RK.screens['money/budget'] = {
    tools: () => { budHash(); return ui.seg('bud-view', [['month', 'Month'], ['year', 'Year']], S.budgetView) + (S.budgetView === 'month' ? ui.monthStepper() : '') + ui.btn('Budget', 'bud-open', { kind: 'primary', icon: 'plus' }); },
    render: () => { budHash(); return S.budgetView === 'year' ? budYear() : budMonth(); },
  };

  /* ================= Recurring ================= */
  const ST = { late: ['Late', 'neg'], unconfirmed: ['Not confirmed', 'warn'], 'due-soon': ['Due soon', 'warn'], upcoming: ['Upcoming', ''], posted: ['Paid', 'pos'], expected: ['Expected', ''], ended: ['Ended', ''] };
  const ORDER = ['late', 'unconfirmed', 'due-soon', 'upcoming', 'expected', 'posted', 'ended'];
  const needsPay = (r) => r.status === 'late' || r.status === 'unconfirmed';
  const dueText = (r) => { const n = fmt.days(r.next); return n === 0 ? 'today' : n > 0 ? 'in ' + plural(n, 'day') : plural(-n, 'day') + ' ago'; };
  function recRow(r) {
    const st = r.status === 'posted' && r.kind === 'income' ? ['Received', 'pos'] : ST[r.status], amt = (r.kind === 'income' ? r.amount : -r.amount) * q.share(r.owner);
    return {
      action: 'open-bill', data: { id: r.id },
      cells: [
        ui.chip(st[0], st[1]),
        '<span class="name">' + esc(r.name) + '</span>',
        '<span class="ink2">' + esc(r.every) + '</span>',
        r.next ? { cls: 'two', html: '<div>' + fmt.date(r.next) + '</div><div class="sub">' + dueText(r) + '</div>' } : '<span class="muted">last ' + fmt.date(r.last) + '</span>',
        '<span class="row">' + ui.avatar(r.owner) + '<span class="ink2">' + esc(q.ownerName(r.owner)) + '</span></span>',
        r.kind === 'income' ? '<span class="muted">' + esc(q.acc(r.account).name) + '</span>' : '<span class="muted">' + (r.autopay ? 'Autopay' : 'Manual') + '</span>',
        { cls: 'two', html: '<span class="' + (r.kind === 'income' ? 'pos' : '') + '">' + (r.varies ? '<span class="muted small">about </span>' : '') + fmt.money(amt, { plus: true }) + '</span>' + (r.native ? '<div class="sub">' + fmt.native(r.native[0], r.native[1], 0) + '</div>' : '') },
        needsPay(r) ? ui.btn('Mark paid', 'mark-paid', { sm: true, data: { id: r.id } }) : blank,
      ],
    };
  }
  const recCols = (sixth) => [{ label: 'Status', width: '128px' }, { label: 'Name' }, { label: 'Every', width: '90px' }, { label: 'Next due', width: '120px' }, { label: 'Owner', width: '130px' }, { label: sixth, width: '150px' }, { label: 'Amount', num: true, width: '120px' }, { label: '', width: '110px', cls: 'act' }];
  const recSort = (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || ((a.next || '') < (b.next || '') ? -1 : 1);

  A['mark-paid'] = (el) => {
    const r = D.recurring.find((x) => x.id === el.dataset.id); if (!r) return;
    const prev = r.status;
    const t = { id: 't' + Date.now(), date: D.today, merchant: r.name, cat: r.cat, account: r.account, owner: r.owner, amount: r.kind === 'income' ? r.amount : -r.amount };
    if (r.native) t.native = r.native;
    r.status = 'posted'; D.transactions.unshift(t);
    RK.toast('Recorded ' + r.name + ' · ' + fmt.money(t.amount), () => { r.status = prev; D.transactions.splice(D.transactions.indexOf(t), 1); });
    RK.render();
  };
  A['open-bill'] = (el) => {
    const r = el && el.dataset.id ? D.recurring.find((x) => x.id === el.dataset.id) : null;
    const v = r || { kind: 'bill', name: '', amount: '', every: 'Month', next: D.today, account: 'cur', cat: '', autopay: false, owner: 'shared' };
    RK.drawer.open({
      kicker: r ? 'Edit ' + (r.kind === 'income' ? 'income' : 'bill') : 'New bill', title: r ? r.name : 'Add a bill or income',
      body:
        (r && needsPay(r) ? ui.warnRow(r.status === 'late' ? 'Late: was due ' + fmt.date(r.next) + '.' : 'Autopay not confirmed for ' + fmt.date(r.next) + '.', ui.btn('Mark paid', 'rec-pay-close', { sm: true, data: { id: r.id } }), r.status === 'late') : '') +
        ui.field('Type', ui.segField('kind', [['bill', 'Bill'], ['income', 'Expected income']], v.kind)) +
        '<div class="field"><label>Amount</label><div class="amount"><span>AED</span><input name="amount" inputmode="decimal" value="' + esc(v.amount) + '" placeholder="0"></div>' + (v.native ? '<div class="hint">' + fmt.native(v.native[0], v.native[1], 0) + ' · follows the rate</div>' : '') + '</div>' +
        ui.field('Name', ui.input('name', v.name, { placeholder: 'What it is' })) +
        ui.fieldRow(ui.field('Every', ui.select(null, [['Month', 'Month'], ['Quarter', 'Quarter'], ['Year', 'Year']], v.every, { name: 'every' })), ui.field('Next due', ui.input('next', v.next || '', { type: 'date' }))) +
        ui.fieldRow(ui.field('Account', ui.select(null, ui.accOptions(), v.account, { name: 'account' })), ui.field('Category', ui.select(null, ui.catOptions('None'), v.cat || '', { name: 'cat' }))) +
        ui.field('Paid by', ui.segField('autopay', [['1', 'Autopay'], ['', 'Manual']], v.autopay ? '1' : ''), 'With autopay, the bot asks until it is confirmed') +
        ui.field('Owner', ui.select(null, ui.ownerOptions(), v.owner, { name: 'owner' })) +
        ui.fold('More', '<div class="stack-v" style="gap:14px;padding-top:4px">' + ui.switchField('varies', !!v.varies, 'Amount varies', 'Shown as "about"') + ui.switchField('active', v.status !== 'ended', 'Active', 'Off hides it from Next 30 days') + '</div>'),
      footer: ui.drawerFooter({ del: r ? 'rec-delete' : null, delData: r ? { id: r.id } : null, save: 'rec-save', saveLabel: r ? 'Save' : 'Add bill', saveData: { id: r ? r.id : '' } }),
    });
  };
  A['rec-pay-close'] = (el) => { RK.drawer.close(); A['mark-paid'](el); };
  A['rec-save'] = (el) => {
    const f = RK.drawer.values(), amt = Math.abs(Number(f.amount));
    if (!f.name || !amt) { RK.toast('Give it a name and an amount'); return; }
    let r = el.dataset.id ? D.recurring.find((x) => x.id === el.dataset.id) : null;
    const isNew = !r;
    if (!r) { r = { id: 'r' + Date.now(), status: 'upcoming' }; D.recurring.push(r); }
    Object.assign(r, { kind: f.kind, name: f.name, amount: amt, every: f.every, next: f.next || null, account: f.account, cat: f.cat || null, autopay: !!f.autopay, owner: f.owner, varies: !!f.varies });
    if (!f.active) r.status = 'ended'; else if (r.status === 'ended') r.status = 'upcoming';
    if (isNew && f.kind === 'income') r.status = 'expected';
    RK.drawer.close(); RK.toast((isNew ? 'Added ' : 'Saved ') + r.name); RK.render();
  };
  A['rec-delete'] = (el) => {
    const i = D.recurring.findIndex((x) => x.id === el.dataset.id); if (i < 0) return;
    const [gone] = D.recurring.splice(i, 1);
    RK.drawer.close(); RK.toast('Deleted ' + gone.name, () => D.recurring.splice(i, 0, gone)); RK.render();
  };

  RK.screens['money/recurring'] = {
    tools: () => ui.btn('Bill', 'open-bill', { kind: 'primary', icon: 'plus' }),
    render: () => {
      const all = D.recurring.filter((r) => q.share(r.owner) > 0);
      const bills = all.filter((r) => r.kind === 'bill' && r.status !== 'ended').sort(recSort);
      const income = all.filter((r) => r.kind === 'income' && r.status !== 'ended').sort(recSort);
      const ended = all.filter((r) => r.status === 'ended');
      const monthly = bills.filter((r) => r.every === 'Month' && !r.card);
      const sum = (list) => list.reduce((s, r) => s + r.amount * q.share(r.owner), 0);
      const fixed = monthly.filter((r) => !r.varies), vary = monthly.filter((r) => r.varies), todo = bills.filter(needsPay), late = todo.filter((r) => r.status === 'late').length;
      const strip = ui.card({ flush: true, body: ui.kpis([
        { label: 'Fixed a month', value: fmt.money(sum(fixed)), sub: plural(fixed.length, 'bill') },
        { label: 'Variable, about', value: fmt.money(sum(vary)), sub: plural(vary.length, 'bill') },
        { label: 'Expected income a month', value: fmt.money(sum(income.filter((r) => r.every === 'Month'))) },
        { label: 'To mark paid', value: String(todo.length), sub: late ? ui.chip(late + ' late', 'neg') : todo.length ? ui.chip('Not confirmed', 'warn') : ui.chip('All clear', 'pos') },
      ]) });
      return strip +
        ui.card({ title: 'Bills', right: String(bills.length), flush: true, body: bills.length ? ui.table({ cols: recCols('Paid by'), rows: bills.map(recRow) }) : ui.empty('No bills yet', 'Add rent, utilities and subscriptions.', ui.btn('Bill', 'open-bill', { kind: 'primary', icon: 'plus' })) }) +
        ui.card({ title: 'Expected income', right: String(income.length), flush: true, body: (income.length ? ui.table({ cols: recCols('Paid into'), rows: income.map(recRow) }) : '<div class="muted small" style="padding:6px 18px 10px">None set up.</div>') }) +
        (ended.length ? '<section class="card">' + ui.fold('Ended (' + ended.length + ')', ui.table({ compact: true, cols: recCols('Paid by'), rows: ended.map(recRow) })).replace('class="fold"', 'class="fold first"') + '</section>' : '');
    },
  };

  /* ================= Month end ================= */
  const STM = { 'to-check': ['To check', 'warn'], waiting: ['Waiting', ''], mismatch: ['Doesn’t match', 'neg'], done: ['Done', 'pos'] };
  const stmOpen = (s) => s.status !== 'done';
  const m2 = (v) => fmt.money(v, { dec: 2 });
  const okRow = (text) => '<div class="rw"><span class="step-n done">' + ui.icon('check') + '</span><div class="rw-main ink2">' + text + '</div></div>';

  /* The statements table: one row per statement, grouped by card (S-statements-1). */
  function stmtBlock(list) {
    const open = list.filter(stmOpen), done = D.statements.filter((s) => !stmOpen(s));
    const cols = [{ label: '', width: '36px' }, { label: 'Period' }, { label: 'Due', width: '90px' }, { label: 'In Rokda', num: true, width: '120px', info: 'What was spent on the card over the period, refunds netted, in AED.' }, { label: 'Statement', num: true, width: '130px' }, { label: 'Difference', num: true, width: '190px' }, { label: 'Status', width: '130px' }, { label: '', width: '120px', cls: 'act' }];
    const row = (s) => {
      const diff = s.statement == null ? null : s.recorded - s.statement, st = STM[s.status], isOpen = stmOpen(s);
      return { cells: [
        isOpen ? '<input type="checkbox" class="tick" data-input="me-tick" data-id="' + s.id + '"' + (S.meTicks[s.id] ? ' checked' : '') + ' aria-label="Select">' : blank,
        '<span class="name">' + fmt.date(s.from) + ' – ' + fmt.date(s.to) + '</span>',
        '<span class="ink2">' + fmt.date(s.due) + '</span>',
        m2(s.recorded),
        s.statement == null ? '<input class="inp sm lim" data-input="me-stmt" data-id="' + s.id + '" placeholder="Enter" inputmode="decimal" aria-label="Statement total">' : m2(s.statement),
        diff == null ? '' : Math.abs(diff) < 0.005 ? '<span class="pos">Matches</span>' : '<span class="neg">' + m2(Math.abs(diff)) + (diff > 0 ? ' higher' : ' lower') + ' in Rokda</span>',
        ui.chip(st[0], st[1]),
        isOpen ? ui.btn(s.status === 'mismatch' ? 'Resolve' : 'Mark done', 'me-stmt-done', { sm: true, data: { id: s.id, word: s.status === 'mismatch' ? 'Resolved' : 'Marked done' } }) : ui.btn('Reopen', 'me-stmt-reopen', { sm: true, kind: 'text', data: { id: s.id } }),
      ] };
    };
    const grouped = (items) => {
      const rows = [];
      D.accounts.filter((a) => a.type === 'Credit card').forEach((c) => {
        const mine = items.filter((s) => s.card === c.id);
        if (!mine.length) return;
        rows.push({ cls: 'group', cells: [{ span: 8, html: '<span class="row">' + ui.avatar(c.owner) + '<button class="link" style="font-size:12.5px;font-weight:500;color:var(--ink)" data-action="open-account" data-id="' + c.id + '" data-tab="cycle">' + esc(c.name) + ' →</button><span class="muted" style="font-weight:400">· closes ' + fmt.ord(c.statementDay) + ' · due ' + fmt.ord(c.dueDay) + '</span></span>' }] });
        mine.forEach((s) => rows.push(row(s)));
      });
      return rows;
    };
    return (open.length ? ui.table({ cols, rows: grouped(open) }) : okRow('Every statement here has been checked.')) +
      (done.length ? ui.fold('Done (' + done.length + ')', ui.table({ compact: true, cols, rows: grouped(done) })) : '');
  }
  const ticked = () => D.statements.filter((s) => stmOpen(s) && S.meTicks[s.id]);
  const markTicked = () => (ticked().length ? ui.btn('Mark ' + ticked().length + ' done', 'me-mark-ticked', { sm: true }) : '');

  function stepShell(n, title, status, done, current, right, body) {
    const open = S.meOpen === 'all' ? true : S.meOpen == null ? current : S.meOpen === n;
    return '<section class="card step' + (current ? ' action' : '') + '"><div class="step-h" data-action="me-open" data-n="' + n + '"><span class="step-n' + (done ? ' done' : current ? ' cur' : '') + '">' + (done ? ui.icon('check') : n) + '</span><span class="step-t">' + title + '</span><span class="muted small grow">' + status + '</span>' + (right || '') + '<span class="caret' + (open ? ' on' : '') + '"></span></div>' + (open ? '<div class="step-b">' + body + '</div>' : '') + '</section>';
  }
  function meSteps(m) {
    const rows = D.transactions.filter((t) => t.date.slice(0, 7) === m && !t.scheduled);
    const uncat = rows.filter((t) => !t.cat && !t.transfer);
    const dups = {};
    rows.filter((t) => t.dup).forEach((t) => (dups[t.dup] = dups[t.dup] || []).push(t));
    const pairs = Object.keys(dups).filter((k) => dups[k].length > 1).map((k) => dups[k]);
    const endIso = m + '-' + lastDay(m);
    const stm = D.statements.filter((s) => s.to <= endIso), stmWaiting = stm.filter(stmOpen);
    const unconfirmed = D.accounts.filter((a) => !a.closed && !a.confirmed);
    const d1 = !uncat.length && !pairs.length, d2 = !stmWaiting.length && !unconfirmed.length;
    const cur = !d1 ? 1 : !d2 ? 2 : 3, doneN = (d1 ? 1 : 0) + (d2 ? 1 : 0);
    const name = fmt.monthLong(m), t = q.totals(m), nw = q.netWorth();
    const clear = (uncat.length ? [] : ['Categories']).concat(pairs.length ? [] : ['Duplicates'], ['Flagged transactions', 'Transfers', 'Other currencies', 'Refunds']);

    const b1 =
      (uncat.length ? '<div class="sub-h">Uncategorised · ' + uncat.length + '</div><div class="rows">' + uncat.map((x) => '<div class="rw"><span class="rw-date">' + fmt.date(x.date) + '</span><div class="rw-main truncate"><span class="rw-t">' + esc(x.merchant) + '</span> <span class="rw-s">· ' + esc(q.acc(x.account).name) + '</span></div><span class="num" style="width:80px">' + fmt.money(x.amount) + '</span>' + ui.catSelect(x) + '</div>').join('') + '</div>' : '') +
      (pairs.length ? '<div class="sub-h">Possible duplicates · ' + pairs.length + '</div><div class="rows">' + pairs.map((p) => '<div class="rw"><span class="rw-date">' + fmt.date(p[0].date) + '</span><div class="rw-main truncate"><span class="rw-t">' + esc(p[0].merchant) + '</span> <span class="rw-s">· also ' + fmt.date(p[1].date) + ' · ' + fmt.money(p[0].amount) + ' each</span></div>' + ui.btn('Both are real', 'me-dup-real', { sm: true, data: { dup: p[0].dup } }) + ui.btn('Delete one', 'me-dup-del', { sm: true, kind: 'danger', data: { id: p[1].id } }) + '</div>').join('') + '</div>' : '') +
      (d1 ? okRow('Nothing left to tidy.') : '') +
      ui.fold('Nothing to do (' + clear.length + ')', '<div class="me-clear">' + clear.map((x) => '<span>' + ui.icon('check') + x + '</span>').join('') + '</div>');
    const b2 = stmtBlock(stm) +
      '<div class="sub-h me-sub">Balances</div>' +
      (unconfirmed.length ? '<div class="rows">' + unconfirmed.map((a) => '<div class="rw"><span class="dot" style="color:var(--warn-mark)"></span><div class="rw-main"><span class="rw-t">' + esc(a.name) + '</span> <span class="rw-s">· not confirmed, counted as zero</span></div>' + ui.btn('Confirm balance', 'open-account', { sm: true, data: { id: a.id } }) + '</div>').join('') + '</div>' : okRow('Every balance is confirmed.'));
    const openSteps = (d1 ? [] : ['1']).concat(d2 ? [] : ['2']);
    const b3 = ui.kpis([
      { label: 'Income', value: fmt.money(t.income) }, { label: 'Spent', value: fmt.money(t.spent) },
      { label: 'Saved', value: fmt.money(t.saved), sub: fmt.pct(t.rate) + ' of income', tone: t.saved < 0 ? 'neg' : '' },
      { label: 'Net worth', value: fmt.money(nw.net), sub: nw.provisional.length ? ui.chip('Provisional', 'warn', 'open-health') : '' },
    ]) +
      '<div class="me-close">' + (openSteps.length ? ui.warnRow('Step' + (openSteps.length > 1 ? 's ' : ' ') + openSteps.join(' and ') + (openSteps.length > 1 ? ' are' : ' is') + ' still open. You can close now and finish after.') : '') +
      '<div class="row" style="align-items:flex-end;gap:12px"><div class="field" style="width:180px"><label>Assets ' + ui.info('What ' + name + ' closed at, in AED. Starts from today\'s totals; change it if the month ended differently.') + '</label><input class="inp num" name="assets" value="' + fmt.num(nw.assets) + '"></div><div class="field" style="width:180px"><label>Liabilities</label><input class="inp num" name="liabilities" value="' + fmt.num(nw.liabilities) + '"></div><span class="grow"></span>' + ui.btn('Close ' + name, 'me-close', { kind: cur === 3 ? 'primary' : '', data: { month: m } }) + '</div></div>';

    return '<div class="me-head"><div><div class="fig-s">Close ' + name + '</div><div class="small muted">' + doneN + ' of 3 steps done</div></div><div class="steps-bar"><i class="' + (d1 ? 'on' : '') + '"></i><i class="' + (d2 ? 'on' : '') + '"></i><i></i></div>' + ui.chip('Household') + '<span class="grow"></span>' + ui.link('Budget for ' + fmt.monthShort(m), 'money/budget') + '</div>' +
      stepShell(1, 'Tidy transactions', d1 ? 'All clear' : [uncat.length ? uncat.length + ' uncategorised' : '', pairs.length ? plural(pairs.length, 'possible duplicate') : ''].filter(Boolean).join(' · '), d1, cur === 1, '', b1) +
      stepShell(2, 'Check statements and balances', d2 ? 'All clear' : [stmWaiting.length ? plural(stmWaiting.length, 'statement') + ' to check' : '', unconfirmed.length ? plural(unconfirmed.length, 'balance') + ' not confirmed' : ''].filter(Boolean).join(' · '), d2, cur === 2, markTicked(), b2) +
      stepShell(3, 'Close', 'Puts ' + name + ' into history', false, cur === 3, '', b3);
  }
  /* A closed month: the month on a page (R4). */
  function meClosed(m) {
    const t = q.totals(m), prev = q.addMonth(m, -1), p = q.hasData(prev) ? q.totals(prev) : null;
    const hi = D.netWorthHistory.findIndex((h) => h[0] === m), nw = hi >= 0 ? D.netWorthHistory[hi][1] * scopeScale() : null, nwPrev = hi > 0 ? D.netWorthHistory[hi - 1][1] * scopeScale() : null;
    const delta = (now, was, goodUp) => (was == null ? '<span class="muted">first month with records</span>' : Math.abs(now - was) < 0.5 ? '<span class="muted">same as ' + fmt.monthShort(prev) + '</span>' : '<span class="delta ' + ((now >= was) === goodUp ? 'pos' : 'neg') + '">' + (now >= was ? '▲ ' : '▼ ') + fmt.money(Math.abs(now - was)) + '</span> on ' + fmt.monthShort(prev));
    const cats = q.byCat(m).map((c) => Object.assign(c, { usual: q.usual(c.id, m) }));
    const moved = cats.filter((c) => c.usual != null && c.id).sort((a, b) => Math.abs(b.spent - b.usual) - Math.abs(a.spent - a.usual)).slice(0, 3);
    const list = moved.length ? moved : cats.slice(0, 3);
    const max = Math.max.apply(null, list.map((c) => Math.max(c.spent, c.usual || 0)).concat([1]));
    const b = q.budget(m), over = b.lines.filter((l) => l.spent > l.limit);
    return '<div class="me-head"><div><div class="fig-s">' + monthName(m) + '</div><div class="small muted">The month on a page</div></div>' + ui.chip('Closed', 'pos') + '<span class="grow"></span>' + ui.link('Transactions', 'money/activity') + '</div>' +
      ui.card({ flush: true, body: ui.kpis([
        { label: 'Income', value: fmt.money(t.income), sub: delta(t.income, p && p.income, true) },
        { label: 'Spent', value: fmt.money(t.spent), sub: delta(t.spent, p && p.spent, false) },
        { label: 'Saved', value: fmt.money(t.saved), sub: fmt.pct(t.rate) + ' of income' },
        { label: 'Net worth at close', value: nw == null ? '<span class="muted">—</span>' : fmt.money(nw), sub: nw == null ? '' : '<span class="delta ' + (nw >= nwPrev ? 'pos' : 'neg') + '">' + (nw >= nwPrev ? '▲ ' : '▼ ') + fmt.money(Math.abs(nw - nwPrev)) + '</span> on ' + fmt.monthShort(prev) },
      ]) }) +
      '<div class="grid stretch"><div class="c-7 stack-v">' + ui.card({
        title: moved.length ? 'Biggest changes' : 'Biggest categories', info: 'Against each category\'s usual month: the average of up to three earlier months. The tick marks the usual.',
        body: ui.barList(list.map((c) => ({ label: c.name, value: fmt.money(c.spent), frac: c.spent / max, tick: c.usual != null ? c.usual / max : null, note: c.usual != null ? fmt.money(c.spent - c.usual, { plus: true }) + ' vs usual' : '', noteTone: c.usual != null && c.spent > c.usual ? 'warn' : 'muted', action: 'see-cat-month', data: { cat: c.id || 'none' } }))),
      }) + '</div><div class="c-5 stack-v">' + ui.card({
        title: 'Against budget', right: ui.link('Budget', 'money/budget'),
        body: '<div class="fig" style="margin-bottom:12px">' + fmt.money(b.spentBudgeted) + ' <span class="of">of ' + fmt.money(b.budgeted) + '</span></div>' + ui.bar(b.spentBudgeted / b.budgeted, { lg: true, tone: b.spentBudgeted > b.budgeted ? 'neg' : '' }) +
          '<div class="row wrap" style="margin-top:12px">' + (over.length ? over.map((l) => ui.chip(l.name + ' over by ' + fmt.money(l.spent - l.limit), 'neg')).join('') : ui.chip('No category over', 'pos')) + '</div>',
      }) + '</div></div>';
  }
  /* The month still running: nothing to close yet, but a statement can close mid-month. */
  function meRunning(m) {
    const uncat = q.inMonth(m).filter((t) => !t.cat && !t.transfer).length, open = D.statements.filter(stmOpen), bad = open.filter((s) => s.status === 'mismatch').length;
    const unconf = D.accounts.filter((a) => !a.closed && !a.confirmed).length, prevOpen = q.openMonth();
    return '<div class="me-head"><div><div class="fig-s">' + fmt.monthLong(m) + ' is still running</div><div class="small muted">Closes after ' + lastDay(m) + ' ' + fmt.monthShort(m) + '</div></div><span class="grow"></span>' + (prevOpen ? ui.btn('Close ' + fmt.monthLong(prevOpen), 'go-month-end', { kind: 'primary', data: { month: prevOpen } }) : '') + '</div>' +
      ui.card({ flush: true, body: ui.kpis([
        { label: 'Uncategorised so far', value: String(uncat), sub: uncat ? '<button class="link accent" data-action="act-uncat">Categorise →</button>' : ui.chip('All clear', 'pos') },
        { label: 'Statements to check', value: String(open.length), sub: bad ? ui.chip(bad + ' doesn’t match', 'neg') : open.length ? '' : ui.chip('All clear', 'pos') },
        { label: 'Balances not confirmed', value: String(unconf), sub: unconf ? '<button class="link accent" data-action="open-health">Data health →</button>' : ui.chip('All clear', 'pos') },
      ]) }) +
      ui.card({ title: 'Card statements', right: markTicked(), flush: true, body: stmtBlock(D.statements) });
  }

  A['me-open'] = (el, e) => { if (e && e.target.closest('button, input, select')) return; const n = +el.dataset.n; S.meOpen = S.meOpen === n ? 0 : n; RK.render(); };
  A['me-dup-real'] = (el) => { D.transactions.filter((x) => x.dup === el.dataset.dup).forEach((x) => delete x.dup); S.meOpen = null; RK.toast('Kept both'); RK.render(); };
  A['me-dup-del'] = (el) => {
    const i = D.transactions.findIndex((x) => x.id === el.dataset.id); if (i < 0) return;
    const [gone] = D.transactions.splice(i, 1), tag = gone.dup, mates = D.transactions.filter((x) => x.dup === tag);
    mates.forEach((x) => delete x.dup); S.meOpen = null;
    RK.toast('Deleted ' + gone.merchant + ' · ' + fmt.date(gone.date), () => { D.transactions.splice(i, 0, gone); mates.forEach((x) => (x.dup = tag)); });
    RK.render();
  };
  const setDone = (s) => { const prev = { status: s.status, by: s.by, on: s.on }; Object.assign(s, { status: 'done', by: 'maya', on: D.today }); delete S.meTicks[s.id]; return () => Object.assign(s, prev); };
  A['me-stmt-done'] = (el) => { const s = D.statements.find((x) => x.id === el.dataset.id); if (!s) return; const undo = setDone(s); S.meOpen = null; RK.toast(el.dataset.word + ' · ' + q.acc(s.card).name + ' ' + fmt.date(s.from) + ' – ' + fmt.date(s.to), undo); RK.render(); };
  A['me-stmt-reopen'] = (el) => { const s = D.statements.find((x) => x.id === el.dataset.id); if (!s) return; s.status = s.statement != null && Math.abs(s.recorded - s.statement) > 0.005 ? 'mismatch' : 'to-check'; RK.toast('Reopened'); RK.render(); };
  A['me-mark-ticked'] = () => { const list = ticked(); if (!list.length) return; const undos = list.map(setDone); S.meOpen = null; RK.toast('Marked ' + list.length + ' done', () => undos.forEach((u) => u())); RK.render(); };
  RK.inputs['me-tick'] = (el, e) => { if (e.type !== 'change') return; if (el.checked) S.meTicks[el.dataset.id] = true; else delete S.meTicks[el.dataset.id]; RK.render(); };
  A['me-close'] = (el) => {
    const m = el.dataset.month; if (D.closedMonths.includes(m)) return;
    D.closedMonths.push(m); S.meOpen = null;
    RK.toast(fmt.monthLong(m) + ' closed', () => D.closedMonths.splice(D.closedMonths.indexOf(m), 1));
    RK.render({ keepScroll: false });
  };
  A['see-cat-month'] = (el) => { F().cat = el.dataset.cat; F().view = 'list'; RK.go('money/activity'); };

  RK.screens['money/monthend'] = {
    tools: () => ui.monthStepper(),
    render: () => {
      const m = S.month;
      /* Deep link: #/money/monthend?month=2026-10&step=2 (or step=all) opens that step. */
      const hs = (location.hash.match(/[?&]step=(\d|all)/) || [])[1];
      if (hs && S._meHash !== location.hash) { S._meHash = location.hash; S.meOpen = hs === 'all' ? 'all' : +hs; }
      if (!q.hasData(m)) return emptyMonth();
      if (D.closedMonths.includes(m)) return meClosed(m);
      if (m === CUR) return meRunning(m);
      return meSteps(m);
    },
  };

  /* Text fields that save when left (the shell forwards keystrokes, not the final change): budget limits and statement totals. */
  document.addEventListener('change', (e) => {
    const el = e.target, name = el.dataset && el.dataset.input;
    if (name === 'bud-limit') {
      const v = Number(String(el.value).replace(/[^\d.]/g, '')), id = el.dataset.id, prev = D.budgets[id];
      if (!(v >= 0) || v === prev) { el.value = fmt.num(prev); return; }
      D.budgets[id] = v; RK.toast(q.catName(id) + ' limit set to ' + fmt.money(v), () => (D.budgets[id] = prev)); RK.renderSoon();
    }
    if (name === 'me-stmt') {
      const v = Number(String(el.value).replace(/[^\d.]/g, '')), s = D.statements.find((x) => x.id === el.dataset.id);
      if (!s || !(v > 0)) return;
      const prev = { statement: s.statement, status: s.status };
      s.statement = v; s.status = Math.abs(s.recorded - v) < 0.005 ? 'done' : 'mismatch'; S.meOpen = null;
      RK.toast(s.status === 'done' ? 'Matches. Marked done' : 'Doesn’t match by ' + m2(Math.abs(s.recorded - v)), () => Object.assign(s, prev)); RK.renderSoon();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset && (e.target.dataset.input === 'bud-limit' || e.target.dataset.input === 'me-stmt')) e.target.blur(); });
})();
