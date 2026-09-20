import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// supabase/functions/_shared/applib/* are described in their own headers as
// "synced copy of src/lib/...". Nothing enforced that. The app and the
// Telegram bot therefore share the code that decides money -- accountValueAed,
// netWorthSummary, portfolioValueChange, cashCoverStatus -- with no check that
// the two copies still agree. Drift would fail nothing: the app would say one
// number and the bot another, both confidently.
//
// The copies are deliberately TRIMMED -- the bot's version omits what it does
// not need -- so a byte diff is the wrong instrument. This compares the
// declarations present in BOTH, by parsing them.
//
// It used to compare them with a hand-written tokeniser, and an independent
// review took that apart. Three functions had only their DESTRUCTURED
// PARAMETERS compared, never their bodies, because the extractor took the
// first `{` after the name -- and they counted as successful comparisons, so
// every guard rail this file has still passed. Regex literals after `)`,
// nested templates, default arguments and whitespace inside string literals
// were all wrong too. That approach is gone rather than patched a third time:
// deciding where a JavaScript declaration ends is a parser's job.

const APPLIB = 'supabase/functions/_shared/applib';

// Where each mirrored file's original lives. Most are src/lib; overviewMath is
// a screen helper.
function sourceCounterpart(name) {
  for (const candidate of [join('src/lib', name), join('src/screens', name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseModule(code, file) {
  try {
    return parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch (cause) {
    throw new Error(`could not parse ${file}: ${cause.message}`);
  }
}

// Everything that distinguishes two ASTs *as programs*, with everything that
// does not -- source positions, comments, parser bookkeeping -- removed. Note
// what is NOT stripped: string and template values, numeric literals, default
// arguments and parameter names all survive, because each of them can change
// what the code computes.
const IGNORED_KEYS = new Set([
  'start', 'end', 'loc', 'range', 'leadingComments', 'trailingComments',
  'innerComments', 'comments', 'extra', 'errors', 'tokens', 'directives',
]);

function shape(node) {
  if (Array.isArray(node)) return node.map(shape);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (IGNORED_KEYS.has(key)) continue;
    out[key] = shape(node[key]);
  }
  return out;
}

const fingerprint = (node) => JSON.stringify(shape(node));

// Top-level bindings by name, whatever form they take: function declarations,
// `const x = ...` (including arrow functions), classes. An arrow-function
// export was previously invisible to the collector entirely.
function declarations(ast) {
  const found = new Map();
  const add = (name, node, exported) => {
    if (name && !found.has(name)) found.set(name, { node, exported });
  };

  for (const stmt of ast.program.body) {
    const isExport = stmt.type === 'ExportNamedDeclaration';
    const decl = isExport ? stmt.declaration : stmt;
    if (!decl) continue;
    if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
      add(decl.id?.name, decl, isExport);
    } else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier') add(d.id.name, d, isExport);
      }
    }
  }
  return found;
}

// Two differences in an import path are deliberate and must not read as
// drift: Deno requires the `.js` extension where Vite omits it, and applib is
// flat where src/lib and src/screens are not ('./overviewMath.js' against
// '../screens/overviewMath'). Comparing the module's basename keeps both
// while still catching an import that points somewhere genuinely different.
function moduleKey(source) {
  if (!source.startsWith('.')) return source;
  return source.replace(/\.js$/, '').split('/').pop();
}

// What each module pulls in. A mirror that imports a different helper computes
// something different however identical its own body looks.
function importMap(ast) {
  const out = new Map();
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    for (const spec of stmt.specifiers) {
      const imported = spec.imported?.name ?? spec.local.name;
      out.set(spec.local.name, `${imported} from ${moduleKey(stmt.source.value)}`);
    }
  }
  return out;
}

const mirrors = readdirSync(APPLIB)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map((file) => ({ file, src: sourceCounterpart(file) }));

// Mirror declarations with no counterpart in src, and therefore nothing to
// compare against. lastDueOccurrence is genuinely bot-only: the webhook rolls
// a stored anchor forward to find the last occurrence on or before today,
// which no screen needs. Anything else appearing here is drift, not a choice.
const KNOWN_BOT_ONLY = ['recurring.js:lastDueOccurrence'];

const comparisons = [];
const importComparisons = [];
const unaccounted = [];

for (const { file, src } of mirrors) {
  if (!src) continue;
  const mirrorAst = parseModule(readFileSync(join(APPLIB, file), 'utf8'), join(APPLIB, file));
  const srcAst = parseModule(readFileSync(src, 'utf8'), src);

  const mirrorDecls = declarations(mirrorAst);
  const srcDecls = declarations(srcAst);

  for (const [name, mine] of mirrorDecls) {
    const theirs = srcDecls.get(name);
    if (!theirs) {
      unaccounted.push(`${file}:${name}`);
      continue;
    }
    comparisons.push({
      file,
      src,
      name,
      exported: mine.exported,
      agree: fingerprint(mine.node) === fingerprint(theirs.node),
    });
  }

  const mirrorImports = importMap(mirrorAst);
  const srcImports = importMap(srcAst);
  for (const [local, spec] of mirrorImports) {
    if (!srcImports.has(local)) continue;
    importComparisons.push({ file, local, agree: srcImports.get(local) === spec });
  }
}

describe('the applib mirrors agree with the code they were copied from', () => {
  it('finds mirrors to check at all, so an empty run cannot pass silently', () => {
    expect(mirrors.length).toBeGreaterThan(5);
  });

  it('compares whole declarations, exported and private alike', () => {
    // 66 shared declarations across 12 mirrored files when this was written:
    // 53 exported and 13 private. An independent audit of the same files,
    // using its own Babel pass, counted 51 exported and 12 private before
    // cashCover.js gained unvaluedDueBills, formatCashCoverLine and
    // billsDueWithin -- which is exactly this, and a useful cross-check that
    // the collector is not quietly missing a category.
    //
    // The floors sit just under the real numbers: low enough that trimming a
    // helper from a mirror does not trip them, high enough that a collector
    // covering less than it used to does.
    expect(comparisons.length).toBeGreaterThanOrEqual(62);
    expect(comparisons.filter((c) => c.exported).length).toBeGreaterThanOrEqual(50);
    // Private helpers were outside the old comparison entirely. billsDueWithin
    // in cashCover.js is one: not exported, and it decides what counts as due.
    expect(comparisons.some((c) => !c.exported)).toBe(true);
  });

  it('leaves no mirror declaration silently uncompared', () => {
    // Either add it to src (it is drift) or list it as bot-only with a
    // reason. Widening the list without one is how the check goes quiet.
    expect(unaccounted).toEqual(KNOWN_BOT_ONLY);
  });

  it('checks that both copies import the same things', () => {
    expect(importComparisons.length).toBeGreaterThanOrEqual(24);
    expect(importComparisons.filter((c) => !c.agree)).toEqual([]);
  });

  for (const { file, src } of mirrors) {
    // telegramConfirm/telegramChat/telegramLink are bot-only and have no
    // counterpart by design; their own headers say so.
    if (!src) continue;

    it(`${file} matches ${src}`, () => {
      const mine = comparisons.filter((c) => c.file === file);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.filter((c) => !c.agree).map((c) => c.name)).toEqual([]);
    });
  }
});

// A parity check is only worth its green tick if it would go red. Each case
// below is one the previous hand-written extractor got wrong, run against
// synthetic pairs so the assertions do not depend on today's real files.
describe('the comparison would actually catch drift', () => {
  const compare = (a, b) => {
    const da = declarations(parseModule(a, 'a.js')).get('f');
    const db = declarations(parseModule(b, 'b.js')).get('f');
    return fingerprint(da.node) === fingerprint(db.node);
  };

  it('catches a changed body behind a destructured parameter', () => {
    // The old extractor compared `{ days = 7 }` -- the parameter object --
    // and never reached the body, for cashCoverStatus, unvaluedNote and
    // notableMoves. All three reported agreement whatever their bodies did.
    expect(compare(
      'export function f(a, { days = 7 } = {}) { return a * days; }',
      'export function f(a, { days = 7 } = {}) { return a + days; }',
    )).toBe(false);
  });

  it('catches a changed default argument', () => {
    expect(compare(
      'export function f(a, { days = 7 } = {}) { return a * days; }',
      'export function f(a, { days = 30 } = {}) { return a * days; }',
    )).toBe(false);
  });

  it('catches a body change after a regex literal containing a brace', () => {
    expect(compare(
      "export function f(s) { if (s) return s.replace(/[}]/g, ''); return 1; }",
      "export function f(s) { if (s) return s.replace(/[}]/g, ''); return 2; }",
    )).toBe(false);
  });

  it('catches a body change after a nested template literal', () => {
    expect(compare(
      'export function f(x) { return `a${`}`}` + 1; }',
      'export function f(x) { return `a${`}`}` + 2; }',
    )).toBe(false);
  });

  it('catches whitespace that is inside a string literal', () => {
    // The old normaliser collapsed all whitespace, including inside literals,
    // so 'a  b' and 'a b' compared equal.
    expect(compare("export function f() { return 'a  b'; }", "export function f() { return 'a b'; }")).toBe(false);
  });

  it('catches a changed numeric literal', () => {
    expect(compare('export function f() { return 0.85; }', 'export function f() { return 0.9; }')).toBe(false);
  });

  it('catches drift in an arrow-function export', () => {
    expect(compare('export const f = (x) => x * 2;', 'export const f = (x) => x * 3;')).toBe(false);
  });

  it('ignores comments and formatting, which are not behaviour', () => {
    expect(compare(
      'export function f(x) {\n  // one\n  return x + 1;\n}',
      'export function f(x) { /* two */ return x + 1; }',
    )).toBe(true);
  });
});
