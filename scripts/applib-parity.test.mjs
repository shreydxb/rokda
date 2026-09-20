import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// supabase/functions/_shared/applib/* are described in their own headers as
// "synced copy of src/lib/...". Nothing enforced that. The app and the
// Telegram bot therefore shared 41 function names across 11 files with no
// check that they still agreed, which is a silent-drift surface over exactly
// the code that decides money: accountValueAed, netWorthSummary,
// portfolioValueChange, cashCoverStatus.
//
// Drift here would not fail anything. The app would say one number and the
// bot another, both confidently, and the first sign would be someone noticing
// two answers to the same question.
//
// The copies are deliberately TRIMMED -- the bot's version omits functions it
// does not need -- so a byte diff is the wrong instrument. This compares the
// bodies of the functions present in BOTH, ignoring comments and whitespace,
// which is the same normalise-then-compare idea compare-migrations.mjs uses
// on SQL.

const APPLIB = 'supabase/functions/_shared/applib';

// Where each mirrored file's original lives. Most are src/lib; overviewMath is
// a screen helper.
function sourceCounterpart(name) {
  for (const candidate of [join('src/lib', name), join('src/screens', name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// A `/` in JavaScript is either division or the start of a regex literal, and
// nothing but context tells them apart. Getting this wrong is not a harmless
// parse error here: `s.replace(/[}]/g, '')` read as division leaves a bare `}`
// that closes the function body early, and BOTH copies truncate at the same
// point, so two different bodies compare equal and the check passes on drift
// it should have caught. The heuristic is the usual one -- a `/` that follows
// an operator, an opening bracket, or a keyword cannot be division, because
// there is no left-hand operand for it to divide.
const BEFORE_REGEX = /(?:[(,=:[!&|?{};+\-*%^~<>]|\breturn|\btypeof|\bcase|\bin|\bof|\bnew|\bdelete|\bvoid|\bdo|\belse)\s*$/;

function startsRegex(emitted) {
  return emitted.trim() === '' || BEFORE_REGEX.test(emitted);
}

// Advance past one string, template or regex literal starting at `code[i]`,
// returning [text, nextIndex]. Shared by the normaliser and the brace matcher
// so they can never disagree about where a literal ends.
function readLiteral(code, i, emitted) {
  const ch = code[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    let out = ch;
    i += 1;
    while (i < code.length) {
      if (code[i] === '\\') {
        out += code.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += code[i];
      i += 1;
      if (code[i - 1] === ch) break;
    }
    return [out, i];
  }
  if (ch === '/' && startsRegex(emitted)) {
    let out = '/';
    let inClass = false;
    i += 1;
    while (i < code.length) {
      const c = code[i];
      if (c === '\\') {
        out += code.slice(i, i + 2);
        i += 2;
        continue;
      }
      // An unescaped `\n` means this was division after all, not a regex --
      // regex literals cannot span lines. Bail rather than swallow the file.
      if (c === '\n') return null;
      out += c;
      i += 1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    // Trailing flags (g, i, u, ...) belong to the literal.
    while (i < code.length && /[a-z]/.test(code[i])) {
      out += code[i];
      i += 1;
    }
    return [out, i];
  }
  return null;
}

// Strip comments and collapse whitespace, without touching string, template or
// regex contents -- the same reason compare-migrations.mjs tokenises rather
// than running a regex over everything.
export function normaliseSource(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? code.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      out += ' ';
      continue;
    }
    const literal = readLiteral(code, i, out);
    if (literal) {
      out += literal[0];
      i = literal[1];
      continue;
    }
    out += code[i];
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// The full text of `export function NAME(...) { ... }`, brace-matched.
export function functionSource(code, name) {
  const header = new RegExp(`export\\s+function\\s+${name}\\s*\\(`);
  const start = code.search(header);
  if (start === -1) return null;
  const open = code.indexOf('{', start);
  if (open === -1) return null;
  const normalised = normaliseSource(code.slice(open));
  let depth = 0;
  let i = 0;
  while (i < normalised.length) {
    // Skip literal contents so a brace inside one cannot close the body.
    const literal = readLiteral(normalised, i, normalised.slice(0, i));
    if (literal) {
      i = literal[1];
      continue;
    }
    const ch = normalised[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return normalised.slice(0, i + 1);
    }
    i += 1;
  }
  return null;
}

// `export const NAME = <value>;` -- a shared constant is drift-prone in exactly
// the same way a function body is. HOUSEHOLD_TIME_ZONE decides what "today"
// means for both the app and the bot; if the two copies ever disagreed, every
// date boundary would land differently on each side.
export function constantSource(code, name) {
  const header = new RegExp(`export\\s+const\\s+${name}\\s*=`);
  const start = code.search(header);
  if (start === -1) return null;
  const normalised = normaliseSource(code.slice(start));
  let depth = 0;
  let i = 0;
  while (i < normalised.length) {
    const literal = readLiteral(normalised, i, normalised.slice(0, i));
    if (literal) {
      i = literal[1];
      continue;
    }
    const ch = normalised[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) return normalised.slice(0, i + 1);
    i += 1;
  }
  return null;
}

function exportedFunctions(code) {
  return [...code.matchAll(/export\s+function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
}

function exportedConstants(code) {
  return [...code.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]);
}

// Every name a mirrored file exports, whatever form the export takes.
function allExportedNames(code) {
  return [...code.matchAll(/export\s+(?:function|const|class|let|var)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

const mirrors = readdirSync(APPLIB)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map((file) => ({ file, src: sourceCounterpart(file) }));

// Collected once so the suite can assert on its own coverage. A parity check
// that quietly stops comparing anything still passes.
const comparisons = [];

// Mirror exports with no counterpart in src, and therefore nothing to compare
// against. lastDueOccurrence is genuinely bot-only: the webhook rolls a stored
// anchor forward to find the last occurrence on or before today, which no
// screen needs. Anything else appearing here is drift, not a design choice.
const KNOWN_BOT_ONLY = ['recurring.js:lastDueOccurrence'];
const unaccounted = [];
for (const { file, src } of mirrors) {
  if (!src) continue;
  const mirrorCode = readFileSync(join(APPLIB, file), 'utf8');
  const srcCode = readFileSync(src, 'utf8');

  const srcFns = exportedFunctions(srcCode);
  for (const name of exportedFunctions(mirrorCode).filter((n) => srcFns.includes(n))) {
    comparisons.push({
      file,
      src,
      name,
      mirror: functionSource(mirrorCode, name),
      source: functionSource(srcCode, name),
    });
  }

  const srcConsts = exportedConstants(srcCode);
  for (const name of exportedConstants(mirrorCode).filter((n) => srcConsts.includes(n))) {
    comparisons.push({
      file,
      src,
      name,
      mirror: constantSource(mirrorCode, name),
      source: constantSource(srcCode, name),
    });
  }

  // A name the mirror exports but the source does not is never compared --
  // there is nothing to compare it against. That silence is the hole this
  // file exists to close, so each one has to be a deliberate, listed choice
  // rather than something that slid past.
  const srcNames = allExportedNames(srcCode);
  for (const name of allExportedNames(mirrorCode)) {
    if (!srcNames.includes(name)) unaccounted.push(`${file}:${name}`);
  }
}

describe('the applib mirrors agree with the code they were copied from', () => {
  it('finds mirrors to check at all, so an empty run cannot pass silently', () => {
    expect(mirrors.length).toBeGreaterThan(5);
  });

  it('actually compares the function bodies it claims to', () => {
    // 41 shared functions across 11 mirrored files when this was written. The
    // floor is deliberately below that so ordinary trimming does not trip it,
    // and far enough above zero that a parser that stopped matching would.
    expect(comparisons.length).toBeGreaterThanOrEqual(35);
    const unparseable = comparisons.filter((c) => c.mirror === null || c.source === null);
    expect(unparseable.map((c) => `${c.file}:${c.name}`)).toEqual([]);
  });

  it('leaves no mirror export silently uncompared', () => {
    // If this fails, a mirrored file grew an export its source counterpart
    // does not have, so nothing checks it. Either add it to src (it is drift)
    // or list it as bot-only with a reason. Widening the list without one is
    // how the check goes quiet.
    expect(unaccounted).toEqual(KNOWN_BOT_ONLY);
  });

  for (const { file, src } of mirrors) {
    // telegramConfirm/telegramChat/telegramLink are bot-only and have no
    // counterpart by design; their own headers say so.
    if (!src) continue;

    it(`${file} matches ${src}`, () => {
      const mirrorCode = readFileSync(join(APPLIB, file), 'utf8');
      const srcCode = readFileSync(src, 'utf8');
      const shared = [
        ...exportedFunctions(mirrorCode).filter((n) => exportedFunctions(srcCode).includes(n)),
        ...exportedConstants(mirrorCode).filter((n) => exportedConstants(srcCode).includes(n)),
      ];
      expect(shared.length).toBeGreaterThan(0);

      const drifted = comparisons
        .filter((c) => c.file === file)
        // A body this cannot parse is reported, not skipped: silently passing
        // on it would be the same failure as not checking at all.
        .filter((c) => c.mirror === null || c.source === null || c.mirror !== c.source)
        .map((c) => c.name);
      expect(drifted).toEqual([]);
    });
  }
});

// The check is only worth its green tick if the parser underneath it is sound.
// These lock in the two ways it could pass vacuously: truncating both copies
// at the same wrong place, or failing to find a body at all.
describe('the parser the parity check rests on', () => {
  const body = (src) => functionSource(src, 'f');

  it('does not let a brace inside a regex literal end the body early', () => {
    // This was a real false pass: `/[}]/` read as division truncated both
    // copies to `{ return s.replace(/[}` , which compared equal while the
    // bodies differed.
    const a = `export function f(s) { return s.replace(/[}]/g, ''); }`;
    const b = `export function f(s) { return s.replace(/[}]/g, 'X'); }`;
    expect(body(a)).toBe(`{ return s.replace(/[}]/g, ''); }`);
    expect(body(a)).not.toBe(body(b));
  });

  it('does not let a quote inside a regex literal swallow the rest of the file', () => {
    const a = `export function f(s) { return /['"]/.test(s) ? 1 : 2; }`;
    const b = `export function f(s) { return /['"]/.test(s) ? 1 : 3; }`;
    expect(body(a)).not.toBeNull();
    expect(body(a)).not.toBe(body(b));
  });

  it('still reads a slash that is division, not a regex', () => {
    expect(body(`export function f(a, b) { return a / b; }`)).toBe('{ return a / b; }');
    expect(body(`export function f(a, b) { return a / b / 2; }`)).toBe('{ return a / b / 2; }');
  });

  it('ignores comments but not the code around them', () => {
    const a = `export function f(x) { // it's one\n return x + 1; }`;
    const b = `export function f(x) { // it's two\n return x + 1; }`;
    const c = `export function f(x) { // it's one\n return x + 2; }`;
    expect(body(a)).toBe(body(b));
    expect(body(a)).not.toBe(body(c));
  });

  it('keeps braces inside strings and templates out of the brace count', () => {
    expect(body('export function f(x) { return `a${x}b}`; }')).toBe('{ return `a${x}b}`; }');
    expect(body(`export function f() { return '}'; }`)).toBe(`{ return '}'; }`);
  });

  it('reads a constant declaration up to its own semicolon', () => {
    expect(constantSource(`export const Z = 'Asia/Dubai';\nexport const Y = 1;`, 'Z'))
      .toBe(`export const Z = 'Asia/Dubai';`);
    expect(constantSource(`export const Z = { a: 1, b: [2, 3] };\nconst other = 4;`, 'Z'))
      .toBe('export const Z = { a: 1, b: [2, 3] };');
  });
});
