/* Wealth: Net worth (with the accounts ledger), Investments, Dividends.
   Also owns the account and holding editors, which other screens open by action. */
(function () {
  const RK = window.RK;
  const { fmt, q, ui, charts } = RK;
  const D = RK.data, S = RK.state, A = RK.actions;
  const esc = fmt.esc;
  const blank = '<span></span>';

  S.nwGroup = S.nwGroup || 'type';
  S.invGroup = S.invGroup || 'all';
  S.invRange = S.invRange || '6M';
  S.divView = S.divView || 'income';
  S.divMode = S.divMode || 'received';

  const isDebt = (a) => a.type === 'Credit card' || a.type === 'Loan';
  const accVal = (a) => q.accAed(a) * q.share(a.owner);
  const scopeAccts = () => D.accounts.filter((a) => !a.closed && q.share(a.owner) > 0);
  const avgSpend = () => { const ended = D.months.filter((m) => m < D.today.slice(0, 7) && q.hasData(m)); return ended.reduce((s, m) => s + q.totals(m).spent, 0) / (ended.length || 1); };
  const signed = (v, cls) => '<span class="' + (v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted') + (cls ? ' ' + cls : '') + '">' + fmt.money(v, { plus: true }) + '</span>';
  const pctSigned = (v, dec) => (v > 0 ? '+' : '') + fmt.pct(v, dec == null ? 1 : dec);
  const numIn = (s) => Number(String(s == null ? '' : s).replace(/,/g, '')) || 0;

  /* ================= Net worth ================= */
  function heroCard(nw, hist) {
    const months = q.cashOnHand() / (avgSpend() || 1);
    const yr = hist[0] ? ((nw.net - hist[0]) / hist[0]) * 100 : 0;
    const p = nw.provisional;
    return ui.card({
      cls: 'c-5 fill', title: 'Net worth',
      body: '<div class="row" style="align-items:baseline;gap:10px;flex-wrap:wrap"><div class="hero-fig"><span class="code">' + S.currency + '</span>' + fmt.money(nw.net) + '</div>' + (p.length ? ui.chip('Provisional', 'warn', 'open-health') : '') + '</div>' +
        '<div class="kpi-s"><span class="delta ' + (nw.change >= 0 ? 'pos' : 'neg') + '">' + (nw.change >= 0 ? '▲ ' : '▼ ') + fmt.money(Math.abs(nw.change)) + '</span> this month<span class="muted">· ' + pctSigned(yr) + ' in 12 months</span></div>' +
        (p.length ? '<div style="margin-top:14px">' + ui.warnRow(esc(p.map((a) => a.name).join(', ')) + ' · not confirmed, counted as zero', ui.btn('Confirm', 'open-account', { sm: true, data: { id: p[0].id } })) + '</div>' : '') +
        '<div class="push-gap"></div><div class="nw-mini push"><div><div class="kpi-l">Assets</div><div class="fig-s">' + fmt.money(nw.assets) + '</div></div><div><div class="kpi-l">Liabilities</div><div class="fig-s">' + fmt.money(-nw.liabilities) + '</div></div><div><div class="kpi-l">Runway' + ui.info('Cash in current, savings and cash accounts, divided by an average month of spending.') + '</div><div class="fig-s">' + Math.round(months) + ' <span class="muted small" style="font-weight:400">months</span></div></div></div>',
    });
  }

  function grownCard(nw, hist) {
    const H = D.netWorthHistory, open = q.openMonth();
    const vals = hist.concat([nw.net]);
    const labels = {};
    H.forEach((h, i) => { if (i % 3 === 0) labels[i] = i === 0 ? fmt.month(h[0]) : fmt.monthShort(h[0]); });
    labels[vals.length - 1] = 'Today';
    const tips = H.map((h, i) => fmt.month(h[0]) + ' · ' + fmt.money(hist[i]) + (h[0] === open ? ' · not closed' : '')).concat(['Today · ' + fmt.money(nw.net)]);
    const hollow = open ? [H.findIndex((h) => h[0] === open)].filter((i) => i >= 0) : [];
    const step = 25000 * (S.scope === 'both' ? 1 : 0.5);
    const lo = Math.floor(Math.min.apply(null, vals) / step) * step;
    const rows = [{ cells: ['<span class="name">Today</span> <span class="muted small">live</span>', fmt.money(nw.net), signed(nw.net - hist[hist.length - 1])] }]
      .concat(H.map((h, i) => ({ cells: [fmt.month(h[0]) + (h[0] === open ? ' ' + ui.chip('Not closed', 'warn') : ''), fmt.money(hist[i]), i ? signed(hist[i] - hist[i - 1]) : ''] })).reverse());
    return ui.card({
      cls: 'c-7', title: 'How it has grown', flush: true,
      right: open ? ui.btn('Close ' + fmt.monthLong(open), 'go-month-end', { sm: true, data: { month: open } }) : '',
      body: '<div style="padding:6px 18px 10px">' + charts.slot('nw-trend', 176, (w, h) => charts.line(w, h, { values: vals, labels, tips, hollow, min: lo })) +
        ui.readout([['Month end', null, 'var(--accent)'], open ? [fmt.monthLong(open) + ' is not closed yet', null] : ['Every month is closed', null]]) + '</div>' +
        ui.fold('History as a table', ui.table({ compact: true, cols: [{ label: 'Month' }, { label: 'Net worth', num: true, width: '140px' }, { label: 'Change', num: true, width: '120px' }], rows })),
    });
  }

  function accRow(a, showType) {
    const sub = [];
    if (showType && a.type !== a.name) sub.push(a.type);
    if (a.ccy !== 'AED') sub.push(fmt.native(a.balance, a.ccy, 0));
    if (a.matures) sub.push('matures ' + fmt.date(a.matures) + ' · ' + a.rate + '%');
    const age = a.confirmed ? -fmt.days(a.confirmed) : null;
    const status = !a.confirmed ? '<span class="row" style="justify-content:flex-end">' + ui.chip('Not confirmed', 'warn') + ui.btn('Confirm', 'open-account', { sm: true, data: { id: a.id } }) + '</span>'
      : age > 30 ? '<span class="row" style="justify-content:flex-end">' + ui.chip('Checked ' + age + 'd ago') + '</span>' : blank;
    return { action: 'open-account', data: { id: a.id }, cells: [
      sub.length ? { cls: 'two', html: ui.two(esc(a.name), esc(sub.join(' · '))) } : '<span class="name">' + esc(a.name) + '</span>',
      ui.avatar(a.owner), status,
      a.confirmed ? fmt.money(accVal(a)) : '<span class="muted" data-tip="Counted as zero until confirmed">Not counted</span>',
    ] };
  }
  const groupRow = (label, total) => ({ cls: 'group', cells: [{ html: esc(label), span: 3 }, { html: total == null ? '' : fmt.money(total), cls: 'num' }] });

  function assetsCard(nw) {
    const accts = scopeAccts().filter((a) => !isDebt(a));
    const groups = S.nwGroup === 'owner'
      ? [['shared', 'Shared']].concat(D.members.map((m) => [m.id, m.name])).map((g) => [g[1], accts.filter((a) => a.owner === g[0])])
      : [['Current accounts', ['Current']], ['Savings', ['Savings']], ['Cash', ['Cash']], ['Deposits and broker funds', ['Fixed deposit', 'Broker funds']]].map((g) => [g[0], accts.filter((a) => g[1].includes(a.type)), g[1].length > 1]);
    let rows = [];
    groups.forEach((g) => {
      if (!g[1].length) return;
      rows.push(groupRow(g[0], g[1].filter((a) => a.confirmed).reduce((s, a) => s + accVal(a), 0)));
      rows = rows.concat(g[1].map((a) => accRow(a, S.nwGroup === 'owner' || g[2])));
    });
    const held = D.holdings.filter((h) => q.share(h.owner) > 0), stale = held.filter((h) => h.stale).length;
    if (held.length) {
      rows.push(groupRow('Invested', null));
      rows.push({ action: 'go', data: { route: 'wealth/investments' }, cells: [{ cls: 'two', html: ui.two('Investments', held.length + ' holdings') }, blank, stale ? '<span class="row" style="justify-content:flex-end">' + ui.chip(stale + ' stale price', 'warn') + '</span>' : blank, fmt.money(q.investments()) + ' <span class="muted">→</span>'] });
    }
    rows.push({ cls: 'total', cells: [{ html: 'Total assets', span: 3 }, { html: fmt.money(nw.assets), cls: 'num' }] });
    return ui.card({ cls: 'c-7', title: 'Assets', right: accts.length + ' accounts', flush: true, body: ui.table({ cols: [{ label: 'Account' }, { label: 'Owner', width: '64px' }, { label: '', width: '200px' }, { label: 'Amount', num: true, width: '130px' }], rows }) });
  }

  function closesIn(day) {
    const t = new Date(D.today), next = new Date(t.getFullYear(), t.getMonth() + (day > t.getDate() ? 0 : 1), day);
    return Math.round((next - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
  }
  /* A card's running cycle: from the day after its last statement day to the next one, with what was spent on it. */
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function cycle(a) {
    const t = new Date(D.today), back = t.getDate() > a.statementDay ? 0 : 1;
    const from = iso(new Date(t.getFullYear(), t.getMonth() - back, a.statementDay + 1)), to = iso(new Date(t.getFullYear(), t.getMonth() - back + 1, a.statementDay));
    const rows = D.transactions.filter((x) => x.account === a.id && !x.scheduled && !x.transfer && x.date >= from && x.date <= D.today).sort((x, y) => (x.date < y.date ? 1 : -1));
    const dueT = new Date(t.getFullYear(), t.getMonth() + (t.getDate() > a.dueDay ? 1 : 0), a.dueDay);
    return { from, to, rows, spent: -rows.reduce((s, x) => s + x.amount, 0), due: iso(dueT) };
  }
  function liabilitiesCard(nw) {
    const accts = scopeAccts().filter(isDebt);
    const rows = accts.map((a) => {
      const card = a.type === 'Credit card', used = card && a.limit ? -a.balance / a.limit : 0;
      return { action: 'open-account', data: { id: a.id }, cells: [
        { cls: 'two', html: ui.two(esc(a.name), card ? fmt.money(cycle(a).spent) + ' this cycle · closes in ' + closesIn(a.statementDay) + 'd' : esc(a.type)) },
        ui.avatar(a.owner),
        card ? '<div class="util">' + ui.bar(used) + '<span class="sub">' + fmt.pct(used * 100) + ' of ' + fmt.money(a.limit) + '</span></div>' : blank,
        '<span class="neg">' + fmt.money(accVal(a)) + '</span>',
      ] };
    });
    rows.push({ cls: 'total', cells: [{ html: 'Total liabilities', span: 3 }, { html: fmt.money(-nw.liabilities), cls: 'num' }] });
    const closed = D.accounts.filter((a) => a.closed);
    return ui.card({
      title: 'Liabilities', right: accts.length + ' accounts', flush: true,
      body: (accts.length ? ui.table({ cols: [{ label: 'Account' }, { label: 'Owner', width: '56px' }, { label: 'Limit used', width: '130px' }, { label: 'Owed', num: true, width: '96px' }], rows }) : ui.empty('Nothing owed', '', '', 'check')) +
        (closed.length ? ui.fold('Closed (' + closed.length + ')', '<div class="rows">' + closed.map((a) => '<div class="rw"><div class="rw-main"><div class="rw-t">' + esc(a.name) + '</div><div class="rw-s">' + esc(q.ownerName(a.owner)) + ' · ' + esc(a.type) + ' · stays in history</div></div>' + ui.btn('Reopen', 'nw-reopen', { sm: true, data: { id: a.id } }) + '</div>').join('') + '</div>') : ''),
    });
  }

  A['nw-group'] = (el) => { S.nwGroup = el.dataset.value; RK.render(); };
  A['nw-reopen'] = (el) => { const a = q.acc(el.dataset.id); a.closed = false; RK.toast('Reopened ' + a.name, () => (a.closed = true)); RK.render(); };

  RK.screens['wealth/networth'] = {
    tools: () => ui.seg('nw-group', [['type', 'By type'], ['owner', 'By owner']], S.nwGroup) + ui.btn('Account', 'open-account', { kind: 'primary', icon: 'plus' }),
    render: () => {
      const nw = q.netWorth(), scale = S.scope === 'both' ? 1 : 0.5;
      const hist = D.netWorthHistory.map((h) => h[1] * scale);
      const parts = Object.keys(nw.parts).map((k) => ({ label: k, value: nw.parts[k] }));
      return '<div class="grid stretch">' + heroCard(nw, hist) + grownCard(nw, hist) + '</div>' +
        '<div class="grid">' + assetsCard(nw) + '<div class="c-5 stack-v">' + liabilitiesCard(nw) +
        ui.card({ title: 'What the assets are', right: fmt.money(nw.assets) + ' in all', body: ui.stack(parts) }) + '</div></div>';
    },
  };

  /* ---------- account editor ---------- */
  const TYPES = ['Current', 'Savings', 'Cash', 'Fixed deposit', 'Broker funds', 'Credit card', 'Loan'];
  /* ---------- card view: a credit card opens on its running cycle, with its statements one tab away ---------- */
  const STMT = { 'to-check': ['To check', 'warn'], waiting: ['Waiting', ''], mismatch: ['Doesn’t match', 'neg'], done: ['Done', 'pos'] };
  const cardTabs = (a, tab) => '<div class="dr-tabs" style="margin:-18px -22px 2px">' + [['cycle', 'This cycle'], ['statements', 'Statements'], ['details', 'Details']].map((t) => '<button type="button" class="' + (t[0] === tab ? 'on' : '') + '" data-action="open-account" data-id="' + a.id + '" data-tab="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
  function cycleBody(a) {
    const c = cycle(a), used = a.limit ? -a.balance / a.limit : 0, last = D.statements.filter((s) => s.card === a.id).sort((x, y) => (x.to < y.to ? 1 : -1))[0];
    return '<div class="kpis" style="margin:0 -22px;border-bottom:1px solid var(--rule)">' +
      '<div class="kpi"><div class="kpi-l">Owed</div><div class="fig neg">' + fmt.money(a.balance) + '</div><div class="kpi-s">checked ' + fmt.date(a.confirmed) + '</div></div>' +
      '<div class="kpi"><div class="kpi-l">Spent this cycle' + ui.info('Purchases less refunds recorded on this card since its last statement day.') + '</div><div class="fig">' + fmt.money(c.spent) + '</div><div class="kpi-s">' + c.rows.length + ' transactions</div></div>' +
      '<div class="kpi"><div class="kpi-l">Limit used</div><div class="fig">' + fmt.pct(used * 100) + '</div><div class="kpi-s" style="display:block">' + ui.bar(used, { tone: used > 0.8 ? 'neg' : '' }) + '<div style="margin-top:5px">of ' + fmt.money(a.limit) + '</div></div></div></div>' +
      '<dl class="kv"><dt>Cycle</dt><dd>' + fmt.date(c.from) + ' – ' + fmt.date(c.to) + ' <span class="muted">· closes in ' + closesIn(a.statementDay) + 'd</span></dd>' +
      '<dt>Payment due</dt><dd>' + (last && last.due >= D.today ? fmt.date(last.due) + ' <span class="muted">· ' + fmt.money(last.recorded, { dec: 2 }) + ' for the statement to ' + fmt.date(last.to) + '</span>' : fmt.date(c.due) + ' <span class="muted">· for the cycle that closes ' + fmt.date(c.to) + '</span>') + '</dd></dl>' +
      '<div class="dr-sec">On this card since ' + fmt.date(c.from) + '</div>' +
      (c.rows.length ? '<div style="margin:0 -22px">' + ui.table({ compact: true, cols: [{ label: 'Date', width: '76px' }, { label: 'Merchant' }, { label: 'Category', width: '130px' }, { label: 'Amount', num: true, width: '90px' }], rows: c.rows.map((t) => ({ action: 'open-txn', data: { id: t.id }, cells: ['<span class="mono muted">' + fmt.date(t.date) + '</span>', '<div class="truncate" style="max-width:210px" title="' + esc(t.merchant) + '"><span class="name">' + esc(t.merchant) + '</span></div>', '<span class="ink2">' + esc(q.catName(t.cat)) + '</span>', '<span class="' + (t.amount > 0 ? 'pos' : '') + '">' + fmt.money(t.amount, { plus: true }) + '</span>'] })) }) + '</div>' : '<div class="small muted">Nothing on this card yet this cycle.</div>') +
      '<div>' + ui.btn('All transactions on this card', 'nw-card-activity', { kind: 'text', sm: true, data: { id: a.id } }) + '</div>';
  }
  function cardStatements(a) {
    const list = D.statements.filter((s) => s.card === a.id).sort((x, y) => (x.to < y.to ? 1 : -1)), open = list.filter((s) => s.status !== 'done').length;
    const m2 = (v) => fmt.money(v, { dec: 2 });
    return '<div class="row between"><span class="small ink2">Closes on the ' + fmt.ord(a.statementDay) + ' · due on the ' + fmt.ord(a.dueDay) + '</span>' + (open ? ui.chip(open + ' to check', 'warn') : ui.chip('All checked', 'pos')) + '</div>' +
      (list.length ? '<div style="margin:0 -22px">' + ui.table({ compact: true, cols: [{ label: 'Period' }, { label: 'In Rokda', num: true, info: 'What was spent on the card over the period, refunds netted, in AED.' }, { label: 'Statement', num: true }, { label: 'Difference', num: true }, { label: 'Status', width: '110px' }],
        rows: list.map((s) => { const d = s.statement == null ? null : s.recorded - s.statement; return { cells: ['<span class="name">' + fmt.date(s.from) + ' – ' + fmt.date(s.to) + '</span>', m2(s.recorded), s.statement == null ? '<span class="muted">Not entered</span>' : m2(s.statement), d == null ? '' : Math.abs(d) < 0.005 ? '<span class="pos">Matches</span>' : '<span class="neg">' + m2(Math.abs(d)) + (d > 0 ? ' higher' : ' lower') + '</span>', ui.chip(STMT[s.status][0], STMT[s.status][1])] }; }) }) + '</div>' : '<div class="small muted">No statements yet. They start once the card has a statement day.</div>') +
      '<div>' + ui.btn('Check statements in Month end', 'go', { kind: 'text', sm: true, data: { route: 'money/monthend', month: q.openMonth() || D.today.slice(0, 7) } }) + '</div>';
  }
  A['nw-card-activity'] = (el) => { Object.assign(S.activity, { account: el.dataset.id, range: 'all', view: 'list', q: '', cat: '' }); RK.drawer.close(); RK.go('money/activity'); };

  function openAccount(id, tab) {
    const a = id ? q.acc(id) : null;
    const v = a || { name: '', type: 'Current', owner: 'shared', ccy: 'AED', balance: '' };
    const isCard = !!a && a.type === 'Credit card';
    tab = isCard ? tab || 'cycle' : 'details';
    if (isCard && tab !== 'details') {
      RK.drawer.open({ kicker: 'Credit card · ' + q.ownerName(a.owner), title: a.name, wide: true, body: cardTabs(a, tab) + (tab === 'cycle' ? cycleBody(a) : cardStatements(a)), footer: '<span class="grow"></span>' + ui.btn('Close', 'drawer-close') });
      return;
    }
    RK.drawer.open({
      kicker: a ? 'Edit account' : 'New account', title: a ? a.name : 'Add an account', wide: isCard,
      body:
        (isCard ? cardTabs(a, 'details') : '') +
        (a && !a.confirmed ? ui.warnRow('Balance not confirmed. Counted as zero until it is.') : '') +
        '<div class="field"><label>' + (isDebt(v) ? 'Balance owed' : 'Current balance') + '</label><div class="amount"><span>' + v.ccy + '</span><input name="balance" inputmode="decimal" value="' + (v.balance === '' ? '' : fmt.num(v.balance)) + '" placeholder="0"></div>' +
        (a && a.ccy !== 'AED' ? '<div class="hint">About AED ' + fmt.num(Math.abs(q.accAed(a))) + ' at today\'s rate</div>' : '') + '</div>' +
        ui.switchField('confirm', true, 'Confirm this balance', 'Records it as of the date below') +
        ui.field('Balance as of', ui.input('asof', D.today, { type: 'date' })) +
        ui.field('Name', ui.input('name', v.name, { placeholder: 'e.g. Savings' })) +
        ui.fieldRow(ui.field('Type', ui.select(null, TYPES.map((t) => [t, t]), v.type, { name: 'type' })), ui.field('Currency', ui.select(null, [['AED', 'AED'], ['USD', 'USD'], ['INR', 'INR']], v.ccy, { name: 'ccy' }))) +
        ui.field('Owner', ui.select(null, ui.ownerOptions(), v.owner, { name: 'owner' })) +
        (v.type === 'Credit card' ? '<div class="dr-sec">Card</div>' + ui.field('Credit limit', ui.input('limit', v.limit ? fmt.num(v.limit) : '')) + ui.fieldRow(ui.field('Statement day', ui.input('statementDay', v.statementDay)), ui.field('Due day', ui.input('dueDay', v.dueDay))) : '') +
        (v.type === 'Fixed deposit' ? '<div class="dr-sec">Deposit terms</div>' + ui.fieldRow(ui.field('Rate, % a year', ui.input('rate', v.rate)), ui.field('Matures', ui.input('matures', v.matures, { type: 'date' }))) : '') +
        (a && a.confirmed ? '<div class="dr-sec">History</div><div class="small muted">Last confirmed ' + fmt.date(a.confirmed) + ' · ' + fmt.native(Math.abs(a.balance), a.ccy, 0) + (isDebt(a) ? ' owed' : '') + '</div>' : ''),
      footer: (a ? '<span id="dr-del">' + ui.btn('Close account', 'nw-ask-close', { kind: 'danger', data: { id: a.id } }) + '</span>' : '') + '<span class="grow"></span>' + ui.btn('Cancel', 'drawer-close') + ui.btn(a ? 'Save' : 'Add account', 'nw-account-save', { kind: 'primary', data: { id: a ? a.id : '' } }),
    });
  }
  A['open-account'] = (el) => { RK.popClose(); RK.drawer.dirty = false; openAccount(el && el.dataset.id, el && el.dataset.tab); };
  A['nw-ask-close'] = (el) => {
    const host = el.parentElement; host.dataset.prev = host.innerHTML;
    host.innerHTML = '<span class="row"><span class="small">Close it?</span>' + ui.btn('Close account', 'nw-account-close', { kind: 'danger', sm: true, data: { id: el.dataset.id } }) + ui.btn('Keep', 'keep-delete', { sm: true }) + '</span>';
  };
  A['nw-account-close'] = (el) => {
    const a = q.acc(el.dataset.id); a.closed = true;
    RK.drawer.close(); RK.toast('Closed ' + a.name + '. Its transactions stay in history.', () => (a.closed = false)); RK.render();
  };
  A['nw-account-save'] = (el) => {
    const f = RK.drawer.values();
    if (!f.name) { RK.toast('Name the account'); return; }
    let a = el.dataset.id ? q.acc(el.dataset.id) : null;
    const isNew = !a;
    if (!a) { a = { id: 'a' + Date.now(), confirmed: null }; D.accounts.push(a); }
    const amt = Math.abs(numIn(f.balance));
    Object.assign(a, { name: f.name, type: f.type, ccy: f.ccy, owner: f.owner, balance: f.type === 'Credit card' || f.type === 'Loan' ? -amt : amt });
    ['limit', 'statementDay', 'dueDay', 'rate'].forEach((k) => { if (f[k] !== undefined && f[k] !== '') a[k] = numIn(f[k]); });
    if (f.matures) a.matures = f.matures;
    if (f.confirm) a.confirmed = f.asof || D.today;
    RK.drawer.close();
    RK.toast((isNew ? 'Added ' : 'Saved ') + a.name + (f.confirm ? ' · balance confirmed' : ''));
    RK.render();
  };

  /* ================= Investments ================= */
  const GROUPS = { all: () => true, global: (h) => h.cls === 'US equity', india: (h) => h.cls === 'India equity', commodities: (h) => h.cls === 'Commodity' };
  const invList = () => D.holdings.filter((h) => q.share(h.owner) > 0 && GROUPS[S.invGroup](h));
  const hv = (h) => q.holdAed(h) * q.share(h.owner);
  const hc = (h) => q.holdCostAed(h) * q.share(h.owner);
  const RANGE = { '1M': 30, '3M': 90, '6M': 180 };

  function invKpis(list, value, cost) {
    const profit = value - cost, today = list.reduce((s, h) => s + (hv(h) * h.day) / 100, 0);
    const sold = D.sold.filter((x) => q.share(x.owner) > 0), soldP = sold.reduce((s, x) => s + x.profit * q.share(x.owner), 0);
    return ui.card({ flush: true, body: ui.kpis([
      { label: 'Value', hero: true, value: '<span class="code">' + S.currency + '</span>' + fmt.money(value) },
      { label: 'Invested', value: fmt.money(cost) },
      { label: 'Profit not yet taken', value: fmt.money(profit, { plus: true }), tone: profit >= 0 ? 'pos' : 'neg', sub: cost ? pctSigned((profit / cost) * 100) + ' on cost' : '' },
      { label: 'Profit on sales this year', value: sold.length ? fmt.money(soldP, { plus: true }) : '<span class="muted">None</span>', tone: soldP > 0 ? 'pos' : '', sub: sold.length ? sold.length + ' sale' + (sold.length > 1 ? 's' : '') : '' },
      { label: 'Change today', value: fmt.money(today, { plus: true }), tone: today >= 0 ? 'pos' : 'neg', sub: value ? pctSigned((today / value) * 100, 2) : '' },
    ]) });
  }

  function invChart(value) {
    const n = RANGE[S.invRange], H = D.investHistory, f = value / H[H.length - 1];
    const vals = H.slice(-n).map((v) => v * f);
    const span = Math.max.apply(null, vals) - Math.min.apply(null, vals) || 1;
    const step = Math.pow(10, Math.floor(Math.log10(span)));
    const lo = Math.floor(Math.min.apply(null, vals) / step) * step;
    const day = (i) => { const d = new Date(D.today); d.setDate(d.getDate() - (n - 1 - i)); return d.toISOString().slice(0, 10); };
    const labels = {}; labels[0] = fmt.date(day(0)); labels[Math.floor(n / 2)] = fmt.date(day(Math.floor(n / 2))); labels[n - 1] = 'Today';
    const change = vals[n - 1] - vals[0];
    return ui.card({
      cls: 'c-8', title: 'Value over time',
      titleExtra: ui.chip('Partial history', 'warn', 'info', { text: 'Sukuk has no value recorded before 30 Sep, so earlier days leave it out. The change includes money added or withdrawn, not investment return alone.' }),
      right: ui.seg('inv-range', [['1M', '1M'], ['3M', '3M'], ['6M', '6M']], S.invRange),
      body: charts.slot('inv-trend', 212, (w, h) => charts.line(w, h, { values: vals, labels, min: lo, tips: vals.map((v, i) => fmt.date(day(i)) + ' · ' + fmt.money(v)) })) +
        ui.readout([['Change · ' + S.invRange, signed(change) + ' <span class="muted" style="font-weight:400">' + pctSigned((change / vals[0]) * 100) + '</span>'], ['Today', fmt.money(value)]]),
    });
  }

  function allocationCard(list, value) {
    const cls = {};
    list.forEach((h) => (cls[h.cls] = (cls[h.cls] || 0) + hv(h)));
    const top = list.slice().sort((a, b) => hv(b) - hv(a))[0];
    const share = top ? hv(top) / value : 0, cap = D.concentrationCap / 100, over = share > cap;
    const scale = Math.max(0.5, share * 1.25);
    const untagged = list.filter((h) => !h.sector && h.cls !== 'Sukuk');
    return ui.card({
      cls: 'c-4 fill', title: 'Allocation',
      body: ui.stack(Object.keys(cls).map((k) => ({ label: k, value: cls[k] }))) +
        '<div class="push-gap"></div><div class="inv-conc push"><div class="row between small" style="margin-bottom:8px"><span class="ink2 row" style="gap:6px">Largest holding' + ui.info('The biggest single holding as a share of everything invested, against the household\'s cap. The tick marks the cap.') + '</span><span class="muted">cap ' + D.concentrationCap + '%</span></div>' +
        '<div class="row between" style="margin-bottom:8px"><span class="name truncate">' + esc(top ? top.name : '—') + '</span><span class="fig-s">' + fmt.pct(share * 100) + '</span></div>' +
        ui.bar(share / scale, { lg: true, tick: cap / scale, tone: over ? 'warnb' : '' }) +
        '<div class="row" style="margin-top:12px;flex-wrap:wrap">' + (over ? ui.chip('Above ' + D.concentrationCap + '% cap', 'warn') : ui.chip('Within ' + D.concentrationCap + '% cap', 'pos')) +
        (untagged.length ? ui.chip(untagged.length + ' untagged', 'warn', 'open-holding', { id: untagged[0].id }) : '') + '<span class="grow"></span>' + ui.btn('Change cap', 'inv-cap', { kind: 'text', sm: true }) + '</div></div>',
    });
  }

  function holdingsCard(list, value) {
    const px = (v, ccy) => fmt.num(v, 2) + ' <span class="muted small">' + ccy + '</span>';
    const rows = list.slice().sort((a, b) => hv(b) - hv(a)).map((h) => {
      const v = hv(h), c = hc(h), p = v - c;
      return { action: 'open-holding', data: { id: h.id }, cells: [
        { cls: 'two', html: ui.two(esc(h.name) + (h.stale ? ' ' + ui.chip('Stale price', 'warn') : '') + (!h.sector && h.cls !== 'Sukuk' ? ' ' + ui.chip('Untagged') : ''), esc(h.cls) + (h.sector ? ' · ' + esc(h.sector) : '')) },
        ui.avatar(h.owner), fmt.num(h.units), px(h.avg, h.ccy),
        h.feed ? px(h.price, h.ccy) : '<span class="muted small">manual</span>',
        fmt.money(c),
        { cls: 'num two', html: '<div class="name">' + fmt.money(v) + '</div><div class="sub">' + fmt.pct((v / value) * 100) + ' of total</div>' },
        { cls: 'num two', html: '<div>' + signed(p) + '</div><div class="sub">' + (c ? pctSigned((p / c) * 100) : '') + '</div>' },
        h.day ? '<span class="' + (h.day > 0 ? 'pos' : 'neg') + '">' + pctSigned(h.day, 2) + '</span>' : '<span class="muted">0.00%</span>',
      ] };
    });
    const sold = D.sold.filter((x) => q.share(x.owner) > 0);
    return ui.card({
      title: 'Holdings', right: list.length + ' held', flush: true,
      body: ui.table({ cols: [{ label: 'Holding' }, { label: 'Owner', width: '60px' }, { label: 'Units', num: true }, { label: 'Avg price', num: true }, { label: 'Price now', num: true }, { label: 'Invested', num: true }, { label: 'Value', num: true }, { label: 'Profit', num: true }, { label: 'Today', num: true, width: '80px' }], rows }) +
        (sold.length ? ui.fold('Sold (' + sold.length + ')', '<div class="rows">' + sold.map((x) => '<div class="rw"><div class="rw-main"><div class="rw-t">' + esc(x.name) + '</div><div class="rw-s">' + esc(q.ownerName(x.owner)) + ' · sold out on ' + fmt.date(x.soldOn) + '</div></div><span class="num">' + signed(x.profit * q.share(x.owner)) + ' <span class="muted small">profit</span></span></div>').join('') + '</div>') : ''),
    });
  }

  function refreshPrices() {
    if (S.invBusy) return;
    S.invBusy = true; RK.render();
    setTimeout(() => {
      const d = new Date();
      D.prices.failed = false;
      D.prices.lastGood = D.today + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      D.holdings.forEach((h) => delete h.stale);
      S.invBusy = false;
      RK.toast('Prices refreshed');
      RK.render();
    }, 900);
  }
  A['inv-refresh'] = refreshPrices;
  A['inv-group'] = (el) => { S.invGroup = el.dataset.value; RK.render(); };
  A['inv-range'] = (el) => { S.invRange = el.dataset.value; RK.render(); };
  A['inv-cap'] = (el) => RK.pop(el, '<div style="color:var(--ink);font-weight:500;margin-bottom:8px">No single holding above</div><div class="row"><input class="inp sm" id="inv-cap-in" style="width:64px" inputmode="numeric" value="' + D.concentrationCap + '"><span>% of investments</span></div><div class="row between" style="margin-top:10px"><span class="small muted">For the household</span>' + ui.btn('Save', 'inv-cap-save', { sm: true, kind: 'primary' }) + '</div>');
  A['inv-cap-save'] = () => {
    const v = Number(document.getElementById('inv-cap-in').value);
    if (!(v > 0 && v <= 100)) { RK.toast('Enter a share above 0 and at most 100'); return; }
    D.concentrationCap = v; RK.popClose(); RK.toast('Cap set to ' + v + '%'); RK.render();
  };

  RK.screens['wealth/investments'] = {
    tools: () => {
      const stale = D.holdings.filter((h) => h.stale && q.share(h.owner) > 0);
      return ui.seg('inv-group', [['all', 'All'], ['global', 'Global'], ['india', 'India'], ['commodities', 'Commodities']], S.invGroup) +
        '<span class="mono muted nowrap" style="margin-left:6px">Prices ' + fmt.time(D.prices.lastGood) + '</span>' +
        (stale.length ? ui.chip(stale.length + ' stale', 'warn', 'open-holding', { id: stale[0].id }) : '') +
        ui.btn(S.invBusy ? 'Refreshing…' : 'Refresh prices', 'inv-refresh', { disabled: S.invBusy }) +
        ui.btn('Holding', 'open-holding', { kind: 'primary', icon: 'plus' });
    },
    banner: () => D.prices.failed ? '<div class="banner">' + ui.icon('alert') + '<div class="grow"><b style="font-weight:600">Couldn’t refresh prices.</b> Showing prices from ' + fmt.time(D.prices.lastGood) + '.</div>' + ui.btn(S.invBusy ? 'Trying…' : 'Try again', 'inv-refresh', { sm: true, disabled: S.invBusy }) + '</div>' : '',
    render: () => {
      const list = invList();
      if (!list.length) return ui.card({ body: ui.empty('No holdings in this view', 'Nothing matches this group for ' + (S.scope === 'both' ? 'the household' : q.ownerName(S.scope)) + '.', ui.btn('Show all', 'inv-group', { data: { value: 'all' } }), 'chart') });
      const value = list.reduce((s, h) => s + hv(h), 0), cost = list.reduce((s, h) => s + hc(h), 0);
      return invKpis(list, value, cost) + '<div class="grid stretch">' + invChart(value) + allocationCard(list, value) + '</div>' + holdingsCard(list, value);
    },
  };

  /* ---------- holding editor ---------- */
  const CLASSES = ['US equity', 'India equity', 'Commodity', 'Sukuk', 'UAE equity', 'Cash'];
  const SECTORS = ['Spread across sectors', 'Technology', 'Infrastructure', 'Financials', 'Energy', 'Consumer', 'Health care'];
  function tradesFor(h) {
    const a = Math.round(h.units * 0.6), b = h.units - a;
    return [{ date: '2026-08-12', text: 'Buy ' + fmt.num(b) + ' at ' + fmt.native(h.avg * 1.06, h.ccy, 2), fee: 4 }, { date: '2026-02-10', text: 'Buy ' + fmt.num(a) + ' at ' + fmt.native(h.avg * 0.96, h.ccy, 2), fee: 6 }];
  }
  function openHolding(id, tab) {
    const h = id ? q.holding(id) : null;
    tab = h ? tab || 'details' : 'details';
    const v = h || { name: '', cls: 'US equity', sector: '', ccy: 'USD', owner: 'shared', units: '', avg: '', price: '', feed: true };
    let body, footer;
    if (tab === 'trades') {
      body = '<div class="row between"><div class="card-t">Trades</div>' + ui.btn('Record a trade', 'inv-trade', { sm: true, icon: 'plus' }) + '</div>' +
        '<div class="rows" style="margin:0 -22px">' + tradesFor(h).map((t) => '<div class="rw" style="padding:8px 22px"><span class="rw-date">' + fmt.date(t.date) + '</span><div class="rw-main"><div class="rw-t">' + esc(t.text) + '</div><div class="rw-s">brokerage ' + fmt.native(t.fee, h.ccy, 2) + '</div></div>' + ui.btn('Fix', 'inv-trade', { sm: true, kind: 'text' }) + '</div>').join('') + '</div>' +
        '<div class="dr-sec">From trades</div><dl class="kv"><dt>Units</dt><dd>' + fmt.num(h.units) + '</dd><dt>Average price</dt><dd>' + fmt.native(h.avg, h.ccy, 2) + '</dd></dl>';
      footer = '<span class="grow"></span>' + ui.btn('Close', 'drawer-close');
    } else if (tab === 'dividends') {
      const d = D.dividends.byHolding.find((x) => x.holding === h.id), coming = D.dividends.coming.filter((x) => x.holding === h.id);
      body = d ? '<dl class="kv"><dt>Rhythm</dt><dd>' + esc(d.rhythm) + '</dd><dt>Last payment</dt><dd>' + fmt.money(d.last, { code: true }) + '</dd><dt>Received · 12 months</dt><dd>' + fmt.money(d.received, { code: true }) + '</dd><dt>Expected · 12 months</dt><dd>' + fmt.money(d.expected, { code: true }) + '</dd><dt>Yield</dt><dd>' + fmt.pct(d.yieldValue, 1) + ' on value · ' + fmt.pct(d.yieldCost, 1) + ' on cost</dd><dt>Withholding</dt><dd>' + D.dividends.withholding[d.market] + '%</dd></dl>' +
        (coming.length ? '<div class="dr-sec">Coming up</div><div class="rows" style="margin:0 -22px">' + coming.map((c) => '<div class="rw" style="padding:8px 22px"><span class="rw-date">' + fmt.date(c.date) + '</span><div class="rw-main"><div class="rw-t">' + fmt.native(c.native[0], c.native[1], 2) + '</div><div class="rw-s">' + esc(c.state) + '</div></div><span class="num">' + fmt.money(c.amount) + '</span></div>').join('') + '</div>' : '')
        : ui.empty('No dividends', (D.dividends.notPaying.find((x) => x.holding === h.id) || { why: 'Pays nothing' }).why);
      footer = '<span class="grow"></span>' + ui.btn('All dividends', 'go', { data: { route: 'wealth/dividends' } }) + ui.btn('Close', 'drawer-close');
    } else {
      body = (h && h.stale ? ui.warnRow('Last price refresh failed. Price is from ' + fmt.date(h.stale) + '.', ui.btn('Try again', 'inv-refresh-one', { sm: true })) : '') +
        ui.field('Name', ui.input('name', v.name, { placeholder: 'e.g. Global index fund' })) +
        ui.fieldRow(ui.field('Asset class', ui.select(null, CLASSES.map((c) => [c, c]), v.cls, { name: 'cls' })), ui.field('Sector', ui.select(null, [['', 'Not tagged']].concat(SECTORS.map((s) => [s, s])), v.sector || '', { name: 'sector' }), null, 'Used for the concentration check. A fund spread across sectors counts in none.')) +
        ui.fieldRow(ui.field('Currency', ui.select(null, [['AED', 'AED'], ['USD', 'USD'], ['INR', 'INR']], v.ccy, { name: 'ccy' })), ui.field('Owner', ui.select(null, ui.ownerOptions(), v.owner, { name: 'owner' }))) +
        ui.fieldRow(ui.field('Units', ui.input('units', v.units)), ui.field('Average price', ui.input('avg', v.avg))) +
        ui.fieldRow(ui.field('Price now', ui.input('price', v.price)), ui.field('Pricing', ui.select(null, [['1', 'Daily feed'], ['', 'Manual']], v.feed ? '1' : '', { name: 'feed' }), null, 'With the daily feed, the price and the value are refreshed each night.')) +
        (h ? '<div class="dr-sec">Value</div><dl class="kv"><dt>In ' + h.ccy + '</dt><dd>' + fmt.native(q.holdNative(h), h.ccy, 0) + '</dd><dt>In AED</dt><dd>' + fmt.num(q.holdAed(h)) + ' <span class="muted small">units × price × rate</span></dd></dl>' : '');
      footer = ui.drawerFooter({ del: h ? 'inv-holding-delete' : null, delData: h ? { id: h.id } : null, save: 'inv-holding-save', saveLabel: h ? 'Save' : 'Add holding', saveData: { id: h ? h.id : '' } });
    }
    RK.drawer.open({ kicker: h ? 'Holding · ' + h.cls : 'New holding', title: h ? h.name : 'Add a holding', wide: true, tabs: h ? [['details', 'Details'], ['trades', 'Trades'], ['dividends', 'Dividends']] : null, tab, body, footer });
    /* The drawer's tab buttons carry a shared action name; point them at this editor so another screen's tabs cannot clash. */
    document.querySelectorAll('#drawer-root .dr-tabs button').forEach((b) => { b.dataset.action = 'inv-holding-tab'; b.dataset.id = id; });
  }
  A['open-holding'] = (el) => { RK.popClose(); openHolding(el && el.dataset.id, el && el.dataset.tab); };
  A['inv-holding-tab'] = (el) => openHolding(el.dataset.id, el.dataset.tab);
  if (!A['drawer-tab']) A['drawer-tab'] = (el) => { const c = RK.drawer.cfg; if (c && c.onTab) c.onTab(el.dataset.tab); };
  A['inv-trade'] = () => RK.toast('Recording trades is not part of the prototype');
  A['inv-refresh-one'] = () => { RK.drawer.close(); refreshPrices(); };
  A['inv-holding-save'] = (el) => {
    const f = RK.drawer.values();
    if (!f.name) { RK.toast('Name the holding'); return; }
    let h = el.dataset.id ? q.holding(el.dataset.id) : null;
    const isNew = !h;
    if (!h) { h = { id: 'h' + Date.now(), day: 0 }; D.holdings.push(h); }
    Object.assign(h, { name: f.name, cls: f.cls, sector: f.sector || null, ccy: f.ccy, owner: f.owner, units: numIn(f.units), avg: numIn(f.avg), price: numIn(f.price) || numIn(f.avg), feed: !!f.feed });
    RK.drawer.close(); RK.toast((isNew ? 'Added ' : 'Saved ') + h.name); RK.render();
  };
  A['inv-holding-delete'] = (el) => {
    const i = D.holdings.findIndex((h) => h.id === el.dataset.id); if (i < 0) return;
    const [gone] = D.holdings.splice(i, 1);
    RK.drawer.close(); RK.toast('Deleted ' + gone.name, () => D.holdings.splice(i, 0, gone)); RK.render();
  };

  /* ================= Dividends ================= */
  const dShare = () => { const b = D.dividends.byHolding, all = b.reduce((s, x) => s + x.received, 0); return all ? b.reduce((s, x) => s + x.received * q.share(q.holding(x.holding).owner), 0) / all : 1; };
  const CAVEATS = 'Leaves out: dividends from before a holding\'s first trade, and anything earned but not yet received (not in net worth either). Expected figures are a projection at today\'s units and rates. The Plan already counts dividends in its return, so this is cash flow, not a second return.';

  function needsCard() {
    const N = D.dividends.needs;
    if (!N.length) return '';
    return ui.card({ cls: 'action', title: 'Needs you', right: String(N.length), flush: true,
      body: '<div class="rows">' + N.map((n) => '<div class="rw"><div class="rw-main"><span class="rw-t">' + esc(q.holding(n.holding).name) + '</span> <span class="rw-s">' + esc(n.text) + '</span></div>' + ui.btn('Yes, part was a one-off', 'div-answer', { sm: true, data: { id: n.id, v: 'yes' } }) + ui.btn('No, all ordinary', 'div-answer', { sm: true, data: { id: n.id, v: 'no' } }) + '</div>').join('') + '</div>' });
  }
  function divKpis(f) {
    const d = D.dividends, rec = d.received.reduce((s, v) => s + v, 0) * f, exp = d.expected.reduce((s, v) => s + v, 0) * f;
    const presumed = d.presumed.reduce((s, i) => s + d.received[i], 0) * f;
    return ui.card({ flush: true, body: ui.kpis([
      { label: 'Received · 12 months', info: CAVEATS, hero: true, value: '<span class="code">' + S.currency + '</span>' + fmt.money(rec), sub: presumed ? ui.chip(fmt.money(presumed) + ' presumed', '', 'info', { text: 'Paid into a bank account and presumed received 30 days after the ex-date. Not checked against a statement.' }) : '' },
      { label: 'Expected · 12 months', value: fmt.money(exp), sub: pctSigned(rec ? (exp / rec - 1) * 100 : 0) + ' on the last 12' },
      { label: 'A month', value: '<span class="muted" style="font-weight:400;font-size:14px">about </span>' + fmt.money(exp / 12) },
      { label: 'Of spending', value: fmt.pct(d.spendShare, 1), sub: 'of recorded spending' },
    ]) });
  }
  function byMonthCard(f) {
    const d = D.dividends, earned = S.divMode === 'earned';
    const past = earned ? d.received.slice(1).concat([d.expected[0]]) : d.received;
    const items = [];
    for (let i = 0; i < 24; i++) {
      const ym = q.addMonth(d.firstMonth, i), isPast = i < 12;
      const v = (isPast ? past[i] : d.expected[i - 12]) * f;
      const presumed = isPast && !earned && d.presumed.includes(i);
      items.push({ value: v, kind: isPast ? (presumed ? 'pale' : 'solid') : 'outline', label: i % 3 === 0 ? (i % 12 === 0 ? fmt.month(ym) : fmt.monthShort(ym)) : '', tip: fmt.month(ym) + ' · ' + (v ? (isPast ? (earned ? 'earned ' : presumed ? 'presumed ' : 'received ') : 'expected ') + fmt.money(v) : 'nothing') });
    }
    const y26 = past.slice(1).reduce((s, v) => s + v, 0) * f, y27 = d.expected.slice(1).reduce((s, v) => s + v, 0) * f;
    return ui.card({
      cls: 'c-8', title: 'By month', right: ui.seg('div-mode', [['received', 'Received'], ['earned', 'Earned']], S.divMode),
      body: charts.slot('div-months', 208, (w, h) => charts.bars(w, h, { items, todayAfter: 11 })) +
        ui.readout([[earned ? 'Earned' : 'Received', null, 'var(--accent)'], ['Expected', null, 'var(--c3)'], ['2026 so far', fmt.money(y26)], ['2027 expected', fmt.money(y27)]]),
    });
  }
  function comingCard() {
    const rows = D.dividends.coming.filter((c) => q.share(q.holding(c.holding).owner) > 0).map((c) => {
      const h = q.holding(c.holding);
      return '<div class="rw"><span class="rw-date" title="' + fmt.date(c.date) + '">' + fmt.date(c.date).replace(/ \d{4}$/, '') + '</span><div class="rw-main"><div class="rw-t truncate">' + esc(h.name) + '</div><div class="rw-s truncate">' + esc(c.state) + ' · ' + fmt.native(c.native[0], c.native[1], 2) + '</div></div>' +
        (c.state === 'Earned' ? ui.btn('Record', 'div-record', { sm: true, data: { holding: c.holding, date: c.date } }) : '') +
        '<span class="num" style="width:44px">' + fmt.money(c.amount * q.share(h.owner)) + '</span></div>';
    }).join('');
    return ui.card({ cls: 'c-4', title: 'Coming up', flush: true, body: rows ? '<div class="rows">' + rows + '</div>' : ui.empty('Nothing declared or owed', '', '', 'check') });
  }
  function byHoldingCard() {
    const B = D.dividends.byHolding.filter((x) => q.share(q.holding(x.holding).owner) > 0);
    const sh = (x) => q.share(q.holding(x.holding).owner);
    let rows = [];
    ['US', 'India'].forEach((m) => {
      const g = B.filter((x) => x.market === m); if (!g.length) return;
      rows.push({ cls: 'group', cells: [{ html: m + ' · ' + D.dividends.withholding[m] + '% withheld', span: 4 }, { html: fmt.money(g.reduce((s, x) => s + x.received * sh(x), 0)), cls: 'num' }, { html: fmt.money(g.reduce((s, x) => s + x.expected * sh(x), 0)), cls: 'num' }, { html: '', span: 3 }] });
      rows = rows.concat(g.map((x) => { const h = q.holding(x.holding); return { action: 'open-holding', data: { id: h.id, tab: 'dividends' }, cells: ['<span class="name">' + esc(h.name) + '</span>', '<span class="ink2">' + esc(h.sector || '—') + '</span>', esc(x.rhythm), fmt.money(x.last * sh(x)), fmt.money(x.received * sh(x)), fmt.money(x.expected * sh(x)), fmt.pct(x.yieldValue, 1), fmt.pct(x.yieldCost, 1), '<span class="mono muted">' + fmt.date(x.next) + '</span>'] }; }));
    });
    const np = D.dividends.notPaying.filter((x) => q.share(q.holding(x.holding).owner) > 0);
    return ui.card({
      title: 'By holding', flush: true,
      body: (rows.length ? ui.table({ cols: [{ label: 'Holding' }, { label: 'Sector' }, { label: 'Rhythm' }, { label: 'Last', num: true }, { label: 'Received', num: true }, { label: 'Expected', num: true }, { label: 'Yield', num: true, info: 'Expected over the next 12 months, as a share of today\'s value.' }, { label: 'On cost', num: true }, { label: 'Next', num: true, width: '110px' }], rows }) : ui.empty('No holdings that pay dividends', 'Shares appear here once they are added under Investments.')) +
        (np.length ? ui.fold('Not paying or not checked (' + np.length + ')', '<div class="rows">' + np.map((x) => '<div class="rw click" data-action="open-holding" data-id="' + x.holding + '"><div class="rw-main"><span class="rw-t">' + esc(q.holding(x.holding).name) + '</span></div><span class="small muted">' + esc(x.why) + '</span></div>').join('') + '</div>') : ''),
    });
  }
  function taxView() {
    const T = D.dividends.taxYears.map((t, i) => Object.assign({ i }, t)).filter((t) => q.share(t.member) > 0);
    if (!T.length) return ui.card({ body: ui.empty('No tax years in this view', 'Indian dividends are held in ' + q.member('dev').name + '’s name.') });
    return ui.card({
      title: 'Indian dividends by tax year', info: 'Checked against the AIS (income) and Form 26AS (tax credit). In rupees.', flush: true,
      body: ui.table({ cols: [{ label: 'Tax year' }, { label: 'Member' }, { label: 'Dividends', num: true }, { label: 'Tax withheld', num: true }, { label: 'Against AIS and 26AS' }, { label: 'Return' }, { label: 'Refund' }],
        rows: T.map((t) => ({ action: 'div-tax-open', data: { i: t.i }, cells: ['<span class="name">' + esc(t.year) + '</span>' + (t.provisional ? ' ' + ui.chip('Provisional') : ''), '<span class="row">' + ui.avatar(t.member) + esc(q.member(t.member).name) + '</span>', fmt.native(t.dividends, 'INR', 0), fmt.native(t.withheld, 'INR', 0), ui.chip(t.check, t.checkTone), esc(t.ret), t.refund ? esc(t.refund) : ''] })) }),
    });
  }

  A['div-view'] = (el) => { S.divView = el.dataset.value; RK.render(); };
  A['div-mode'] = (el) => { S.divMode = el.dataset.value; RK.render(); };
  A['div-feed'] = (el) => { const f = D.dividends.feed; RK.pop(el, '<div style="color:var(--ink);font-weight:500;margin-bottom:6px">Dividend feed</div>US · checked ' + fmt.time(f.us) + '<br>India · checked ' + fmt.time(f.india) + '<br><span class="muted">History from ' + fmt.month(D.dividends.firstMonth) + ' · checks each night</span>'); };
  A['div-answer'] = (el) => {
    const N = D.dividends.needs, i = N.findIndex((n) => n.id === el.dataset.id); if (i < 0) return;
    const [gone] = N.splice(i, 1);
    RK.toast(el.dataset.v === 'yes' ? 'Recorded: part was a one-off' : 'Recorded: all ordinary', () => N.splice(i, 0, gone)); RK.render();
  };
  A['div-record'] = (el) => {
    const C = D.dividends.coming, i = C.findIndex((c) => c.holding === el.dataset.holding && c.date === el.dataset.date); if (i < 0) return;
    const [gone] = C.splice(i, 1);
    RK.toast('Recorded ' + fmt.native(gone.native[0], gone.native[1], 2) + ' into Broker funds', () => C.splice(i, 0, gone)); RK.render();
  };
  A['div-tax-open'] = (el) => {
    const t = D.dividends.taxYears[+el.dataset.i];
    RK.drawer.open({
      kicker: 'Tax year · ' + q.member(t.member).name, title: t.year,
      body: '<dl class="kv"><dt>Dividends</dt><dd>' + fmt.native(t.dividends, 'INR', 0) + '</dd><dt>Tax withheld</dt><dd>' + fmt.native(t.withheld, 'INR', 0) + '</dd><dt>Statements</dt><dd>' + ui.chip(t.check, t.checkTone) + '</dd><dt>Refund</dt><dd>' + (t.refund ? esc(t.refund) : '<span class="muted">—</span>') + '</dd></dl>' +
        '<div class="dr-sec">Return</div>' +
        ui.fieldRow(ui.field('Claim basis', ui.select(null, [['', 'Not set'], ['d', 'Domestic rate'], ['t', 'Treaty rate']], t.provisional ? '' : 't', { name: 'basis' })), ui.field('Return', ui.select(null, [['', 'Not filed'], ['o', 'Original return'], ['r', 'Revised return']], t.provisional ? '' : 'o', { name: 'ret' }))) +
        ui.field('Filed on', ui.input('filed', t.provisional ? '' : '2026-07-28', { type: 'date' })) +
        ui.field('Note', '<textarea class="inp" name="note" rows="2" placeholder="Optional"></textarea>'),
      footer: ui.drawerFooter({ save: 'div-tax-save', saveData: { i: el.dataset.i } }),
    });
  };
  A['div-tax-save'] = (el) => {
    const t = D.dividends.taxYears[+el.dataset.i], f = RK.drawer.values();
    t.ret = f.ret ? (f.ret === 'r' ? 'Revised' : 'Filed') + (f.filed ? ' ' + fmt.date(f.filed) : '') : 'Not filed';
    RK.drawer.close(); RK.toast('Saved ' + t.year); RK.render();
  };

  RK.screens['wealth/dividends'] = {
    tools: () => ui.seg('div-view', [['income', 'Income'], ['tax', 'Tax years']], S.divView) + ui.chip('Feed: checked ' + fmt.date(D.dividends.feed.us), '', 'div-feed'),
    render: () => {
      if (S.divView === 'tax') return taxView();
      const f = dShare();
      if (!f) return ui.card({ body: ui.empty('No dividends in this view', 'None of ' + q.ownerName(S.scope) + '’s holdings pay dividends.') });
      return needsCard() + divKpis(f) + '<div class="grid stretch">' + byMonthCard(f) + comingCard() + '</div>' + byHoldingCard();
    },
  };
})();
