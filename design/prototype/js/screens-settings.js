/* Settings: Household, Categories & rules, Telegram, Backups. */
(function () {
  const RK = window.RK;
  const { fmt, q, ui } = RK;
  const D = RK.data, S = RK.state, A = RK.actions;
  const esc = fmt.esc;

  /* ================= Household ================= */
  RK.inputs['set-house'] = (el, e) => { if (e.type !== 'change') return; D.household[el.dataset.field] = el.dataset.field === 'name' ? el.value : Number(el.value) || D.household.inrPerAed; RK.toast('Saved'); RK.renderSoon(); };
  A['set-member'] = (el) => {
    const m = el.dataset.id ? q.member(el.dataset.id) : null;
    const v = m || { name: '', role: 'Member' };
    const onlyOwner = m && m.role === 'Owner' && D.members.filter((x) => x.role === 'Owner').length === 1;
    RK.drawer.open({
      kicker: m ? 'Member' : 'New member', title: m ? m.name : 'Add a member',
      body: ui.field('Name', ui.input('name', v.name, { placeholder: 'Their name' })) +
        ui.field('Role', ui.segField('role', [['Owner', 'Owner'], ['Member', 'Member']], v.role), onlyOwner ? 'The only owner. Add another first.' : m && !m.login ? 'Owner needs a login.' : null, 'An owner manages members and settings. A member can record, edit and link their own Telegram.') +
        (m ? '<dl class="kv" style="margin-top:6px"><dt>Login</dt><dd>' + (m.login ? ui.chip('Linked', 'pos') : ui.chip('No login yet')) + '</dd><dt>Telegram</dt><dd>' + (m.telegram ? ui.chip('Linked', 'pos') : ui.chip('Not linked') + ' ' + ui.btn('Link', 'go', { kind: 'text', sm: true, data: { route: 'settings/telegram' } })) + '</dd></dl>' : ''),
      footer: ui.drawerFooter({ del: m && !m.you ? 'set-member-del' : null, delData: m ? { id: m.id } : null, save: 'set-member-save', saveLabel: m ? 'Save' : 'Add member', saveData: { id: m ? m.id : '' } }),
    });
  };
  A['set-member-save'] = (el) => {
    const f = RK.drawer.values(); if (!f.name) { RK.toast('Give them a name'); return; }
    const m = el.dataset.id ? q.member(el.dataset.id) : null;
    if (m) Object.assign(m, { name: f.name, role: f.role }); else D.members.push({ id: 'm' + Date.now(), name: f.name, initial: f.name[0].toUpperCase(), tone: '', role: f.role, login: false, telegram: false, born: 1990 });
    RK.drawer.close(); RK.toast(m ? 'Saved ' + f.name : 'Added ' + f.name); RK.render();
  };
  A['set-member-del'] = (el) => { const i = D.members.findIndex((m) => m.id === el.dataset.id); const [g] = D.members.splice(i, 1); RK.drawer.close(); RK.toast('Removed ' + g.name, () => D.members.splice(i, 0, g)); RK.render(); };

  RK.screens['settings/household'] = {
    tools: () => ui.btn('Member', 'set-member', { kind: 'primary', icon: 'plus' }),
    render: () => '<div class="grid"><div class="c-5 stack-v">' +
      ui.card({ title: 'Household', body: '<div class="stack-v" style="gap:14px">' +
        ui.field('Name', '<input class="inp" data-input="set-house" data-field="name" value="' + esc(D.household.name) + '">') +
        ui.field('Rupee rate', '<div class="row"><span class="small muted nowrap">1 AED =</span><input class="inp" style="width:110px" data-input="set-house" data-field="inrPerAed" value="' + D.household.inrPerAed + '"><span class="small muted">INR</span><span class="grow"></span>' + ui.chip('Updated ' + fmt.date(D.household.rateUpdated)) + '</div>', null, 'Everything is stored in AED. The display currency in the account menu only changes how totals are shown: USD at the fixed peg of ' + D.household.usdAed + ', INR at this rate, which the nightly price refresh also updates.') + '</div>' }) +
      '<div class="small muted" style="padding:0 4px">Prototype build · made-up data · fields save when you leave them</div></div>' +
      '<div class="c-7">' + ui.card({ title: 'Members', info: 'An owner manages the list. A placeholder member with no login can still own accounts, transactions and goals.', flush: true, right: D.members.length + ' people',
        body: ui.table({ cols: [{ label: 'Name' }, { label: 'Role', width: '110px' }, { label: 'Login', width: '120px' }, { label: 'Telegram', width: '130px' }],
          rows: D.members.map((m) => ({ action: 'set-member', data: { id: m.id }, cells: ['<div class="row">' + ui.avatar(m.id, true) + '<span class="name">' + esc(m.name) + '</span>' + (m.you ? '<span class="muted small">you</span>' : '') + '</div>', m.role, m.login ? ui.chip('Linked', 'pos') : ui.chip('No login'), m.telegram ? ui.chip('Linked', 'pos') : ui.chip('Not linked', 'warn')] })) }) }) + '</div></div>',
  };

  /* ================= Categories & rules ================= */
  A['set-cat-open'] = (el) => {
    const c = el.dataset.id ? q.cat(el.dataset.id) : null, v = c || { name: '', kind: 'expense', group: '' };
    RK.drawer.open({
      kicker: c ? 'Category' : 'New category', title: c ? c.name : 'Add a category',
      body: ui.field('Name', ui.input('name', v.name, { placeholder: 'e.g. Pets' })) +
        ui.field('Kind', ui.segField('kind', [['expense', 'Expense'], ['income', 'Income']], v.kind)) +
        ui.fieldRow(ui.field('Group', ui.input('group', v.group || '', { placeholder: 'Optional' })), ui.field('Whose cost', ui.select(null, ui.ownerOptions(), v.owner || 'shared', { name: 'owner' }), null, 'Shared costs are split between you. One person\'s own costs are theirs alone.')) +
        ui.switchField('savings', !!v.savings, 'Savings, not spending', 'Its budget becomes a savings target') +
        ui.switchField('stops', !!v.stops, 'Stops when work stops', 'Left out of spending after work') +
        ui.switchField('archived', !!v.archived, 'Archived', 'Kept on past transactions only'),
      footer: ui.drawerFooter({ save: 'set-cat-save', saveLabel: c ? 'Save' : 'Add category', saveData: { id: c ? c.id : '' } }),
    });
  };
  A['set-cat-save'] = (el) => {
    const f = RK.drawer.values(); if (!f.name) { RK.toast('Name it'); return; }
    const c = el.dataset.id ? q.cat(el.dataset.id) : null;
    const patch = { name: f.name, kind: f.kind, group: f.group || undefined, owner: f.owner === 'shared' ? undefined : f.owner, savings: !!f.savings, stops: !!f.stops, archived: !!f.archived };
    if (c) Object.assign(c, patch); else D.categories.push(Object.assign({ id: 'c' + Date.now() }, patch));
    RK.drawer.close(); RK.toast(c ? 'Saved ' + f.name : 'Added ' + f.name); RK.render();
  };
  A['set-rule-open'] = (el) => {
    const r = el.dataset.id ? D.rules.find((x) => x.id === el.dataset.id) : null, v = r || { match: 'Contains', pattern: '', cat: '', active: true };
    RK.drawer.open({
      kicker: r ? 'Rule' : 'New rule', title: r ? v.match + ' “' + v.pattern + '”' : 'Add a rule',
      body: ui.field('Match', ui.segField('match', [['Contains', 'Contains'], ['Starts with', 'Starts with']], v.match), null, 'Matching ignores letter case. A rule files new entries from the bot and the Inbox; "Apply" files past uncategorised transactions.') +
        ui.field('Merchant pattern', ui.input('pattern', v.pattern, { placeholder: 'e.g. greenleaf' })) +
        ui.field('Category', ui.select(null, ui.catOptions('Choose…'), v.cat, { name: 'cat' })) +
        ui.switchField('active', v.active, 'Active', 'An inactive rule stops filing'),
      footer: ui.drawerFooter({ del: r ? 'set-rule-del' : null, delData: r ? { id: r.id } : null, save: 'set-rule-save', saveLabel: r ? 'Save' : 'Add rule', saveData: { id: r ? r.id : '' } }),
    });
  };
  A['set-rule-save'] = (el) => {
    const f = RK.drawer.values(); if (!f.pattern || !f.cat) { RK.toast('Enter a pattern and choose a category'); return; }
    const r = el.dataset.id ? D.rules.find((x) => x.id === el.dataset.id) : null, patch = { match: f.match, pattern: f.pattern.toLowerCase(), cat: f.cat, active: !!f.active };
    if (r) Object.assign(r, patch); else D.rules.push(Object.assign({ id: 'u' + Date.now() }, patch));
    RK.drawer.close(); RK.toast('Saved rule'); RK.render();
  };
  A['set-rule-del'] = (el) => { const i = D.rules.findIndex((x) => x.id === el.dataset.id); const [g] = D.rules.splice(i, 1); RK.drawer.close(); RK.toast('Deleted rule', () => D.rules.splice(i, 0, g)); RK.render(); };
  A['set-rule-apply'] = (el) => {
    const r = D.rules.find((x) => x.id === el.dataset.id);
    const hit = D.transactions.filter((t) => !t.cat && !t.transfer && (r.match === 'Contains' ? t.merchant.toLowerCase().includes(r.pattern) : t.merchant.toLowerCase().startsWith(r.pattern)));
    hit.forEach((t) => (t.cat = r.cat));
    RK.toast('Applied to ' + hit.length + ' uncategorised transaction' + (hit.length === 1 ? '' : 's'), hit.length ? () => hit.forEach((t) => (t.cat = null)) : null); RK.render();
  };

  RK.screens['settings/categories'] = {
    tools: () => ui.btn('Rule', 'set-rule-open', { icon: 'plus' }) + ui.btn('Category', 'set-cat-open', { kind: 'primary', icon: 'plus' }),
    render: () => {
      const groups = [['Income', D.categories.filter((c) => c.kind === 'income')]];
      D.categories.filter((c) => c.kind === 'expense' && !c.savings).forEach((c) => { const g = c.group || 'Other'; let e = groups.find((x) => x[0] === g); if (!e) groups.push((e = [g, []])); e[1].push(c); });
      groups.push(['Savings', D.categories.filter((c) => c.savings)]);
      const rows = [];
      groups.forEach(([g, list]) => { if (!list.length) return; rows.push({ cls: 'group', cells: [{ html: esc(g), span: 4 }] }); list.forEach((c) => rows.push({ action: 'set-cat-open', data: { id: c.id }, cells: ['<span class="name">' + esc(c.name) + '</span>', c.owner ? '<div class="row">' + ui.avatar(c.owner) + esc(q.ownerName(c.owner)) + '</div>' : '<span class="ink2">Shared</span>', D.budgets[c.id] ? fmt.money(D.budgets[c.id]) : '', '<div class="row" style="justify-content:flex-end">' + (c.savings ? ui.chip('Savings', 'accent') : '') + (c.stops ? ui.chip('Stops with work') : '') + (c.archived ? ui.chip('Archived') : '') + '</div>'] })); });
      return '<div class="grid"><div class="c-7">' + ui.card({ title: 'Categories', right: D.categories.length + ' in ' + groups.filter((g) => g[1].length).length + ' groups', flush: true, body: ui.table({ compact: true, cols: [{ label: 'Category' }, { label: 'Whose cost', width: '130px' }, { label: 'Budget a month', num: true, width: '120px' }, { label: '', width: '170px' }], rows }) }) + '</div>' +
        '<div class="c-5">' + ui.card({ title: 'Merchant rules', info: 'The first matching rule decides. Rules apply to new entries; "Apply" files past uncategorised transactions.', right: D.rules.filter((r) => r.active).length + ' active', flush: true,
          body: ui.table({ compact: true, cols: [{ label: 'When the merchant' }, { label: 'File under' }, { label: '', width: '70px' }],
            rows: D.rules.map((r) => ({ action: 'set-rule-open', data: { id: r.id }, cells: ['<span class="muted">' + r.match.toLowerCase() + '</span> <span class="mono" style="color:var(--ink)">' + esc(r.pattern) + '</span>' + (r.active ? '' : ' ' + ui.chip('Off')), esc(q.catName(r.cat)), { cls: 'act', html: r.active ? ui.btn('Apply', 'set-rule-apply', { kind: 'text', sm: true, data: { id: r.id } }) : '' }] })) }) }) + '</div></div>';
    },
  };

  /* ================= Telegram ================= */
  A['set-tg-toggle'] = (el) => { const all = D.telegram.morning.concat(D.telegram.questions); const t = all.find((x) => x.id === el.dataset.id); t.on = !t.on; RK.toast(t.name + (t.on ? ' on' : ' off')); RK.render(); };
  A['set-tg-who'] = (el) => { S.tgWho = el.dataset.value; RK.render(); };
  A['set-tg-unlink'] = (el) => { const m = q.member(el.dataset.id); m.telegram = false; RK.toast('Unlinked ' + m.name, () => (m.telegram = true)); RK.render(); };
  A['set-tg-link'] = (el) => {
    const m = q.member(el.dataset.id);
    let cells = ''; /* a stand-in pattern, not a real code */
    const finder = (x, y) => { const lx = x > 13 ? x - 14 : x, ly = y > 13 ? y - 14 : y; return lx === 0 || lx === 6 || ly === 0 || ly === 6 || (lx > 1 && lx < 5 && ly > 1 && ly < 5); };
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) { const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13); const gap = (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12); const on = corner ? finder(x, y) : !gap && (x * 7 + y * 13 + x * y) % 3 === 0; if (on) cells += '<rect x="' + x * 6 + '" y="' + y * 6 + '" width="6" height="6"/>'; }
    RK.drawer.open({
      kicker: 'Telegram', title: 'Link ' + m.name,
      body: '<div class="stack-v" style="align-items:center;text-align:center;gap:14px;padding-top:8px">' + ui.btn('Open Telegram', 'set-tg-linked', { kind: 'primary', data: { id: m.id } }) + '<div class="small muted">or scan with the phone that has Telegram</div><div class="qr"><svg viewBox="0 0 126 126" width="150" height="150" fill="currentColor">' + cells + '</svg></div>' +
        '<div class="small muted">or send this code to the bot</div><div class="row"><span class="mono code-box">7f3a-91c2-0be4-d5a8</span>' + ui.btn('Copy', 'set-tg-copy', { sm: true }) + '</div><div class="small muted">Works once, for 15 minutes.</div></div>',
      footer: '<span class="grow"></span>' + ui.btn('Close', 'drawer-close'),
    });
  };
  A['set-tg-copy'] = () => RK.toast('Code copied');
  A['set-tg-linked'] = (el) => { const m = q.member(el.dataset.id); m.telegram = true; RK.drawer.close(); RK.toast('Linked ' + m.name); RK.render(); };

  RK.screens['settings/telegram'] = {
    tools: () => '<span class="small muted">Alerts for</span>' + ui.seg('set-tg-who', D.members.map((m) => [m.id, m.name]), S.tgWho || D.members[0].id),
    render: () => {
      const row = (t) => '<div class="rw"><div class="rw-main"><div class="rw-t">' + esc(t.name) + '</div><div class="rw-s">' + esc(t.when) + '</div></div>' + ui.sw(t.on, 'set-tg-toggle', { id: t.id }) + '</div>';
      const st = D.telegram.stats;
      return '<div class="grid"><div class="c-7 stack-v">' +
        ui.card({ title: 'Morning message', info: 'Everything that needs no answer arrives together, once, at 09:00.', flush: true, body: '<div class="rows">' + D.telegram.morning.map(row).join('') + '<div class="rw"><div class="rw-main"><div class="rw-t">Budget alerts</div><div class="rw-s">Set per category, at 80%, 90% and over</div></div>' + ui.link('Budget', 'money/budget') + '</div></div>' }) +
        ui.card({ title: 'Questions that need an answer', info: 'Each arrives as its own message with buttons, after the morning message.', flush: true, body: '<div class="rows">' + D.telegram.questions.map(row).join('') + '</div>' }) + '</div>' +
        '<div class="c-5 stack-v">' + ui.card({ title: 'Linked accounts', flush: true, body: '<div class="rows">' + D.members.map((m) => '<div class="rw">' + ui.avatar(m.id, true) + '<div class="rw-main"><div class="rw-t">' + esc(m.name) + '</div></div>' + (m.telegram ? ui.chip('Linked', 'pos') + ui.btn('Unlink', 'set-tg-unlink', { kind: 'text', sm: true, data: { id: m.id } }) : ui.chip('Not linked', 'warn') + ui.btn('Link', 'set-tg-link', { sm: true, data: { id: m.id } })) + '</div>').join('') + '</div>' }) +
        '<section class="card">' + ui.fold('Diagnostics · last 30 days', '<div style="padding:0 18px 14px"><div class="kpis" style="margin:0 -18px 8px"><div class="kpi"><div class="kpi-l">Messages handled</div><div class="fig-s">' + st.calls + '</div></div><div class="kpi"><div class="kpi-l">Read without error</div><div class="fig-s">' + st.success + '%</div></div></div>' + ui.table({ compact: true, cols: [{ label: 'Day' }, { label: 'Messages', num: true }], rows: st.days.map((d) => ({ cells: ['<span class="mono muted">' + fmt.date(d[0]) + '</span>', String(d[1])] })) }) + '</div>') + '</section></div></div>';
    },
  };

  /* ================= Backups ================= */
  A['set-bk-record'] = () => {
    const g = (n) => document.querySelector('[name="bk-' + n + '"]').value;
    D.backups.history.unshift({ kind: g('kind'), date: g('date'), result: g('result'), by: 'maya', note: g('note') });
    RK.toast('Recorded ' + g('kind').toLowerCase()); RK.render();
  };
  A['set-bk-runbook'] = () => RK.toast('The runbook opens outside the prototype');

  RK.screens['settings/backups'] = {
    render: () => {
      const latest = (kind) => D.backups.history.find((h) => h.kind === kind);
      const line = (kind) => { const h = latest(kind); if (!h) return '<div class="rw"><div class="rw-main"><div class="rw-t">' + kind + '</div><div class="rw-s">None recorded</div></div>' + ui.chip('Missing', 'warn') + '</div>'; const age = -fmt.days(h.date), late = kind === 'Export' && age > D.backups.dueEvery; return '<div class="rw"><div class="rw-main"><div class="rw-t">' + kind + '</div><div class="rw-s">' + h.result + ' ' + fmt.date(h.date) + ' · ' + age + ' days ago</div></div>' + (h.result === 'Failed' ? ui.chip('Failed', 'neg') : late ? ui.chip('Late', 'warn') : ui.chip('OK', 'pos')) + '</div>'; };
      return '<div class="grid"><div class="c-5 stack-v">' +
        ui.card({ title: 'Latest', info: 'Exports and restore drills are done by hand, following the runbook. An export is due every ' + D.backups.dueEvery + ' days. What is recorded here is what someone said they did, not a check the app ran.', right: '<button class="link" data-action="set-bk-runbook">Runbook →</button>', flush: true, body: '<div class="rows">' + line('Export') + line('Restore drill') + '</div>' }) +
        ui.card({ title: 'Record a backup', body: '<div class="stack-v" style="gap:12px">' + ui.fieldRow(ui.field('Kind', ui.select(null, [['Export', 'Export'], ['Restore drill', 'Restore drill']], 'Export', { name: 'bk-kind' })), ui.field('Result', ui.select(null, [['Passed', 'Passed'], ['Failed', 'Failed']], 'Passed', { name: 'bk-result' }))) + ui.field('Date', ui.input('bk-date', D.today, { type: 'date' })) + ui.field('Note', ui.input('bk-note', '', { placeholder: 'Where it is kept, or what went wrong' })) + '<div>' + ui.btn('Record', 'set-bk-record', { kind: 'primary' }) + '</div></div>' }) + '</div>' +
        '<div class="c-7">' + ui.card({ title: 'History', right: D.backups.history.length + ' recorded', flush: true, body: ui.table({ cols: [{ label: 'Date', width: '90px' }, { label: 'Kind', width: '120px' }, { label: 'Result', width: '90px' }, { label: 'By', width: '60px' }, { label: 'Note' }], rows: D.backups.history.map((h) => ({ cells: ['<span class="mono muted">' + fmt.date(h.date) + '</span>', h.kind, ui.chip(h.result, h.result === 'Passed' ? 'pos' : 'neg'), ui.avatar(h.by), h.note ? '<span class="ink2 small">' + esc(h.note) + '</span>' : ''] })) }) }) + '</div></div>';
    },
  };
})();
