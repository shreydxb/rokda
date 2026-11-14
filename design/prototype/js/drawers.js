/* The transaction editor, used from Overview, Activity, Recurring and Month end,
   plus two small shared controls. Other editors live with their screens. */
(function () {
  const RK = window.RK;
  const { fmt, q, ui } = RK;
  const D = RK.data, A = RK.actions;

  /* A segmented choice inside a form: keeps its value in a hidden input, no re-render. */
  ui.segField = (name, opts, cur) => '<div class="seg full" data-segfield><input type="hidden" name="' + name + '" value="' + fmt.esc(cur) + '">' + opts.map((o) => '<button type="button" class="' + (o[0] === cur ? 'on' : '') + '" data-action="seg-pick" data-value="' + fmt.esc(o[0]) + '">' + fmt.esc(o[1]) + '</button>').join('') + '</div>';
  A['seg-pick'] = (el) => {
    const host = el.closest('[data-segfield]');
    host.querySelector('input').value = el.dataset.value;
    host.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    host.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
  };
  A['toggle-switch'] = (el) => { el.classList.toggle('on'); const i = el.parentElement.querySelector('input[type=hidden]'); if (i) i.value = el.classList.contains('on') ? '1' : ''; el.dispatchEvent(new Event('input', { bubbles: true })); };
  ui.switchField = (name, on, label, hint) => '<div class="row between"><div><div style="font-size:13px;font-weight:500">' + fmt.esc(label) + '</div>' + (hint ? '<div class="small muted">' + fmt.esc(hint) + '</div>' : '') + '</div><span><input type="hidden" name="' + name + '" value="' + (on ? '1' : '') + '">' + ui.sw(on, 'toggle-switch') + '</span></div>';

  const TYPE_HELP = 'Expense: money spent. Income: money in. Refund: money back for an earlier purchase; it nets against spending. Transfer: money moved between your own accounts; it counts as neither.';

  /* open-txn — data-id edits a transaction; without one it starts a new entry. data-bill pre-fills from a bill. */
  A['open-txn'] = (el) => {
    const t = el && el.dataset.id ? D.transactions.find((x) => x.id === el.dataset.id) : null;
    const bill = el && el.dataset.bill ? D.recurring.find((r) => r.id === el.dataset.bill) : null;
    const v = t || (bill ? { merchant: bill.name, amount: bill.kind === 'income' ? bill.amount : -bill.amount, cat: bill.cat, account: bill.account, owner: bill.owner, date: D.today } : { merchant: '', amount: '', cat: '', account: 'sky', owner: 'shared', date: D.today });
    const kind = t ? q.kind(t) : bill && bill.kind === 'income' ? 'income' : 'expense';
    const other = t && t.dup ? D.transactions.find((x) => x.dup === t.dup && x.id !== t.id) : null;
    RK.drawer.open({
      kicker: t ? 'Edit transaction' : 'New transaction', title: t ? t.merchant : bill ? bill.name : 'Add a transaction',
      body:
        (other ? ui.warnRow('A transaction like this exists on ' + fmt.date(other.date) + '.', ui.btn('Both are real', 'txn-both-real', { sm: true, data: { id: t.id } })) : '') +
        (t && t.review ? ui.warnRow('Flagged for review.', '') : '') +
        ui.field('Type', ui.segField('kind', [['expense', 'Expense'], ['income', 'Income'], ['refund', 'Refund'], ['transfer', 'Transfer']], kind), null, TYPE_HELP) +
        '<div class="field"><label>Amount</label><div class="amount"><span>AED</span><input name="amount" inputmode="decimal" value="' + (v.amount === '' ? '' : Math.abs(v.amount)) + '" placeholder="0"></div>' + (v.native ? '<div class="hint">' + fmt.native(v.native[0], v.native[1]) + ' paid · AED as debited</div>' : '') + '</div>' +
        ui.field('Merchant', ui.input('merchant', v.merchant, { placeholder: 'Who was paid' })) +
        ui.fieldRow(ui.field('Date', ui.input('date', v.date, { type: 'date' })), ui.field('Account', ui.select(null, ui.accOptions(), v.account, { name: 'account' }))) +
        ui.fieldRow(ui.field('Category', ui.select(null, ui.catOptions('Uncategorised'), v.cat || '', { name: 'cat' })), ui.field('Owner', ui.select(null, ui.ownerOptions(), v.owner, { name: 'owner' }))) +
        ui.fold('More', '<div class="stack-v" style="padding:4px 0 0;gap:14px">' +
          ui.field('Note', '<textarea class="inp" name="note" rows="2" placeholder="Optional">' + fmt.esc(v.note || '') + '</textarea>') +
          ui.switchField('review', !!v.review, 'Needs review', 'Flags it for the other person') +
          ui.switchField('remember', false, 'Remember this merchant', 'Future entries go to this category') +
          (t ? '<div class="dr-sec">History</div><div class="small muted">' + fmt.date(t.date) + ' · recorded by ' + (t.owner === 'shared' ? 'Maya' : q.ownerName(t.owner)) + '</div>' : '') + '</div>'),
      footer: ui.drawerFooter({ del: t ? 'txn-delete' : null, delData: t ? { id: t.id } : null, save: 'txn-save', saveLabel: t ? 'Save' : 'Add transaction', saveData: { id: t ? t.id : '', bill: bill ? bill.id : '' } }),
    });
  };
  A['txn-save'] = (el) => {
    const f = RK.drawer.values();
    const amt = Math.abs(Number(f.amount));
    if (!amt) { RK.toast('Enter an amount above zero'); return; }
    let t = el.dataset.id ? D.transactions.find((x) => x.id === el.dataset.id) : null;
    const isNew = !t;
    if (!t) { t = { id: 't' + Date.now() }; D.transactions.unshift(t); }
    Object.assign(t, { merchant: f.merchant || 'Unknown', date: f.date, account: f.account, cat: f.cat || null, owner: f.owner, note: f.note, review: !!f.review, refund: f.kind === 'refund', amount: f.kind === 'expense' || f.kind === 'transfer' ? -amt : amt });
    if (f.kind === 'transfer' && !t.transfer) t.transfer = { to: 'sav' };
    if (f.kind !== 'transfer') delete t.transfer;
    if (el.dataset.bill) { const b = D.recurring.find((r) => r.id === el.dataset.bill); if (b) b.status = 'posted'; }
    RK.drawer.close();
    RK.toast(isNew ? 'Added ' + t.merchant : 'Saved ' + t.merchant);
    RK.render();
  };
  A['txn-delete'] = (el) => {
    const i = D.transactions.findIndex((x) => x.id === el.dataset.id); if (i < 0) return;
    const [gone] = D.transactions.splice(i, 1);
    RK.drawer.close();
    RK.toast('Deleted ' + gone.merchant, () => D.transactions.splice(i, 0, gone));
    RK.render();
  };
  A['txn-both-real'] = (el) => {
    const t = D.transactions.find((x) => x.id === el.dataset.id);
    D.transactions.filter((x) => x.dup === t.dup).forEach((x) => delete x.dup);
    RK.drawer.close(); RK.toast('Kept both'); RK.render();
  };

  /* Inline categorise (Overview To do, Activity): a select with data-input="set-cat" data-id="t12". */
  RK.inputs['set-cat'] = (el) => {
    const t = D.transactions.find((x) => x.id === el.dataset.id); if (!t || !el.value) return;
    const prev = { cat: t.cat, review: t.review };
    t.cat = el.value; t.review = false;
    RK.toast('Categorised ' + t.merchant + ' as ' + q.catName(t.cat), () => Object.assign(t, prev));
    RK.render();
  };
  ui.catSelect = (t) => ui.select('set-cat', ui.catOptions('Category…'), '', { sm: true, data: { id: t.id } });
})();
