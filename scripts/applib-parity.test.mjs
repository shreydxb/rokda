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

// Strip comments and collapse whitespace, without touching string or template
// contents -- the same reason compare-migrations.mjs tokenises rather than
// running a regex over everything.
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
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < code.length) {
        if (code[i] === '\\') {
          out += code.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += code[i];
        if (code[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
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
  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i];
    // Skip over string contents so a brace inside one cannot close the body.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < normalised.length && normalised[i] !== quote) {
        if (normalised[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return normalised.slice(0, i + 1);
    }
  }
  return null;
}

function exportedFunctions(code) {
  return [...code.matchAll(/export\s+function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
}

const mirrors = readdirSync(APPLIB)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map((file) => ({ file, src: sourceCounterpart(file) }));

// Collected once so the suite can assert on its own coverage. A parity check
// that quietly stops comparing anything still passes, which would be the same
// blind spot in a new costume.
const comparisons = [];
for (const { file, src } of mirrors) {
  if (!src) continue;
  const mirrorCode = readFileSync(join(APPLIB, file), 'utf8');
  const srcCode = readFileSync(src, 'utf8');
  const srcNames = exportedFunctions(srcCode);
  for (const name of exportedFunctions(mirrorCode).filter((n) => srcNames.includes(n))) {
    comparisons.push({
      file,
      src,
      name,
      mirror: functionSource(mirrorCode, name),
      source: functionSource(srcCode, name),
    });
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

  for (const { file, src } of mirrors) {
    // telegramConfirm/telegramChat/telegramLink are bot-only and have no
    // counterpart by design; their own headers say so.
    if (!src) continue;

    it(`${file} matches ${src}`, () => {
      const mirrorCode = readFileSync(join(APPLIB, file), 'utf8');
      const srcCode = readFileSync(src, 'utf8');
      const shared = exportedFunctions(mirrorCode).filter((n) => exportedFunctions(srcCode).includes(n));
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
