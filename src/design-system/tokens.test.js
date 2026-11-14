// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// The palette's own guard (the revamp, November 2026). The fresh review of
// the shell found two Planning charts drawn in a series colour at about 2:1
// against the page; chart marks need 3:1 and text 4.5:1. Read from the token
// file itself, in both themes.
const css = readFileSync(resolvePath(process.cwd(), 'src/design-system/tokens.css'), 'utf8');

function block(selector) {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const vars = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const dark = block(':root {');
const light = { ...dark, ...block(":root[data-theme='light']") };

function resolve(vars, name, seen = 0) {
  const v = vars[name];
  const ref = /^var\(--([\w-]+)\)$/.exec(v ?? '');
  if (ref && seen < 10) return resolve(vars, ref[1], seen + 1);
  return v;
}

function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe.each([
  ['dark', dark],
  ['light', light],
])('tokens: %s theme', (_, vars) => {
  const grounds = ['ground', 'surface'].map((g) => resolve(vars, g));

  it.each(['series-1', 'series-2', 'series-3', 'accent', 'pos', 'neg', 'warn'])('%s stands out from the page as a chart mark', (name) => {
    for (const g of grounds) expect(contrast(resolve(vars, name), g)).toBeGreaterThanOrEqual(3);
  });

  it.each(['ink', 'ink2', 'ink3'])('%s reads as text on every surface', (name) => {
    for (const g of [...grounds, resolve(vars, 'raised'), resolve(vars, 'active')]) expect(contrast(resolve(vars, name), g)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps three chart series that are not the same colour', () => {
    const s = ['series-1', 'series-2', 'series-3'].map((n) => resolve(vars, n));
    expect(new Set(s).size).toBe(3);
  });
});
