// Cloudflare Pages reads response headers from a `_headers` file in the
// published directory; Netlify reads them from netlify.toml. The two hosts
// must send the same security headers, so netlify.toml stays the one place
// they are written and the Cloudflare build turns its [[headers]] blocks into
// `_headers` (docs/environments.md, "Cloudflare Pages").
//
// The file is written only by `npm run build:cloudflare`. Netlify reads a
// `_headers` file too, and merges it with netlify.toml's, so one in public/
// would send every header there twice.
//
// netlify.toml is read with a parser for the small part of TOML its headers
// use: [[headers]] blocks with `for = "..."` and a [headers.values] table of
// `Name = "value"` lines. Anything else inside a block (an escape, a
// multi-line string, an unknown key) throws rather than being dropped, so a
// header can't silently go missing from Cloudflare.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QUOTED = /^"([^"\\]*)"$/;

export function headersFromNetlifyToml(toml) {
  const rules = [];
  let rule = null;
  let inValues = false;
  toml.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const where = `netlify.toml line ${index + 1}`;
    if (line === '[[headers]]') {
      rule = { path: null, values: [] };
      rules.push(rule);
      inValues = false;
      return;
    }
    if (line === '[headers.values]') {
      if (!rule) throw new Error(`${where}: [headers.values] outside a [[headers]] block`);
      inValues = true;
      return;
    }
    if (line.startsWith('[')) {
      // Any other table ends the headers block.
      rule = null;
      inValues = false;
      return;
    }
    if (!rule) return;
    const eq = line.indexOf('=');
    if (eq === -1) throw new Error(`${where}: expected key = "value"`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().match(QUOTED);
    if (!value) throw new Error(`${where}: expected a plain double-quoted value for ${key}`);
    if (inValues) rule.values.push([key, value[1]]);
    else if (key === 'for') rule.path = value[1];
    else throw new Error(`${where}: unexpected key ${key} in [[headers]]`);
  });
  for (const r of rules) {
    if (!r.path) throw new Error('netlify.toml: a [[headers]] block has no `for` path');
    if (r.values.length === 0) throw new Error(`netlify.toml: the [[headers]] block for ${r.path} sets no headers`);
  }
  if (rules.length === 0) throw new Error('netlify.toml: no [[headers]] blocks found');
  return rules;
}

// Cloudflare's format: a path on its own line, then its headers indented.
export function cloudflareHeadersFile(rules) {
  return rules.map((r) => [r.path, ...r.values.map(([name, value]) => `  ${name}: ${value}`)].join('\n')).join('\n\n') + '\n';
}

// `node scripts/cloudflare-headers.mjs dist` writes dist/_headers.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ?? 'dist';
  const rules = headersFromNetlifyToml(readFileSync('netlify.toml', 'utf8'));
  writeFileSync(join(outDir, '_headers'), cloudflareHeadersFile(rules));
  console.log(`cloudflare-headers: wrote ${join(outDir, '_headers')} (${rules.length} path rules)`);
}
