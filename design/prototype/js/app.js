/* Shell, navigation and global event wiring. Loaded last.
   Routes are the address hash: #/money/budget. Extra state can ride along for
   deep links: #/money/budget?month=2026-07&theme=dark&scope=maya&currency=USD */
(function () {
  const RK = window.RK;
  const { fmt, q, ui } = RK;
  const D = RK.data, S = RK.state;

  RK.nav = [
    { id: 'overview', label: 'Overview', icon: 'home' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', count: () => q.inboxCount() },
    { id: 'money', label: 'Money', icon: 'wallet', tabs: [['activity', 'Activity'], ['budget', 'Budget'], ['recurring', 'Recurring'], ['monthend', 'Month end']] },
    { id: 'wealth', label: 'Wealth', icon: 'chart', tabs: [['networth', 'Net worth'], ['investments', 'Investments'], ['dividends', 'Dividends']] },
    { id: 'planning', label: 'Planning', icon: 'compass', tabs: [['plan', 'Plan'], ['goals', 'Goals & debts'], ['notes', 'Notes']] },
    { id: 'settings', label: 'Settings', icon: 'settings', gap: true, tabs: [['household', 'Household'], ['categories', 'Categories & rules'], ['telegram', 'Telegram'], ['backups', 'Backups']] },
  ];
  const lastTab = {};

  RK.go = (route) => { if ('#/' + route === location.hash) RK.render(); else location.hash = '#/' + route; };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, query] = h.split('?');
    let [sec, tab] = (path || 'overview').split('/');
    const item = RK.nav.find((n) => n.id === sec) || RK.nav[0];
    if (item.tabs) { if (!item.tabs.some((t) => t[0] === tab)) tab = lastTab[item.id] || item.tabs[0][0]; lastTab[item.id] = tab; } else tab = null;
    S.route = item.id + (tab ? '/' + tab : '');
    new URLSearchParams(query || '').forEach((v, k) => {
      if (k === 'month' && D.months.includes(v)) S.month = v;
      if (k === 'theme') S.theme = v;
      if (k === 'scope') S.scope = v;
      if (k === 'currency') S.currency = v;
      if (k === 'view') S.activity.view = v;
    });
  }

  function renderSide() {
    const sec = S.route.split('/')[0];
    const me = D.members.find((m) => m.you);
    document.getElementById('side').innerHTML =
      '<div class="brand"><span class="brand-mark">' + ui.icon('mark') + '</span>Rokda</div>' +
      '<div class="side-label">Showing</div>' +
      ui.seg('set-scope', [['both', 'Both']].concat(D.members.map((m) => [m.id, m.name])), S.scope, null, true) +
      '<nav class="nav">' + RK.nav.map((n) => (n.gap ? '<div class="nav-gap"></div>' : '') + '<a href="#/' + n.id + '" class="' + (n.id === sec ? 'on' : '') + '">' + ui.icon(n.icon) + n.label + (n.count && n.count() ? '<span class="count">' + n.count() + '</span>' : '') + '</a>').join('') + '</nav>' +
      '<div class="side-foot"><button class="acct" data-action="acct-menu">' + ui.avatar(me.id, true) + '<span><div class="acct-name">' + fmt.esc(me.name) + '</div><div class="acct-sub">' + fmt.esc(D.household.name) + '</div></span>' + ui.icon('down') + '</button></div>';
  }

  RK.render = (opts) => {
    opts = opts || {};
    document.documentElement.dataset.theme = S.theme;
    const active = document.activeElement, keep = active && active.dataset && active.dataset.input && !active.closest('#drawer-root') ? { name: active.dataset.input, pos: active.selectionStart } : null;
    const [sec, tab] = S.route.split('/');
    const item = RK.nav.find((n) => n.id === sec);
    const scr = RK.screens[S.route];
    renderSide();
    const title = scr && scr.title ? scr.title() : fmt.esc(item.label);
    const kicker = scr && scr.kicker ? scr.kicker() : '';
    const main = document.getElementById('main');
    const scrollY = opts.keepScroll === false ? 0 : window.scrollY;
    main.innerHTML = '<div class="page-wrap">' +
      '<header class="head"><div class="head-l">' + (kicker ? '<div class="kicker">' + kicker + '</div>' : '') + '<h1>' + title + (S.currency !== 'AED' ? ui.chip('Showing ' + S.currency, 'accent') : '') + (S.scope !== 'both' ? ui.chip(q.ownerName(S.scope) + '’s share') : '') + '</h1></div>' +
      '<div class="head-r">' + (scr && scr.tools ? scr.tools() : '') + '<button class="refresh" data-action="refresh" title="Loaded ' + S.loadedAt + '">' + ui.icon('refresh') + S.loadedAt + '</button></div></header>' +
      (item.tabs ? '<nav class="tabs">' + item.tabs.map((t) => '<a href="#/' + item.id + '/' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' + t[1] + '</a>').join('') + '</nav>' : '') +
      (scr && scr.banner ? scr.banner() : '') +
      '<div class="page">' + (scr ? scr.render() : ui.card({ body: ui.empty('This screen is not built yet', S.route) })) + '</div></div>';
    RK.charts.flush();
    if (opts.keepScroll !== false) window.scrollTo(0, scrollY);
    if (keep) { const el = document.querySelector('#main [data-input="' + keep.name + '"]'); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) { /* not a text field */ } } }
    document.title = 'Rokda · ' + item.label;
  };

  /* ---------- global actions ---------- */
  const A = RK.actions;
  A.go = (el) => { if (el.dataset.month) S.month = el.dataset.month; if (el.dataset.view) S.activity.view = el.dataset.view; RK.drawer.close(); RK.go(el.dataset.route); };
  A['go-month-end'] = (el) => { if (el.dataset.month) S.month = el.dataset.month; RK.go('money/monthend'); };
  A['set-scope'] = (el) => { S.scope = el.dataset.value; RK.render(); };
  A['set-currency'] = (el) => { S.currency = el.dataset.value; RK.popClose(); RK.render(); };
  A['set-theme'] = (el) => { S.theme = el.dataset.value; RK.popClose(); RK.render(); };
  A['set-period'] = (el) => { S.period = el.dataset.value; RK.render(); };
  A['month-prev'] = () => { const i = D.months.indexOf(S.month); if (i > 0) { S.month = D.months[i - 1]; RK.render(); } };
  A['month-next'] = () => { const i = D.months.indexOf(S.month); if (i < D.months.length - 1) { S.month = D.months[i + 1]; RK.render(); } };
  A.refresh = (el) => {
    el.classList.add('spin');
    setTimeout(() => { const d = new Date(); S.loadedAt = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); RK.render(); }, 650);
  };
  A['acct-menu'] = (el) => RK.pop(el,
    '<div class="m-l">Display currency</div><div style="padding:0 8px 6px">' + ui.seg('set-currency', [['AED', 'AED'], ['USD', 'USD'], ['INR', 'INR']], S.currency, null, true) + '</div>' +
    '<div class="m-l">Theme</div><div style="padding:0 8px 6px">' + ui.seg('set-theme', [['light', 'Light'], ['dark', 'Dark']], S.theme, null, true) + '</div>' +
    '<div class="m-sep"></div><button class="m-i" data-action="open-health">Data health<span class="muted">' + q.dataHealth().length + ' to check</span></button>' +
    '<button class="m-i" data-action="open-palette">Quick add and jump<kbd>Ctrl K</kbd></button>' +
    '<div class="m-sep"></div><button class="m-i" data-action="sign-out">Sign out</button><div class="m-l">Prototype · made-up data</div>', true);
  A['sign-out'] = () => { RK.popClose(); RK.toast('Signing out is not part of the prototype'); };
  /* Data health (R3): every "not entered / stale / not linked" in one list, each with its fix. */
  A['open-health'] = () => {
    RK.popClose();
    const items = q.dataHealth();
    RK.drawer.open({
      kicker: 'Data health', title: items.length ? items.length + ' things to check' : 'All clear',
      body: items.length ? '<div class="rows" style="margin:0 -22px">' + items.map((x) => '<div class="rw" style="padding:8px 22px"><div class="rw-main"><div class="rw-t">' + fmt.esc(x.text) + '</div><div class="rw-s">' + fmt.esc(x.note) + '</div></div>' + ui.btn(x.label, x.action, { sm: true, data: { id: x.id } }) + '</div>').join('') + '</div>' : ui.empty('All clear', 'Every balance, price and link is in place.'),
      footer: '<span class="grow"></span>' + ui.btn('Close', 'drawer-close'),
    });
  };

  /* ---------- quick add and jump (R1) ---------- */
  function paletteItems(text) {
    const t = text.trim().toLowerCase(), out = [];
    const m = t.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m) out.push({ label: 'Add transaction: AED ' + m[1] + ' · ' + m[2], hint: 'today · Skyline card', run: () => {
      const rule = D.rules.find((r) => r.active && m[2].includes(r.pattern));
      const row = { id: 't' + Date.now(), date: D.today, merchant: m[2].replace(/^\w/, (c) => c.toUpperCase()), cat: rule ? rule.cat : null, account: 'sky', owner: 'shared', amount: -Number(m[1]) };
      D.transactions.unshift(row);
      RK.toast('Added ' + row.merchant + ' · AED ' + m[1], () => D.transactions.splice(D.transactions.indexOf(row), 1));
      RK.render();
    } });
    RK.nav.forEach((n) => (n.tabs || [[null, n.label]]).forEach((tb) => {
      const label = n.tabs ? n.label + ' › ' + tb[1] : n.label;
      if (!t || label.toLowerCase().includes(t)) out.push({ label: 'Go to ' + label, hint: '', run: () => RK.go(n.id + (tb[0] ? '/' + tb[0] : '')) });
    }));
    return out.slice(0, 8);
  }
  function drawPalette(text) {
    const items = (RK._pal = paletteItems(text));
    document.getElementById('pal-list').innerHTML = items.map((x, i) => '<button class="m-i' + (i === 0 ? ' on' : '') + '" data-action="pal-run" data-i="' + i + '"><span>' + fmt.esc(x.label) + '</span><span class="muted small">' + fmt.esc(x.hint) + '</span></button>').join('') || '<div class="hintline">Nothing matches.</div>';
  }
  A['open-palette'] = () => {
    RK.popClose();
    document.getElementById('pop-root').innerHTML = '<div class="scrim" data-action="pal-close"></div><div class="palette"><input id="pal-in" placeholder="Type “45 coffee” to add, or a screen name to jump" autocomplete="off"><div id="pal-list"></div><div class="hintline"><kbd>Enter</kbd> to run · <kbd>Esc</kbd> to close</div></div>';
    drawPalette('');
    document.getElementById('pal-in').focus();
  };
  A['pal-close'] = () => RK.popClose();
  A['pal-run'] = (el) => { const x = RK._pal[+el.dataset.i]; RK.popClose(); if (x) x.run(); };

  /* ---------- event wiring ---------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    const inPop = e.target.closest('#pop-root');
    if (!inPop && document.getElementById('pop')) RK.popClose();
    if (!el) return;
    const ctl = e.target.closest('select, input, textarea, label');
    if (ctl && ctl !== el && el.contains(ctl)) return; // a control inside a clickable row
    const fn = A[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el, e);
    if (inPop && el.classList.contains('m-i') && document.getElementById('pop')) RK.popClose();
  });
  const onInput = (e) => {
    if (e.target.id === 'pal-in') { drawPalette(e.target.value); return; }
    if (e.target.closest('#dr-form') && !RK.drawer.dirty) { RK.drawer.dirty = true; const u = document.getElementById('dr-unsaved'); if (u) u.innerHTML = ui.chip('Unsaved', 'warn'); }
    const el = e.target.closest('[data-input]');
    if (el && RK.inputs[el.dataset.input] && (e.type === 'change' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) RK.inputs[el.dataset.input](el, e);
  };
  document.addEventListener('input', (e) => { if (e.target.tagName !== 'SELECT') onInput(e); });
  /* Text fields fire handlers on every keystroke ('input') and once more when left ('change'); handlers can tell by e.type. */
  document.addEventListener('change', onInput);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); A['open-palette'](); return; }
    if (e.key === 'Enter' && e.target.id === 'pal-in') { const x = (RK._pal || [])[0]; RK.popClose(); if (x) x.run(); return; }
    if (e.key === 'Escape') { if (document.getElementById('pop-root').innerHTML) RK.popClose(); else if (RK.drawer.cfg) A['drawer-close'](); return; }
    if (RK.keys && !e.target.closest('input, textarea, select') && !RK.drawer.cfg) { const k = RK.keys[S.route]; if (k && k[e.key]) { e.preventDefault(); k[e.key](); } }
  });
  const tip = document.getElementById('tip');
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el || !el.dataset.tip) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + 'px'; tip.style.top = e.clientY - 34 + 'px';
  });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(RK.charts.flush, 120); });
  window.addEventListener('hashchange', () => { parseHash(); RK.render({ keepScroll: false }); });

  parseHash();
  RK.render({ keepScroll: false });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(RK.charts.flush);
})();
