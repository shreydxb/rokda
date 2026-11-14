/* Chart kit (P21). Every chart is plain SVG, drawn to the width of its slot.
   Usage in a screen:  RK.charts.slot('key', heightPx, (w, h) => RK.charts.line(w, h, {...}))
   The slot is filled after the screen renders, and again when the window resizes.
   Hover values come from data-tip attributes (see the tooltip handler in app.js). */
(function () {
  const RK = window.RK;
  const { fmt } = RK;
  const esc = fmt.esc;
  const C = (RK.charts = {});
  const reg = {};

  C.slot = (key, height, draw) => { reg[key] = draw; return '<div class="chart" data-chart="' + key + '" style="height:' + height + 'px"></div>'; };
  C.flush = () => document.querySelectorAll('[data-chart]').forEach((el) => {
    const draw = reg[el.dataset.chart]; if (!draw) return;
    const w = Math.floor(el.clientWidth), h = Math.floor(el.clientHeight);
    if (w > 40) el.innerHTML = draw(w, h);
  });

  const M = { l: 40, r: 8, t: 10, b: 22 };
  const nice = (max) => { if (max <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(max))); const n = max / p; return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => n <= s) * p; };
  const svg = (w, h, inner) => '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img">' + inner + '</svg>';
  /* three gridlines with labels: 0, half, top */
  const grid = (w, h, top, yFmt, min) => {
    min = min || 0;
    let s = '';
    [0, 0.5, 1].forEach((f) => {
      const y = h - M.b - f * (h - M.t - M.b);
      s += '<line class="' + (f === 0 ? 'base-l' : 'grid-l') + '" x1="' + M.l + '" x2="' + (w - M.r) + '" y1="' + y + '" y2="' + y + '"/>';
      s += '<text x="' + (M.l - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + (yFmt || fmt.compact)(min + f * (top - min)) + '</text>';
    });
    return s;
  };
  const xLabel = (x, h, text, anchor, strong) => '<text x="' + x + '" y="' + (h - 6) + '" text-anchor="' + (anchor || 'middle') + '"' + (strong ? ' style="fill:var(--ink);font-weight:500"' : '') + '>' + esc(text) + '</text>';

  /* line(w,h,{values, labels:{index:text}, area, color, min, tips:[text], hollow:[index], yFmt, compare:[values]}) */
  C.line = (w, h, o) => {
    const v = o.values, n = v.length;
    const lo = o.min != null ? o.min : 0;
    const top = lo + nice(Math.max.apply(null, v.concat(o.compare || [])) - lo);
    const X = (i) => M.l + (n === 1 ? 0.5 : i / (n - 1)) * (w - M.l - M.r);
    const Y = (val) => h - M.b - ((val - lo) / (top - lo)) * (h - M.t - M.b);
    const path = (arr) => arr.map((val, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(val).toFixed(1)).join(' ');
    const color = o.color || 'var(--accent)';
    let s = grid(w, h, top, o.yFmt, lo);
    if (o.compare) s += '<path d="' + path(o.compare) + '" fill="none" stroke="var(--context)" stroke-width="1.5"/>';
    if (o.area !== false) s += '<path d="' + path(v) + ' L' + X(n - 1) + ' ' + (h - M.b) + ' L' + X(0) + ' ' + (h - M.b) + ' Z" fill="' + color + '" opacity="0.08"/>';
    s += '<path d="' + path(v) + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"/>';
    (o.hollow || []).forEach((i) => (s += '<circle cx="' + X(i) + '" cy="' + Y(v[i]) + '" r="3.5" fill="var(--surface)" stroke="' + color + '" stroke-width="1.5"/>'));
    s += '<circle cx="' + X(n - 1) + '" cy="' + Y(v[n - 1]) + '" r="3.5" fill="' + color + '"/>';
    Object.keys(o.labels || {}).forEach((i) => (s += xLabel(X(+i), h, o.labels[i], +i === 0 ? 'start' : +i === n - 1 ? 'end' : 'middle', +i === n - 1)));
    if (o.tips) { const bw = (w - M.l - M.r) / Math.max(1, n - 1); v.forEach((val, i) => (s += '<rect x="' + (X(i) - bw / 2) + '" y="' + M.t + '" width="' + bw + '" height="' + (h - M.t - M.b) + '" fill="transparent" data-tip="' + esc(o.tips[i]) + '"/>')); }
    return svg(w, h, s);
  };

  /* spark(w,h,values) — a bare trend line for a hero panel: no axis, last point marked */
  C.spark = (w, h, values, tips) => {
    const lo = Math.min.apply(null, values), hi = Math.max.apply(null, values), n = values.length;
    const X = (i) => 4 + (i / (n - 1)) * (w - 8), Y = (v) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 14);
    const d = values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
    let s = '<path d="' + d + ' L' + X(n - 1) + ' ' + h + ' L' + X(0) + ' ' + h + ' Z" fill="var(--accent)" opacity="0.07"/><path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/><circle cx="' + X(n - 1) + '" cy="' + Y(values[n - 1]) + '" r="3.5" fill="var(--accent)"/>';
    if (tips) { const bw = (w - 8) / (n - 1); values.forEach((v, i) => (s += '<rect x="' + (X(i) - bw / 2) + '" y="0" width="' + bw + '" height="' + h + '" fill="transparent" data-tip="' + esc(tips[i]) + '"/>')); }
    return svg(w, h, s);
  };

  /* columns(w,h,{groups:[{label, a, b, line, empty, current, tip}]}) — paired columns (a = context, b = accent) with a line over them */
  C.columns = (w, h, o) => {
    const g = o.groups, n = g.length;
    const top = nice(Math.max.apply(null, g.map((x) => Math.max(x.a || 0, x.b || 0, x.line || 0))));
    const slot = (w - M.l - M.r) / n, bw = Math.min(26, slot * 0.26);
    const Y = (v) => h - M.b - (v / top) * (h - M.t - M.b);
    let s = grid(w, h, top, o.yFmt), pts = [];
    g.forEach((x, i) => {
      const cx = M.l + slot * (i + 0.5);
      if (x.empty) s += '<line x1="' + (cx - 10) + '" x2="' + (cx + 10) + '" y1="' + (h - M.b - 6) + '" y2="' + (h - M.b - 6) + '" stroke="var(--control)" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 5"/>';
      else {
        s += '<rect x="' + (cx - bw - 2) + '" y="' + Y(x.a) + '" width="' + bw + '" height="' + (h - M.b - Y(x.a)) + '" rx="2" fill="var(--context)"/>';
        s += '<rect x="' + (cx + 2) + '" y="' + Y(x.b) + '" width="' + bw + '" height="' + (h - M.b - Y(x.b)) + '" rx="2" fill="var(--accent)"' + (x.current ? ' opacity="0.55"' : '') + '/>';
        if (x.line != null) pts.push([cx, Y(Math.max(0, x.line))]);
      }
      s += xLabel(cx, h, x.label, 'middle', x.current);
      s += '<rect x="' + (cx - slot / 2) + '" y="' + M.t + '" width="' + slot + '" height="' + (h - M.t - M.b) + '" fill="transparent" data-tip="' + esc(x.tip || x.label) + '"/>';
    });
    if (pts.length > 1) s += '<path d="' + pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ') + '" fill="none" stroke="var(--pos)" stroke-width="2"/>';
    pts.forEach((p) => (s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="var(--surface)" stroke="var(--pos)" stroke-width="1.5" style="pointer-events:none"/>'));
    return svg(w, h, s);
  };

  /* bars(w,h,{items:[{label, value, kind:'solid'|'pale'|'outline', tip, strong}], todayAfter:index, yFmt}) */
  C.bars = (w, h, o) => {
    const it = o.items, n = it.length;
    const top = nice(Math.max.apply(null, it.map((x) => x.value)));
    const slot = (w - M.l - M.r) / n, bw = Math.max(4, Math.min(22, slot * 0.6));
    const Y = (v) => h - M.b - (v / top) * (h - M.t - M.b);
    let s = grid(w, h, top, o.yFmt);
    it.forEach((x, i) => {
      const cx = M.l + slot * (i + 0.5), y = Y(x.value), hh = h - M.b - y;
      if (x.value > 0) {
        if (x.kind === 'outline') s += '<rect x="' + (cx - bw / 2 + 0.75) + '" y="' + (y + 0.75) + '" width="' + (bw - 1.5) + '" height="' + Math.max(0, hh - 0.75) + '" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 2"/>';
        else s += '<rect x="' + (cx - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + hh + '" rx="2" fill="var(--accent)"' + (x.kind === 'pale' ? ' opacity="0.45"' : '') + '/>';
      }
      if (x.label) s += xLabel(cx, h, x.label, 'middle', x.strong);
      s += '<rect x="' + (cx - slot / 2) + '" y="' + M.t + '" width="' + slot + '" height="' + (h - M.t - M.b) + '" fill="transparent" data-tip="' + esc(x.tip || '') + '"/>';
    });
    if (o.todayAfter != null) { const x = M.l + slot * (o.todayAfter + 1); s += '<line x1="' + x + '" x2="' + x + '" y1="' + (M.t - 4) + '" y2="' + (h - M.b) + '" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 3"/><text x="' + (x + 5) + '" y="' + (M.t + 4) + '" style="fill:var(--ink)">today</text>'; }
    return svg(w, h, s);
  };

  /* plan(w,h,{years, pot, low, high, stopYear, runsOut, goals:[{year,name}]}) — the pot by year, with the scenario band */
  C.plan = (w, h, o) => {
    const n = o.years.length;
    const top = nice(Math.max.apply(null, o.high || o.pot));
    const slot = (w - M.l - M.r) / n, bw = Math.max(2, slot * 0.62);
    const X = (i) => M.l + slot * (i + 0.5), Y = (v) => h - M.b - (Math.max(0, v) / top) * (h - M.t - M.b);
    let s = grid(w, h, top, o.yFmt);
    if (o.low && o.high) {
      const up = o.high.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
      const dn = o.low.map((v, i) => 'L' + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).reverse().join(' ');
      s += '<path d="' + up + ' ' + dn + ' Z" fill="var(--context)" opacity="0.28"/>';
    }
    o.years.forEach((yr, i) => {
      const v = o.pot[i], after = yr >= o.stopYear;
      if (v > 0) s += '<rect x="' + (X(i) - bw / 2) + '" y="' + Y(v) + '" width="' + bw + '" height="' + (h - M.b - Y(v)) + '" rx="1" fill="var(--accent)"' + (after ? ' opacity="0.5"' : '') + '/>';
      if (i === 0 || (yr % 10 === 0 && i > 5)) s += xLabel(X(i), h, String(yr), i === 0 ? 'start' : 'middle');
      s += '<rect x="' + (X(i) - slot / 2) + '" y="' + M.t + '" width="' + slot + '" height="' + (h - M.t - M.b) + '" fill="transparent" data-tip="' + esc(yr + ' · pot ' + fmt.compact(v) + (o.low ? ' · range ' + fmt.compact(o.low[i]) + ' to ' + fmt.compact(o.high[i]) : '')) + '"/>';
    });
    const si = o.years.indexOf(o.stopYear);
    if (si >= 0) s += '<line x1="' + (X(si) - slot / 2) + '" x2="' + (X(si) - slot / 2) + '" y1="' + (M.t - 2) + '" y2="' + (h - M.b) + '" stroke="var(--ink)" stroke-width="1.25"/><text x="' + (X(si) - slot / 2 + 6) + '" y="' + (M.t + 6) + '" style="fill:var(--ink);font-weight:500">Stop ' + o.stopYear + '</text>';
    const ri = o.years.indexOf(o.runsOut);
    if (ri >= 0) s += '<circle cx="' + X(ri) + '" cy="' + (h - M.b) + '" r="4.5" fill="var(--neg)"/><text x="' + (X(ri) + 9) + '" y="' + (h - M.b - 8) + '" style="fill:var(--neg);font-weight:500">Runs out ' + o.runsOut + '</text>';
    (o.goals || []).forEach((g) => { const gi = o.years.indexOf(g.year); if (gi >= 0) s += '<path d="M' + X(gi) + ' ' + (Y(o.pot[gi]) - 12) + ' l4 6 l-4 6 l-4 -6 z" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.25" data-tip="' + esc(g.name + ' · ' + g.year) + '"/>'; });
    return svg(w, h, s);
  };

  /* timeline(w,h,{days, marks:[{day, amount, tone:'neg'|'pos'|'warn'|'', tip}]}) — a dated strip from today */
  C.timeline = (w, h, o) => {
    const pad = 10, y = 26, X = (d) => pad + (d / o.days) * (w - pad * 2);
    const big = Math.max.apply(null, o.marks.map((m) => Math.abs(m.amount)).concat([1]));
    let s = '<line x1="' + pad + '" x2="' + (w - pad) + '" y1="' + y + '" y2="' + y + '" stroke="var(--rule)" stroke-width="2" stroke-linecap="round"/>';
    for (let d = 0; d <= o.days; d += 7) s += '<line x1="' + X(d) + '" x2="' + X(d) + '" y1="' + (y - 4) + '" y2="' + (y + 4) + '" stroke="var(--control)"/><text x="' + X(d) + '" y="' + (h - 4) + '" text-anchor="' + (d === 0 ? 'start' : d >= o.days - 2 ? 'end' : 'middle') + '"' + (d === 0 ? ' style="fill:var(--ink);font-weight:500"' : '') + '>' + (d === 0 ? 'today' : '+' + d + 'd') + '</text>';
    o.marks.forEach((m) => {
      const r = 4 + Math.sqrt(Math.abs(m.amount) / big) * 8;
      const col = m.tone === 'pos' ? 'var(--pos)' : m.tone === 'neg' ? 'var(--neg)' : m.tone === 'warn' ? 'var(--warn-mark)' : 'var(--accent)';
      s += '<circle cx="' + X(Math.max(0, m.day)) + '" cy="' + y + '" r="' + r.toFixed(1) + '" fill="' + col + '" fill-opacity="0.18" stroke="' + col + '" stroke-width="1.5" data-tip="' + esc(m.tip) + '"/>';
    });
    return svg(w, h, s);
  };
})();
