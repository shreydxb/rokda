/* Shared pieces. Every helper returns an HTML string; screens compose them.
   Clicks are wired by attribute: data-action="name" runs RK.actions[name](el, event),
   with the element's other data-* attributes as its arguments.
   Inputs: data-input="name" runs RK.inputs[name](el) on input/change. */
(function () {
  const RK = window.RK;
  const { fmt, q } = RK;
  const esc = fmt.esc;
  const ui = (RK.ui = {});

  const I = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6l2-8z"/>',
    wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 7l12-3v3"/><circle cx="16.5" cy="13.5" r="1"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16l4-5 3 3 5-7"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v5M12 17.5v.5"/>',
    note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    photo: '<rect x="3" y="6" width="18" height="13" rx="2"/><circle cx="12" cy="12.5" r="3"/>',
    text: '<path d="M4 6h16v10H9l-5 4z"/>',
    mark: '<path d="M4 18V8l5 5 4-7 7 12"/>',
  };
  ui.icon = (n) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[n] || '') + '</svg>';

  const dataAttrs = (d) => Object.keys(d || {}).map((k) => ' data-' + k + '="' + esc(d[k]) + '"').join('');

  /* chip(text, tone) — tone: '' | warn | neg | pos | accent */
  ui.chip = (text, tone, action, data) => action
    ? '<button class="chip ' + (tone || '') + '" data-action="' + action + '"' + dataAttrs(data) + '>' + esc(text) + '</button>'
    : '<span class="chip ' + (tone || '') + '">' + esc(text) + '</span>';

  /* btn(label, action, {kind:'primary'|'text'|'danger', sm, icon, data, disabled}) */
  ui.btn = (label, action, o) => {
    o = o || {};
    return '<button class="btn ' + (o.kind || '') + (o.sm ? ' sm' : '') + '"' + (action ? ' data-action="' + action + '"' : '') + dataAttrs(o.data) + (o.disabled ? ' disabled' : '') + '>' + (o.icon ? ui.icon(o.icon) : '') + esc(label) + '</button>';
  };
  ui.link = (label, route) => '<button class="link" data-action="go" data-route="' + route + '">' + esc(label) + ' →</button>';
  ui.info = (text) => '<button class="info" data-action="info" data-text="' + esc(text) + '" aria-label="How this is worked out">i</button>';
  ui.avatar = (owner, lg) => {
    if (owner === 'shared') return '<span class="avatar' + (lg ? ' lg' : '') + '" title="Shared">S</span>';
    const m = q.member(owner);
    return m ? '<span class="avatar ' + m.tone + (lg ? ' lg' : '') + '" title="' + esc(m.name) + '">' + m.initial + '</span>' : '';
  };

  /* seg(action, [[value,label],…], current, data) */
  ui.seg = (action, opts, cur, data, full) => '<div class="seg' + (full ? ' full' : '') + '">' + opts.map((o) => '<button class="' + (o[0] === cur ? 'on' : '') + '" data-action="' + action + '" data-value="' + esc(o[0]) + '"' + dataAttrs(data) + '>' + esc(o[1]) + '</button>').join('') + '</div>';
  /* select(inputName, [[value,label],…], current, {sm, data, name}) */
  ui.select = (input, opts, cur, o) => {
    o = o || {};
    return '<select class="sel' + (o.sm ? ' sm' : '') + '"' + (input ? ' data-input="' + input + '"' : '') + (o.name ? ' name="' + o.name + '"' : '') + dataAttrs(o.data) + '>' + opts.map((x) => '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(cur == null ? '' : cur) ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select>';
  };
  ui.catOptions = (blank) => (blank ? [['', blank]] : []).concat(RK.data.categories.filter((c) => !c.savings).map((c) => [c.id, (c.group ? c.group + ' › ' : '') + c.name]));
  ui.accOptions = (blank) => (blank ? [['', blank]] : []).concat(RK.data.accounts.filter((a) => !a.closed).map((a) => [a.id, a.name]));
  ui.ownerOptions = () => [['shared', 'Shared']].concat(RK.data.members.map((m) => [m.id, m.name]));

  /* stepper(label, prevAction, nextAction, {prevOff, nextOff}) */
  ui.stepper = (label, prev, next, o) => {
    o = o || {};
    return '<div class="stepper"><button data-action="' + prev + '"' + (o.prevOff ? ' disabled' : '') + ' aria-label="Earlier">' + ui.icon('left') + '</button><span class="lbl">' + esc(label) + '</span><button data-action="' + next + '"' + (o.nextOff ? ' disabled' : '') + ' aria-label="Later">' + ui.icon('right') + '</button></div>';
  };
  /* The one month switcher (P8). The month is shared across the Money tabs. */
  ui.monthStepper = () => {
    const M = RK.data.months, m = RK.state.month;
    return ui.stepper(fmt.month(m), 'month-prev', 'month-next', { prevOff: m === M[0], nextOff: m === M[M.length - 1] });
  };
  ui.sw = (on, action, data) => '<button class="switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + !!on + '" data-action="' + action + '"' + dataAttrs(data) + '></button>';

  /* card({title, info, right, body, flush, cls}) */
  ui.card = (o) => '<section class="card ' + (o.cls || '') + '">' + (o.title || o.right ? '<div class="card-h"><div class="card-t">' + esc(o.title || '') + (o.info ? ui.info(o.info) : '') + (o.titleExtra || '') + '</div><div class="card-r">' + (o.right || '') + '</div></div>' : '') + '<div class="card-b' + (o.flush ? ' flush' : '') + '">' + o.body + '</div></section>';

  /* kpis([{label, value, sub, hero, tone, info}]) — one strip split by hairlines */
  ui.kpis = (items) => '<div class="kpis">' + items.map((k) => '<div class="kpi"><div class="kpi-l">' + esc(k.label) + (k.info ? ui.info(k.info) : '') + '</div><div class="' + (k.hero ? 'hero-fig' : 'fig') + ' ' + (k.tone || '') + '">' + k.value + '</div>' + (k.sub ? '<div class="kpi-s">' + k.sub + '</div>' : '') + '</div>').join('') + '</div>';

  /* table({cols:[{label, num, width, sort}], rows:[{cells:[html…], action, data, cls}], compact, sort:{key,dir,action}})
     A row with an action is clickable. cells may be '' for blanks. */
  ui.table = (o) => {
    const th = o.cols.map((c) => {
      let label = esc(c.label || '');
      if (c.sort && o.sort) label = '<button data-action="' + o.sort.action + '" data-key="' + c.sort + '">' + label + (o.sort.key === c.sort ? (o.sort.dir === 'asc' ? ' ↑' : ' ↓') : '') + '</button>';
      return '<th class="' + (c.num ? 'num' : '') + '"' + (c.width ? ' style="width:' + c.width + '"' : '') + '>' + label + (c.info ? ' ' + ui.info(c.info) : '') + '</th>';
    }).join('');
    const body = o.rows.map((r) => '<tr class="' + (r.action ? 'click ' : '') + (r.cls || '') + '"' + (r.action ? ' data-action="' + r.action + '"' : '') + dataAttrs(r.data) + '>' + r.cells.map((c, i) => {
      const col = o.cols[i] || {};
      if (c && typeof c === 'object') return '<td class="' + (col.num ? 'num ' : '') + (c.cls || '') + '"' + (c.span ? ' colspan="' + c.span + '"' : '') + '>' + c.html + '</td>';
      return '<td class="' + (col.num ? 'num ' : '') + (col.cls || '') + '">' + (c == null || c === '' ? '<span class="muted">—</span>' : c) + '</td>';
    }).join('') + '</tr>').join('');
    return '<table class="tbl' + (o.compact ? ' compact' : '') + '"><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table>';
  };
  ui.two = (top, sub) => '<div class="name truncate">' + top + '</div><div class="sub truncate">' + sub + '</div>';

  /* bar(pct 0..1+, {tone:'pos'|'neg'|'ctx', tick:0..1, lg}) */
  ui.bar = (p, o) => {
    o = o || {};
    return '<div class="bar ' + (o.tone || '') + (o.lg ? ' lg' : '') + '"><i style="width:' + Math.max(0, Math.min(1, p)) * 100 + '%"></i>' + (o.tick != null ? '<b style="left:calc(' + Math.max(0, Math.min(1, o.tick)) * 100 + '% - 1px)"></b>' : '') + '</div>';
  };
  /* stack([{label, value}]) — 100% composition bar in steps of the accent, largest first, with a legend */
  ui.stack = (parts) => {
    const cols = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--context)', 'var(--control)'];
    const p = parts.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const tot = p.reduce((s, x) => s + x.value, 0) || 1;
    return '<div class="stackbar">' + p.map((x, i) => '<i style="width:' + (x.value / tot) * 100 + '%;background:' + cols[Math.min(i, 5)] + '" data-tip="' + esc(x.label + ' · ' + fmt.money(x.value)) + '"></i>').join('') + '</div><div class="legend">' + p.map((x, i) => '<span><i style="background:' + cols[Math.min(i, 5)] + '"></i>' + esc(x.label) + ' <b class="muted" style="font-weight:400">' + Math.round((x.value / tot) * 100) + '%</b></span>').join('') + '</div>';
  };
  /* barList([{label, value(html), frac, tick, note, action, data, tone}]) — ranked bars, optional tick at the usual */
  ui.barList = (items) => '<div class="barlist">' + items.map((x) => '<div class="bl' + (x.action ? ' click' : '') + '"' + (x.action ? ' data-action="' + x.action + '"' : '') + dataAttrs(x.data) + '><div class="bl-n truncate">' + esc(x.label) + (x.note ? ' <span class="small ' + (x.noteTone || 'muted') + '">' + x.note + '</span>' : '') + '</div><div class="bl-v">' + x.value + '</div>' + ui.bar(x.frac, { tick: x.tick, tone: x.tone }) + '</div>').join('') + '</div>';

  ui.warnRow = (text, actionHtml, neg) => '<div class="warnrow' + (neg ? ' neg' : '') + '">' + ui.icon('alert') + '<div class="grow">' + text + '</div>' + (actionHtml || '') + '</div>';
  ui.empty = (title, body, btnHtml, icon) => '<div class="empty"><div class="empty-ill">' + ui.icon(icon || 'note') + '</div><div class="empty-t">' + esc(title) + '</div><div class="empty-b">' + esc(body || '') + '</div>' + (btnHtml || '') + '</div>';
  ui.fold = (summary, body, open) => '<details class="fold"' + (open ? ' open' : '') + '><summary>' + summary + '</summary>' + body + '</details>';
  ui.readout = (pairs) => '<div class="readout">' + pairs.map((p) => '<span>' + (p[2] ? '<i class="sw" style="background:' + p[2] + '"></i>' : '') + esc(p[0]) + (p[1] != null ? '<b>' + p[1] + '</b>' : '') + '</span>').join('') + '</div>';

  /* form fields, for drawers */
  ui.field = (label, control, hint, info) => '<div class="field"><label>' + esc(label) + (info ? ui.info(info) : '') + '</label>' + control + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  ui.input = (name, value, o) => {
    o = o || {};
    return '<input class="inp" name="' + name + '" type="' + (o.type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + (o.input ? ' data-input="' + o.input + '"' : '') + '>';
  };
  ui.fieldRow = (a, b) => '<div class="field-row">' + a + b + '</div>';

  /* ---------- drawer ---------- */
  const drawer = (RK.drawer = { dirty: false, cfg: null });
  /* open({kicker, title, body, footer, wide, tabs:[[id,label]], tab}) — footer is HTML; use ui.drawerFooter */
  drawer.open = (cfg) => {
    drawer.cfg = cfg; drawer.dirty = false;
    document.getElementById('drawer-root').innerHTML =
      '<div class="scrim" data-action="drawer-close"></div><aside class="drawer' + (cfg.wide ? ' wide' : '') + '" role="dialog" aria-label="' + esc(cfg.title) + '">' +
      '<div class="dr-h"><div class="grow"><div class="dr-k">' + esc(cfg.kicker || '') + '<span id="dr-unsaved"></span></div><div class="dr-t">' + esc(cfg.title) + '</div></div><button class="btn icon" data-action="drawer-close" aria-label="Close">' + ui.icon('x') + '</button></div>' +
      (cfg.tabs ? '<div class="dr-tabs">' + cfg.tabs.map((t) => '<button class="' + (t[0] === cfg.tab ? 'on' : '') + '" data-action="drawer-tab" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>').join('') + '</div>' : '') +
      '<form class="dr-b" id="dr-form" onsubmit="return false">' + cfg.body + '</form>' +
      (cfg.footer ? '<div class="dr-f" id="dr-foot">' + cfg.footer + '</div>' : '') + '</aside>';
    RK.charts && RK.charts.flush();
  };
  drawer.close = () => { document.getElementById('drawer-root').innerHTML = ''; drawer.cfg = null; drawer.dirty = false; };
  drawer.values = () => { const out = {}; const f = document.getElementById('dr-form'); if (f) new FormData(f).forEach((v, k) => (out[k] = v)); return out; };
  /* drawerFooter({del:'action', delData, save:'action', saveLabel, saveData}) — Delete left; Cancel then primary right (P14) */
  ui.drawerFooter = (o) => (o.del ? '<span id="dr-del">' + ui.btn('Delete', 'ask-delete', { kind: 'danger', data: Object.assign({ next: o.del }, o.delData || {}) }) + '</span>' : '') + '<span class="grow"></span>' + ui.btn('Cancel', 'drawer-close') + (o.save ? ui.btn(o.saveLabel || 'Save', o.save, { kind: 'primary', data: o.saveData }) : '');

  RK.actions['drawer-close'] = () => {
    if (drawer.dirty) {
      const f = document.getElementById('dr-foot');
      if (f && !f.dataset.asked) { f.dataset.asked = '1'; f.dataset.prev = f.innerHTML; f.innerHTML = '<span class="grow">Discard changes?</span>' + ui.btn('Keep editing', 'drawer-keep') + ui.btn('Discard', 'drawer-discard', { kind: 'danger' }); return; }
    }
    drawer.close();
  };
  RK.actions['drawer-keep'] = () => { const f = document.getElementById('dr-foot'); f.innerHTML = f.dataset.prev; delete f.dataset.asked; };
  RK.actions['drawer-discard'] = () => drawer.close();
  /* One delete confirmation everywhere (P15): the button becomes "Delete? Delete / Keep" in place. */
  RK.actions['ask-delete'] = (el) => {
    const host = el.parentElement, prev = host.innerHTML;
    const d = Object.assign({}, el.dataset); const next = d.next; delete d.action; delete d.next;
    host.innerHTML = '<span class="row"><span class="small">Delete?</span>' + ui.btn('Delete', next, { kind: 'danger', sm: true, data: d }) + ui.btn('Keep', 'keep-delete', { sm: true }) + '</span>';
    host.dataset.prev = prev;
  };
  RK.actions['keep-delete'] = (el) => { const host = el.closest('[data-prev]'); host.innerHTML = host.dataset.prev; };

  /* A field that saves when it is left often loses focus to a click elsewhere. Redrawing at once
     would swallow that click, so such handlers redraw a moment later. */
  RK.renderSoon = () => setTimeout(() => RK.render(), 220);

  /* ---------- toast with Undo (P15) ---------- */
  let toastTimer;
  RK.toast = (text, undo) => {
    const root = document.getElementById('toast-root');
    RK._undo = undo || null;
    root.innerHTML = '<div class="toast" role="status">' + esc(text) + (undo ? '<button data-action="toast-undo">Undo</button>' : '') + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (root.innerHTML = ''), 6000);
  };
  RK.actions['toast-undo'] = () => { const u = RK._undo; document.getElementById('toast-root').innerHTML = ''; if (u) { u(); RK.render(); } };

  /* ---------- popover: (i) explanations and small menus ---------- */
  RK.pop = (anchor, html, menu) => {
    const root = document.getElementById('pop-root');
    root.innerHTML = '<div class="pop' + (menu ? ' menu' : '') + '" id="pop">' + html + '</div>';
    const p = document.getElementById('pop'), r = anchor.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - p.offsetWidth - 12);
    let top = r.bottom + 6;
    if (top + p.offsetHeight > window.innerHeight - 12) top = r.top - p.offsetHeight - 6;
    p.style.left = Math.max(12, left) + 'px'; p.style.top = top + 'px';
  };
  RK.popClose = () => (document.getElementById('pop-root').innerHTML = '');
  RK.actions.info = (el) => RK.pop(el, esc(el.dataset.text));
})();
