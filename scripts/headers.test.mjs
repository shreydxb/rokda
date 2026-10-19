import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// public/_headers is the one place the response headers are written, and a
// header that goes missing fails nothing else: the app still loads, only less
// protected. This reads the file the way Cloudflare Pages does (a path on its
// own line, its headers indented beneath it, # for comments) and pins every
// value.
function readHeaders(text) {
  const rules = {};
  let path = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      path = line;
      rules[path] = {};
      continue;
    }
    const colon = line.indexOf(':');
    if (!path || colon === -1) throw new Error(`public/_headers: cannot read "${raw}"`);
    rules[path][line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return rules;
}

describe('the response headers', () => {
  const rules = readHeaders(readFileSync('public/_headers', 'utf8'));

  it('cover exactly these paths', () => {
    expect(Object.keys(rules)).toEqual(['/*', '/assets/*', '/index.html']);
  });

  it('protect every path', () => {
    expect(rules['/*']).toEqual({
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Strict-Transport-Security': 'max-age=31536000',
    });
  });

  it('keep the long cache for hashed assets and revalidation for the page', () => {
    expect(rules['/assets/*']).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' });
    expect(rules['/index.html']).toEqual({ 'Cache-Control': 'public, max-age=0, must-revalidate' });
  });
});
