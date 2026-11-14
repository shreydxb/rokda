/* Planning: Plan (was Life plan), Goals & debts, Notes.
   Review IDs: N7, N9, S-plan-1, S-life-1..12, S-goals-1..8, S-debt-1..7, S-notes-1..5. */
(function () {
  const RK = window.RK;
  const { fmt, q, ui, charts } = RK;
  const D = RK.data, S = RK.state, A = RK.actions, IN = RK.inputs;
  const esc = fmt.esc;
  const Y0 = +D.today.slice(0, 4);
  const unit = (t) => ' <span class="unit">' + t + '</span>';

  /* A chart inside a closed fold has no width yet: draw it when the fold opens. */
  document.addEventListener('toggle', (e) => { if (e.target.open) charts.flush(); }, true);

  /* ================= Plan ================= */
  const stop = () => S.planStop || D.plan.stopYear;
  const scen = () => S.planScenario || 'Baseline';
  const spendKey = () => S.planSpend || 'Planned';
  const ages = (y) => D.members.map((m) => m.name + ' ' + (y - m.born)).join(' · ');
  const verdict = (label, r) => {
    const t = r.runsOut ? 'runs out ' + r.runsOut : 'lasts to ' + r.end;
    return ui.chip(label ? label + ': ' + t : t.charAt(0).toUpperCase() + t.slice(1), r.runsOut ? 'neg' : 'pos');
  };
  const rupeeAed = () => D.accounts.filter((a) => !a.closed && a.confirmed && a.ccy === 'INR').reduce((s, a) => s + q.accAed(a), 0) + D.holdings.filter((h) => h.ccy === 'INR').reduce((s, h) => s + q.holdAed(h), 0);

  /* The same sum as q.project, with an optional stress: fall (20% then 10% from the stop year) or rupee (3% a year). */
  function sim(stopY, scenario, key, o) {
    o = o || {};
    const P = D.plan, sc = P.scenarios[scenario];
    const end = Math.max.apply(null, D.members.map((m) => m.born + P.planToAge));
    const rW = (1 + sc.ret / 100) / (1 + P.inflation / 100) - 1, rA = (1 + sc.after / 100) / (1 + P.inflation / 100) - 1;
    const spend = P.spendingAfter[key] + P.costsAfter - P.otherIncome;
    const later = D.goals.filter((g) => g.kind === 'later');
    let rup = o.rupee ? rupeeAed() : 0, pot = q.householdNet() - rup, runsOut = null;
    const years = [], pots = [];
    for (let y = Y0; y <= end; y++) {
      const tot = pot + rup;
      years.push(y); pots.push(Math.max(0, tot));
      if (tot <= 0 && y >= stopY && runsOut == null) runsOut = y;
      const r = y < stopY ? rW : rA;
      const f = o.fall && y === stopY ? 0.8 : o.fall && y === stopY + 1 ? 0.9 : 1;
      pot = pot * (1 + r) * f + (y < stopY ? P.basis.saving * 12 : -spend);
      rup = rup * (1 + r) * f * (o.rupee ? 0.97 : 1);
      later.forEach((g) => { if (g.by && +g.by.slice(0, 4) === y) pot -= g.target; });
    }
    return { years, pot: pots, runsOut, end };
  }

  /* What would make the money last: answers by search, restoring the plan afterwards. */
  function levers() {
    const P = D.plan, k = spendKey(), sc = scen(), st = stop();
    const lasts = () => !q.project(st, sc, k).runsOut;
    if (lasts()) return null;
    const out = { earliest: q.earliestStop(sc, k), more: null, most: null };
    const save0 = P.basis.saving;
    let lo = 0, hi = 80000;
    P.basis.saving = save0 + hi;
    if (lasts()) { for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; P.basis.saving = save0 + mid; if (lasts()) hi = mid; else lo = mid; } out.more = Math.ceil(hi / 50) * 50; }
    P.basis.saving = save0;
    const sp0 = P.spendingAfter[k];
    let a = 0, b = sp0;
    P.spendingAfter[k] = 0;
    if (lasts()) { for (let i = 0; i < 20; i++) { const mid = (a + b) / 2; P.spendingAfter[k] = mid; if (lasts()) a = mid; else b = mid; } out.most = Math.floor(a / 500) * 500; }
    P.spendingAfter[k] = sp0;
    return out;
  }

  function strip() {
    const P = D.plan, sc = P.scenarios[scen()];
    return '<section class="card plan-strip"><div class="row"><span class="muted">Basis</span><b style="font-weight:500">' + esc(P.basis.kind.toLowerCase()) + '</b><span class="ink2">· spending ' + fmt.money(P.basis.spending) + ' · saving ' + fmt.money(P.basis.saving) + ' a month</span>' +
      ui.btn('Change', 'plan-basis', { kind: 'text', sm: true }) + ui.info(P.basis.why) + '</div>' +
      '<div class="row">' + ui.select('plan-scenario', Object.keys(P.scenarios).map((n) => [n, n]), scen(), { sm: true }) +
      ui.select('plan-spend', Object.keys(P.spendingAfter).map((n) => [n, n + ' · ' + fmt.money(P.spendingAfter[n]) + ' a year']), spendKey(), { sm: true }) +
      '<span class="muted small nowrap">' + sc.ret.toFixed(1) + '% return · ' + P.inflation.toFixed(1) + '% inflation</span></div></section>';
  }

  /* The answer column: the stop year, the two verdicts, the figures at that year, and the stepper. */
  function stopCol(main, base, cons, goalsSum) {
    const st = stop(), changed = st !== D.plan.stopYear;
    const shortBy = Math.max(0, main.needed - main.atStop);
    return '<div class="plan-stop-l"><div><div class="kpi-l">Stopping in</div><div class="hero-fig">' + st + '</div>' +
      '<div class="small muted" style="margin-top:2px">' + esc(ages(st)) + ' · ' + (changed ? 'trying it' : 'your plan') + '</div></div>' +
      '<div class="chips-v">' + verdict('Baseline', base) + verdict('Conservative', cons) + '</div>' +
      '<dl class="plan-figs"><dt>Pot in ' + st + '</dt><dd>' + fmt.money(main.atStop) + '</dd><dt>Needed then' + ui.info('What the pot must hold in ' + st + ' to last to ' + main.end + ', with other income counted.') + '</dt><dd>' + fmt.money(main.needed) + '</dd><dt>Goals on the way</dt><dd>' + fmt.money(goalsSum) + '</dd>' +
      (main.runsOut ? '<dt>Short by</dt><dd class="neg">' + fmt.money(shortBy) + '</dd>' : '<dt>Left in ' + main.end + '</dt><dd class="pos">' + fmt.money(main.left) + '</dd>') + '</dl>' +
      '<div class="stop-row"><div class="row between"><span class="small ink2">Stop working</span>' + ui.stepper(String(st), 'plan-stop-prev', 'plan-stop-next', { prevOff: st <= Y0, nextOff: st >= Y0 + 49 }) + '</div>' +
      (changed ? '<div class="row" style="margin-top:10px">' + ui.chip('Not saved', 'warn') + '<span class="grow"></span>' + ui.btn('Reset', 'plan-stop-reset', { kind: 'text', sm: true }) + ui.btn('Make this the plan', 'plan-make', { sm: true }) + '</div>' : '') +
      '</div></div>';
  }

  function potCard(main, base, cons, opt) {
    const st = stop(), later = D.goals.filter((g) => g.kind === 'later' && g.by);
    const goalsSum = later.reduce((s, g) => s + g.target, 0);
    /* Keep the bars readable: the Optimistic edge of the band is drawn no higher than 1.8 times the tallest bar. */
    const cap = Math.max.apply(null, main.pot) * 1.8, high = opt.pot.map((v) => Math.min(v, cap));
    const every =main.years.filter((y) => (y - Y0) % 5 === 0 || y === st);
    const yearTable = ui.table({ compact: true, cols: [{ label: 'Year', width: '90px' }, { label: 'Ages' }, { label: 'Pot at start', num: true, width: '150px' }, { label: '', width: '130px' }],
      rows: every.map((y) => ({ cells: ['<span class="mono">' + y + '</span>', '<span class="ink2">' + esc(ages(y)) + '</span>', fmt.money(main.pot[y - Y0]), y === st ? ui.chip('Work stops', 'accent') : main.runsOut && y >= main.runsOut ? ui.chip('Nothing left', 'neg') : '<span class="muted small">' + (y < st ? 'Working' : 'After work') + '</span>'] })) });
    const tl = D.goals.filter((g) => g.kind !== 'done').map((g) => '<div class="rw click" data-action="open-goal" data-id="' + g.id + '"><div class="rw-main"><span class="rw-t">' + esc(g.name) + '</span></div><span class="num small ink2" style="width:90px">' + fmt.money(g.target) + '</span><span style="width:120px;text-align:right">' +
      (g.kind === 'kept' ? ui.chip('Kept') : g.kind === 'later' ? ui.chip('Paid ' + g.by.slice(0, 4), 'pos') : g.kind === 'undated' ? ui.chip('No date') : ui.chip('From cash ' + g.by.slice(0, 4))) + '</span></div>').join('');
    return '<section class="card"><div class="plan-stop-grid">' + stopCol(main, base, cons, goalsSum) +
      '<div class="plan-stop-r"><div class="card-h"><div class="card-t">The pot, year by year' + ui.info('Today\'s money, at the start of each year, on the scenario chosen above. The grey band runs from Conservative to Optimistic. A diamond marks a goal the pot pays in its year.') + '</div>' +
      '<div class="card-r"><span><i class="sw" style="background:var(--accent)"></i>Working</span><span><i class="sw" style="background:var(--accent);opacity:.5"></i>After work</span><span><i class="sw" style="background:var(--context);opacity:.5"></i>Range</span></div></div>' +
      '<div class="card-b">' + charts.slot('plan-pot', 286, (w, h) => charts.plan(w, h, { years: main.years, pot: main.pot, low: cons.pot, high, stopYear: st, runsOut: main.runsOut, goals: later.map((g) => ({ year: +g.by.slice(0, 4), name: g.name })) })) + '</div></div></div>' +
      ui.fold('Year by year', yearTable) + ui.fold('Goals on the timeline', '<div class="rows">' + tl + '</div>') + '</section>';
  }

  function leversCard(main) {
    const L = levers(), st = stop();
    if (!L) return ui.card({ body: '<div class="row">' + ui.chip('Lasts to ' + main.end, 'pos') + '<span class="ink2">Nothing more is needed on ' + esc(scen()) + '.</span><span class="grow"></span><span class="muted small">Left at the end</span><span class="fig-s">' + fmt.money(main.left) + '</span></div>' });
    return '<section class="card">' + ui.kpis([
      { label: 'Stop in', value: L.earliest ? String(L.earliest) : '—', sub: L.earliest ? '<span>' + esc(ages(L.earliest)) + '</span><span class="grow"></span>' + ui.btn('Try', 'plan-try', { sm: true, data: { year: L.earliest } }) : 'No stop year makes it last' },
      { label: 'or save', value: L.more != null ? fmt.money(L.more) + unit('more a month') : '—', sub: L.more != null ? 'from now until ' + st : 'Saving alone is not enough' },
      { label: 'or spend at most', value: L.most != null ? fmt.money(L.most) + unit('a year') : '—', sub: L.most != null ? 'after ' + st + ', besides the costs that start then' : 'No level of spending lasts' },
    ]) + '</section>';
  }

  function stressCard(key, title, info, steady, hit, label, legend) {
    const st = stop();
    const lastY = Math.min(steady.end, Math.max(steady.runsOut || steady.end, hit.runsOut || hit.end) + 2);
    const a = st - Y0, b = lastY - Y0 + 1;
    const ys = steady.years.slice(a, b), v = hit.pot.slice(a, b), cmp = steady.pot.slice(a, b);
    const labels = {}; labels[0] = String(st); labels[ys.length - 1] = String(lastY);
    return '<section class="card"><div class="card-h"><div class="card-t">' + title + ui.info(info) + '</div><div class="card-r">' + verdict('', hit) + '</div></div>' +
      '<div class="card-b"><div class="small muted">' + label + ' · steady plan ' + (steady.runsOut ? 'runs out ' + steady.runsOut : 'lasts to ' + steady.end) + '</div></div>' +
      ui.fold('Show the path', '<div style="padding:0 18px 14px">' + charts.slot('plan-' + key, 150, (w, h) => charts.line(w, h, { values: v, compare: cmp, labels, area: false, tips: ys.map((y, i) => y + ' · ' + fmt.compact(v[i]) + ' · steady ' + fmt.compact(cmp[i])) })) +
        ui.readout([[legend, null, 'var(--accent)'], ['Steady', null, 'var(--context)']]) + '</div>') + '</section>';
  }

  A['plan-basis'] = (el) => RK.pop(el, '<div class="m-l">Plan on</div>' + [['Your budget', 'What you wrote down'], ['Recorded months', 'Needs three ended months']].map((o) => '<button class="m-i" data-action="plan-basis-set" data-value="' + o[0] + '">' + o[0] + '<span class="muted small">' + (D.plan.basis.kind === o[0] ? 'Current' : o[1]) + '</span></button>').join(''), true);
  A['plan-basis-set'] = (el) => {
    if (el.dataset.value === 'Recorded months') { RK.toast('Recorded months need three ended months. Two so far.'); return; }
    D.plan.basis.kind = el.dataset.value; RK.toast('Basis: ' + el.dataset.value.toLowerCase()); RK.render();
  };
  IN['plan-scenario'] = (el) => { S.planScenario = el.value; RK.render(); };
  IN['plan-spend'] = (el) => { S.planSpend = el.value; RK.render(); };
  A['plan-stop-prev'] = () => { S.planStop = Math.max(Y0, stop() - 1); RK.render(); };
  A['plan-stop-next'] = () => { S.planStop = Math.min(Y0 + 49, stop() + 1); RK.render(); };
  A['plan-stop-reset'] = () => { S.planStop = D.plan.stopYear; RK.render(); };
  A['plan-try'] = (el) => { S.planStop = +el.dataset.year; RK.render(); };
  A['plan-make'] = () => { const prev = D.plan.stopYear; D.plan.stopYear = stop(); RK.toast('Stop year saved: ' + D.plan.stopYear, () => { D.plan.stopYear = prev; }); RK.render(); };

  A['plan-edit'] = () => {
    const P = D.plan, b = P.scenarios.Baseline;
    const sec = (title, body, open) => ui.fold(title, '<div class="fold-b">' + body + '</div>', open);
    const line = (name, amount) => '<div class="row between small"><span>' + esc(name) + '</span><span class="num">' + fmt.money(amount) + ' a year</span></div>';
    RK.drawer.open({
      kicker: 'Plan', title: 'Who it is for, and what it assumes', wide: true,
      body: '<div class="plan-form">' +
        sec('Who it is for', D.members.map((m) => ui.fieldRow(ui.field(m.name + ' · birth year', ui.input('born-' + m.id, m.born)), ui.field('Plan to age', ui.input('age-' + m.id, P.planToAge)))).join(''), true) +
        sec('Stop year', ui.field('Stop working in', ui.input('stopYear', P.stopYear), ages(P.stopYear))) +
        sec('Spending after work stops', ui.fieldRow(ui.field('A year, today\'s money', ui.input('planned', P.spendingAfter.Planned)), ui.field('Essentials only', ui.input('essentials', P.spendingAfter.Essentials))) + '<div class="small muted">Budgeted: ' + fmt.money(P.spendingAfter.Budgeted) + ' a year, from your budget</div>') +
        sec('Costs that start then', line('Health cover and visa fees', P.costsAfter) + ui.field('Total a year', ui.input('costs', P.costsAfter), null, 'Costs an employer pays until work stops, on top of the spending above.')) +
        sec('Other income', line('Rent from a property', P.otherIncome) + ui.field('Total a year', ui.input('income', P.otherIncome))) +
        sec('Growth', ui.fieldRow(ui.field('Return · %', ui.input('ret', b.ret)), ui.field('Inflation · %', ui.input('inflation', P.inflation))) + ui.fieldRow(ui.field('Return after work · %', ui.input('after', b.after)), ui.field('Return on cash · %', ui.input('cash', P.cashReturn)))) +
        '</div>',
      footer: ui.drawerFooter({ save: 'plan-save', saveLabel: 'Save plan' }),
    });
  };
  A['plan-save'] = () => {
    const f = RK.drawer.values(), P = D.plan, n = (v, d) => (v !== '' && v != null && isFinite(Number(v)) ? Number(v) : d);
    P.stopYear = Math.max(Y0, Math.round(n(f.stopYear, P.stopYear))); S.planStop = P.stopYear;
    P.spendingAfter.Planned = n(f.planned, P.spendingAfter.Planned); P.spendingAfter.Essentials = n(f.essentials, P.spendingAfter.Essentials);
    P.costsAfter = n(f.costs, P.costsAfter); P.otherIncome = n(f.income, P.otherIncome);
    P.scenarios.Baseline.ret = n(f.ret, P.scenarios.Baseline.ret); P.scenarios.Baseline.after = n(f.after, P.scenarios.Baseline.after);
    P.inflation = n(f.inflation, P.inflation); P.cashReturn = n(f.cash, P.cashReturn);
    D.members.forEach((m) => { m.born = Math.round(n(f['born-' + m.id], m.born)); });
    RK.drawer.close(); RK.toast('Plan saved'); RK.render();
  };

  RK.screens['planning/plan'] = {
    tools: () => ui.btn('Edit plan', 'plan-edit'),
    render: () => {
      const st = stop(), k = spendKey();
      const main = q.project(st, scen(), k), base = q.project(st, 'Baseline', k), cons = q.project(st, 'Conservative', k), opt = q.project(st, 'Optimistic', k);
      const steady = sim(st, 'Baseline', k), fall = sim(st, 'Baseline', k, { fall: true }), rupee = sim(st, 'Baseline', k, { rupee: true });
      return strip() +
        '<h2 class="band-h">When can we stop?</h2>' + potCard(main, base, cons, opt) +
        '<h2 class="band-h">What would it take?</h2>' + leversCard(main) +
        '<h2 class="band-h">What could go wrong?</h2><div class="grid"><div class="c-6">' +
        stressCard('fall', 'If markets fall', 'The pot loses 20% and then 10% in the two years from the year work stops, then earns the Baseline return. Always on Baseline, so caution is not counted twice.', steady, fall, 'A two-year fall from ' + st, 'With the fall') + '</div><div class="c-6">' +
        stressCard('rupee', 'If the rupee weakens', 'Everything held in rupees (' + fmt.money(rupeeAed()) + ' today) loses 3% a year against the dirham, with nothing making up for it.', steady, rupee, 'Rupee holdings lose 3% a year', 'With a weaker rupee') + '</div></div>';
    },
  };

  /* ================= Goals & debts ================= */
  const GROUPS = [
    ['soon', 'Next 3 years · from cash', 'Paid from cash: the accounts linked to a goal or, with none linked, what is logged to it. No growth is assumed.'],
    ['kept', 'Kept, not spent · in cash', 'Money kept rather than spent, like an emergency fund. Held in cash and never paid out of the plan.'],
    ['later', 'Later · paid by the plan', 'Paid by the Plan from everything you own, in the goal\'s year.'],
    ['undated', 'No date', 'No plan pays for a goal without a date. Set one to plan for it.'],
  ];
  const GOAL_COLS = [{ label: 'Goal' }, { label: 'Target', num: true, width: '130px' }, { label: 'Saved', num: true, width: '100px' }, { label: 'Progress', width: '200px' }, { label: 'Needs a month', num: true, width: '120px' }, { label: 'Pace', num: true, width: '90px', info: 'What has gone in each month, over about three months.' }, { label: 'Status', width: '120px' }];
  const goalRow = (g) => {
    const p = g.target ? g.saved / g.target : 0;
    const low = g.pace != null && (g.pace === 0 || g.pace < (g.planMonthly || 0));
    return { action: 'open-goal', data: { id: g.id }, cells: [
      '<div class="row">' + ui.avatar(g.owner) + '<span class="name">' + esc(g.name) + '</span></div>',
      { html: '<div>' + fmt.money(g.target) + '</div><div class="sub">' + (g.by ? 'by ' + fmt.month(g.by) : 'no date') + '</div>', cls: 'two' },
      fmt.money(g.saved),
      '<div class="row"><div class="grow">' + ui.bar(p, { tone: g.tone === 'pos' || g.kind === 'done' ? 'pos' : '' }) + '</div><span class="small muted num" style="width:36px">' + Math.round(p * 100) + '%</span></div>',
      g.needs ? fmt.money(g.needs) : '',
      g.pace != null ? '<span class="' + (low ? 'warn' : '') + '">' + fmt.money(g.pace) + '</span>' : '',
      ui.chip(g.status, g.tone || ''),
    ] };
  };
  function goalsHalf() {
    let html = '';
    GROUPS.forEach((G) => {
      const list = D.goals.filter((g) => g.kind === G[0]); if (!list.length) return;
      const saved = list.reduce((s, g) => s + g.saved, 0), target = list.reduce((s, g) => s + g.target, 0), needs = list.reduce((s, g) => s + (g.needs || 0), 0);
      html += ui.card({ title: G[1], info: G[2], flush: true, right: '<span>' + fmt.money(saved) + ' of ' + fmt.money(target) + (needs ? ' · needs ' + fmt.money(needs) + ' a month' : '') + '</span>', body: ui.table({ cols: GOAL_COLS, rows: list.map(goalRow) }) });
    });
    const done = D.goals.filter((g) => g.kind === 'done');
    if (done.length) html += '<section class="card fold-card">' + ui.fold('Done (' + done.length + ')', ui.table({ cols: GOAL_COLS, rows: done.map(goalRow) })) + '</section>';
    if (!D.goals.length) html = ui.card({ body: ui.empty('No goals yet', 'Add one to see what it needs each month.', ui.btn('Goal', 'open-goal', { kind: 'primary', icon: 'plus' })) });
    return html;
  }
  function debtsHalf() {
    const list = D.debts.filter((b) => b.owed > 0); if (!list.length) return '';
    const extra = D.debtPlan.extra || 0, pay = q.payoff(extra), min = q.payoff(0), owed = list.reduce((s, b) => s + b.owed, 0);
    const rows = list.slice().sort((a, b) => (D.debtPlan.order === 'Snowball' ? a.owed - b.owed : b.rate - a.rate)).map((b) => {
      const paid = b.original ? 1 - b.owed / b.original : 0;
      return { action: 'open-debt', data: { id: b.id }, cells: [
        '<div class="row">' + ui.avatar(b.owner) + '<span class="name">' + esc(b.name) + '</span>' + (b.account ? '' : ui.chip('Not in net worth', 'warn') + ui.btn('Link account', 'open-debt', { kind: 'text', sm: true, data: { id: b.id } })) + '</div>',
        fmt.money(-b.owed), fmt.pct(b.rate, 1), fmt.money(b.minimum), pay.clears[b.id] ? fmt.month(pay.clears[b.id]) : 'Never',
        '<div class="row"><div class="grow">' + ui.bar(paid) + '</div><span class="small muted num" style="width:36px">' + Math.round(paid * 100) + '%</span></div>',
      ] };
    });
    const saves = Math.max(0, min.interest - pay.interest);
    return '<h2 class="band-h">Debts</h2><section class="card"><div class="card-h"><div class="card-t">' + list.length + (list.length === 1 ? ' debt' : ' debts') + '</div><div class="card-r">' +
      (list.length > 1 ? ui.seg('debt-order', [['Avalanche', 'Avalanche'], ['Snowball', 'Snowball']], D.debtPlan.order) + ui.info('Avalanche pays the highest rate first. Snowball pays the smallest balance first.') : '') + '</div></div>' +
      ui.kpis([{ label: 'Owed', value: fmt.money(owed), hero: true }, { label: 'Clears', value: fmt.month(pay.last), sub: extra ? 'with ' + fmt.money(extra) + ' extra a month' : 'at the minimum payments' }, { label: 'Interest still to pay', value: fmt.money(pay.interest) }]) +
      '<div style="border-top:1px solid var(--rule)">' + ui.table({ cols: [{ label: 'Debt' }, { label: 'Owed', num: true, width: '120px' }, { label: 'Rate', num: true, width: '80px' }, { label: 'Minimum', num: true, width: '110px' }, { label: 'Clears', width: '110px' }, { label: 'Paid down', width: '200px' }], rows }) + '</div>' +
      '<div class="rw extra-row"><span class="rw-t">Extra a month</span>' + ui.info('A what-if on top of every minimum, to the first debt in the order above. A rule of thumb: fill the cash reserve before paying extra on a low-rate loan.') +
      '<input class="inp sm num" style="width:110px" data-input="debt-extra" inputmode="numeric" placeholder="0" value="' + (extra || '') + '">' +
      (extra ? '<span class="muted">→</span><span>Clears <b>' + fmt.month(pay.last) + '</b> · saves <b class="pos">' + fmt.money(saves) + '</b> in interest</span><span class="muted small">against ' + fmt.month(min.last) + ' at the minimums</span>' : '<span class="muted small">Try an amount to see how much sooner the debts clear.</span>') + '</div></section>';
  }
  A['debt-order'] = (el) => { D.debtPlan.order = el.dataset.value; RK.render(); };
  IN['debt-extra'] = (el) => { D.debtPlan.extra = Math.max(0, Math.round(Number(el.value.replace(/,/g, '')) || 0)); RK.render(); };

  RK.screens['planning/goals'] = {
    tools: () => ui.btn('Debt', 'open-debt', { icon: 'plus' }) + ui.btn('Goal', 'open-goal', { kind: 'primary', icon: 'plus' }),
    render: () => '<h2 class="band-h" style="margin-top:0">Goals</h2>' + goalsHalf() + debtsHalf(),
  };

  /* ---------- goal drawer ---------- */
  const KINDS = [['soon', 'Spent on its date · next 3 years'], ['later', 'Spent on its date · later'], ['kept', 'Kept, not spent'], ['undated', 'No date yet']];
  const LINKS = { g1: [['sav', 100], ['fd', 20]] };
  A['open-goal'] = (el) => {
    const g = el && el.dataset.id ? D.goals.find((x) => x.id === el.dataset.id) : null;
    const v = g || { name: '', target: '', by: '', kind: 'soon', planMonthly: '', owner: 'shared', saved: 0 };
    const links = (g && LINKS[g.id]) || [];
    const contribs = g && g.saved && !links.length ? [[D.today.slice(0, 8) + '01', Math.round(g.saved / 4)], ['2026-10-01', Math.round(g.saved / 4)], ['2026-09-01', Math.round(g.saved / 2)]] : [];
    const tabs = [['details', 'Details'], ['contrib', 'Contributions'], ['links', 'Linked accounts']];
    RK.drawer.open({
      kicker: g ? 'Edit goal' : 'New goal', title: g ? g.name : 'Add a goal',
      body: (g ? '<div class="dr-tabs goal-tabs">' + tabs.map((t, i) => '<button type="button" class="' + (i === 0 ? 'on' : '') + '" data-action="goal-tab" data-tab="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>' : '') +
        '<div class="goal-pane" data-pane="details">' +
        '<div class="field"><label>Target</label><div class="amount"><span>AED</span><input name="target" inputmode="decimal" value="' + esc(v.target) + '" placeholder="0"></div></div>' +
        ui.field('Name', ui.input('name', v.name, { placeholder: 'What it is for' })) +
        ui.fieldRow(ui.field('Target date', ui.input('by', v.by || '', { type: 'month' })), ui.field('Kind', ui.select(null, KINDS, v.kind === 'done' ? 'soon' : v.kind, { name: 'kind' }), null, 'Spent goals are paid in their year: from cash within 3 years, otherwise by the Plan. Kept goals stay in cash.')) +
        ui.fieldRow(ui.field('Monthly plan', ui.input('planMonthly', v.planMonthly || '', { placeholder: 'No plan' })), ui.field('Owner', ui.select(null, ui.ownerOptions(), v.owner, { name: 'owner' }))) + '</div>' +
        (g ? '<div class="goal-pane" data-pane="contrib" hidden>' +
          (links.length ? ui.warnRow('Linked accounts count as saved, so these are a record only.') : '') +
          '<div class="row" style="align-items:flex-end">' + ui.field('Amount', ui.input('c-amount', '', { placeholder: '0' })) + ui.field('Date', ui.input('c-date', D.today, { type: 'date' })) + ui.btn('Log', 'goal-log', { data: { id: g.id } }) + '</div>' +
          (contribs.length ? '<div class="rows goal-list">' + contribs.map((c) => '<div class="rw"><span class="rw-date">' + fmt.date(c[0]) + '</span><span class="grow"></span><span class="num">' + fmt.money(c[1]) + '</span></div>').join('') + '</div>' : '<div class="small muted">Nothing logged yet.</div>') + '</div>' +
          '<div class="goal-pane" data-pane="links" hidden>' +
          '<div class="row" style="align-items:flex-end">' + ui.field('Account or holding', ui.select(null, ui.accOptions('Choose…'), '', { name: 'l-account' })) + '<div style="width:90px;flex:none">' + ui.field('Share %', ui.input('l-share', '100')) + '</div>' + ui.btn('Link', 'goal-link', { data: { id: g.id } }) + '</div>' +
          (links.length ? '<div class="rows goal-list">' + links.map((l) => '<div class="rw"><div class="rw-main"><span class="rw-t">' + esc(q.acc(l[0]).name) + '</span></div><span class="small muted">' + l[1] + '%</span><span class="num" style="width:90px">' + fmt.money(q.accAed(q.acc(l[0])) * l[1] / 100) + '</span></div>').join('') + '</div>' : '<div class="small muted">Nothing linked yet. Progress comes from what is logged.</div>') + '</div>' : ''),
      footer: (g ? '<span id="dr-del">' + ui.btn('Delete', 'ask-delete', { kind: 'danger', data: { next: 'goal-delete', id: g.id } }) + '</span>' + ui.btn(g.kind === 'done' ? 'Reopen' : 'Mark done', 'goal-done', { data: { id: g.id } }) : '') + '<span class="grow"></span>' + ui.btn('Cancel', 'drawer-close') + ui.btn(g ? 'Save' : 'Add goal', 'goal-save', { kind: 'primary', data: { id: g ? g.id : '' } }),
    });
  };
  A['goal-tab'] = (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    document.querySelectorAll('#dr-form .goal-pane').forEach((p) => { p.hidden = p.dataset.pane !== el.dataset.tab; });
  };
  A['goal-save'] = (el) => {
    const f = RK.drawer.values(), target = Math.abs(Number(f.target));
    if (!target) { RK.toast('Set a target above zero'); return; }
    if (!f.name) { RK.toast('Name it'); return; }
    let g = el.dataset.id ? D.goals.find((x) => x.id === el.dataset.id) : null;
    const isNew = !g;
    if (!g) { g = { id: 'g' + Date.now(), saved: 0, status: 'Saving' }; D.goals.push(g); }
    Object.assign(g, { name: f.name, target, by: f.by || null, owner: f.owner, planMonthly: Number(f.planMonthly) || 0 });
    if (g.kind !== 'done') g.kind = f.by ? (f.kind === 'undated' ? 'soon' : f.kind) : (f.kind === 'kept' ? 'kept' : 'undated');
    if (isNew) {
      const months = g.by ? Math.max(1, (+g.by.slice(0, 4) - Y0) * 12 + (+g.by.slice(5, 7) - +D.today.slice(5, 7))) : 0;
      if (months && (g.kind === 'soon' || g.kind === 'kept')) { g.needs = Math.round(target / months); g.pace = 0; }
      if (g.kind === 'later') { g.status = 'Paid ' + g.by.slice(0, 4); g.tone = 'pos'; }
      if (g.kind === 'undated') g.status = 'No date';
    }
    RK.drawer.close(); RK.toast(isNew ? 'Added ' + g.name : 'Saved ' + g.name); RK.render();
  };
  A['goal-delete'] = (el) => { const i = D.goals.findIndex((x) => x.id === el.dataset.id); if (i < 0) return; const gone = D.goals.splice(i, 1)[0]; RK.drawer.close(); RK.toast('Deleted ' + gone.name, () => D.goals.splice(i, 0, gone)); RK.render(); };
  A['goal-done'] = (el) => {
    const g = D.goals.find((x) => x.id === el.dataset.id); if (!g) return;
    const prev = { kind: g.kind, status: g.status, tone: g.tone };
    if (g.kind === 'done') Object.assign(g, { kind: g.by ? 'soon' : 'undated', status: 'Saving', tone: '' }); else Object.assign(g, { kind: 'done', status: 'Done', tone: '' });
    RK.drawer.close(); RK.toast(g.kind === 'done' ? g.name + ' marked done' : g.name + ' reopened', () => Object.assign(g, prev)); RK.render();
  };
  A['goal-log'] = (el) => {
    const g = D.goals.find((x) => x.id === el.dataset.id), amt = Math.abs(Number(RK.drawer.values()['c-amount']));
    if (!amt) { RK.toast('Enter an amount above zero'); return; }
    g.saved += amt; RK.drawer.close(); RK.toast('Logged ' + fmt.money(amt) + ' to ' + g.name, () => { g.saved -= amt; }); RK.render();
  };
  A['goal-link'] = () => { if (!RK.drawer.values()['l-account']) { RK.toast('Choose an account or holding'); return; } RK.toast('Linking is not part of the prototype'); };

  /* ---------- debt drawer ---------- */
  A['open-debt'] = (el) => {
    const b = el && el.dataset.id ? D.debts.find((x) => x.id === el.dataset.id) : null;
    const v = b || { name: '', owed: '', rate: '', minimum: '', original: '', account: '', owner: 'shared' };
    const accs = [['', 'Not linked: not in net worth']].concat(D.accounts.filter((a) => !a.closed && (a.type === 'Loan' || a.type === 'Credit card')).map((a) => [a.id, a.name + ' (' + a.type.toLowerCase() + ')']));
    RK.drawer.open({
      kicker: b ? 'Edit debt' : 'New debt', title: b ? b.name : 'Add a debt',
      body: (b && !b.account ? ui.warnRow('Not in net worth until an account is linked.') : '') +
        '<div class="field"><label>Balance owed</label><div class="amount"><span>AED</span><input name="owed" inputmode="decimal" value="' + esc(v.owed) + '" placeholder="0"></div></div>' +
        ui.field('Name', ui.input('name', v.name, { placeholder: 'e.g. Car loan' })) +
        ui.field('Account', ui.select(null, accs, v.account || '', { name: 'account' }), null, 'A linked loan or card account carries the balance, so net worth counts it.') +
        ui.fieldRow(ui.field('Rate · % a year', ui.input('rate', v.rate)), ui.field('Minimum a month', ui.input('minimum', v.minimum))) +
        ui.fieldRow(ui.field('Original amount', ui.input('original', v.original, { placeholder: 'Optional' })), ui.field('Owner', ui.select(null, ui.ownerOptions(), v.owner, { name: 'owner' }))),
      footer: ui.drawerFooter({ del: b ? 'debt-delete' : null, delData: b ? { id: b.id } : null, save: 'debt-save', saveLabel: b ? 'Save' : 'Add debt', saveData: { id: b ? b.id : '' } }),
    });
  };
  A['debt-save'] = (el) => {
    const f = RK.drawer.values(), owed = Math.abs(Number(f.owed));
    if (!owed) { RK.toast('Enter a balance'); return; }
    if (!f.name) { RK.toast('Name it'); return; }
    let b = el.dataset.id ? D.debts.find((x) => x.id === el.dataset.id) : null;
    const isNew = !b;
    if (!b) { b = { id: 'b' + Date.now() }; D.debts.push(b); }
    Object.assign(b, { name: f.name, owed, rate: Number(f.rate) || 0, minimum: Number(f.minimum) || 0, original: Number(f.original) || owed, account: f.account || null, owner: f.owner });
    RK.drawer.close(); RK.toast(isNew ? 'Added ' + b.name : 'Saved ' + b.name); RK.render();
  };
  A['debt-delete'] = (el) => { const i = D.debts.findIndex((x) => x.id === el.dataset.id); if (i < 0) return; const gone = D.debts.splice(i, 1)[0]; RK.drawer.close(); RK.toast('Deleted ' + gone.name, () => D.debts.splice(i, 0, gone)); RK.render(); };

  /* ================= Notes ================= */
  const noteDue = (n) => n.yearly && (!n.checked || fmt.days(n.checked) < -365);
  const sortedNotes = () => D.notes.slice().sort((a, b) => (noteDue(b) ? 1 : 0) - (noteDue(a) ? 1 : 0) || (b.yearly ? 1 : 0) - (a.yearly ? 1 : 0));
  const noteHtml = (text) => {
    if (!text) return '<p class="muted">Empty.</p>';
    let html = '', list = [], para = [];
    const flush = () => {
      if (list.length) { html += '<ul>' + list.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>'; list = []; }
      if (para.length) { html += '<p>' + para.map(esc).join('<br>') + '</p>'; para = []; }
    };
    text.split('\n').forEach((l) => {
      if (/^# /.test(l)) { flush(); html += '<p class="note-h">' + esc(l.slice(2)) + '</p>'; }
      else if (/^- /.test(l)) { if (para.length) flush(); list.push(l.slice(2)); }
      else if (!l.trim()) flush();
      else { if (list.length) flush(); para.push(l); }
    });
    flush();
    return html;
  };
  function notesScreen() {
    if (!D.notes.length) return ui.card({ body: ui.empty('No notes yet', 'Reasons behind the plan, and things to check once a year.', ui.btn('Note', 'note-new', { kind: 'primary', icon: 'plus' })) });
    const list = sortedNotes(), cur = list.find((n) => n.id === S.noteSel) || list[0];
    const left = '<div class="rows">' + list.map((n) => '<div class="rw click' + (n.id === cur.id ? ' sel' : '') + '" data-action="note-pick" data-id="' + n.id + '"><div class="rw-main"><div class="rw-t truncate">' + esc(n.title) + '</div><div class="rw-s">Updated ' + fmt.date(n.updated) + '</div></div>' + (noteDue(n) ? ui.chip('Due', 'warn') : n.yearly ? ui.chip('Yearly') : '') + '</div>').join('') + '</div>';
    const right = '<section class="card"><div class="card-h"><div class="note-t">' + esc(cur.title) + '</div><div class="card-r">' + ui.btn('Edit', 'note-edit', { sm: true, data: { id: cur.id } }) + '</div></div>' +
      '<div class="card-b">' + (cur.yearly ? '<div class="warnrow' + (noteDue(cur) ? '' : ' note-ok') + '" style="margin-bottom:14px">' + ui.icon(noteDue(cur) ? 'alert' : 'check') + '<div class="grow">Checked once a year · ' + (cur.checked ? 'last checked ' + fmt.date(cur.checked) : 'not checked yet') + '</div>' + (noteDue(cur) ? ui.btn('Checked today', 'note-checked', { sm: true, data: { id: cur.id } }) : '') + '</div>' : '') +
      '<div class="note-body">' + noteHtml(cur.body) + '</div><div class="small muted" style="margin-top:14px">Updated ' + fmt.date(cur.updated) + ' by ' + esc(q.ownerName(cur.by)) + '</div></div></section>';
    return '<div class="grid"><div class="c-4">' + ui.card({ title: 'Notes', right: String(list.length), flush: true, body: left }) + '</div><div class="c-8">' + right + '</div></div>';
  }
  const openNote = (n) => RK.drawer.open({
    kicker: n ? 'Edit note' : 'New note', title: n ? n.title : 'Add a note', wide: true,
    body: ui.field('Title', ui.input('title', n ? n.title : '', { placeholder: 'e.g. Who pays what' })) +
      ui.field('Note', '<textarea class="inp" name="body" rows="12" placeholder="Why the plan is what it is">' + esc(n ? n.body : '') + '</textarea>', null, '“# ” starts a heading, “- ” a bullet, and a blank line a new paragraph.') +
      ui.switchField('yearly', n ? n.yearly : false, 'Check once a year', 'For insurance, wills and nominations'),
    footer: ui.drawerFooter({ del: n ? 'note-delete' : null, delData: n ? { id: n.id } : null, save: 'note-save', saveLabel: n ? 'Save' : 'Add note', saveData: { id: n ? n.id : '' } }),
  });
  A['note-new'] = () => openNote(null);
  A['note-edit'] = (el) => openNote(D.notes.find((n) => n.id === el.dataset.id));
  A['note-pick'] = (el) => { S.noteSel = el.dataset.id; RK.render(); };
  A['note-save'] = (el) => {
    const f = RK.drawer.values();
    if (!f.title) { RK.toast('Give it a title'); return; }
    let n = el.dataset.id ? D.notes.find((x) => x.id === el.dataset.id) : null;
    const isNew = !n;
    if (!n) { n = { id: 'n' + Date.now(), checked: null }; D.notes.push(n); }
    Object.assign(n, { title: f.title, body: f.body, yearly: !!f.yearly, updated: D.today, by: 'maya' });
    S.noteSel = n.id;
    RK.drawer.close(); RK.toast(isNew ? 'Added ' + n.title : 'Saved ' + n.title); RK.render();
  };
  A['note-delete'] = (el) => { const i = D.notes.findIndex((x) => x.id === el.dataset.id); if (i < 0) return; const gone = D.notes.splice(i, 1)[0]; S.noteSel = null; RK.drawer.close(); RK.toast('Deleted ' + gone.title, () => D.notes.splice(i, 0, gone)); RK.render(); };
  A['note-checked'] = (el) => { const n = D.notes.find((x) => x.id === el.dataset.id); const prev = n.checked; n.checked = D.today; RK.toast('Checked today', () => { n.checked = prev; }); RK.render(); };

  RK.screens['planning/notes'] = {
    tools: () => ui.chip('Private to your household') + ui.btn('Note', 'note-new', { kind: D.notes.length ? 'primary' : '', icon: 'plus' }),
    render: notesScreen,
  };
})();
