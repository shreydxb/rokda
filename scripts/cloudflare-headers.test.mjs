import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cloudflareHeadersFile, headersFromNetlifyToml } from './cloudflare-headers.mjs';

// Cloudflare Pages gets its headers from netlify.toml, translated at build
// time, so the two hosts can't drift apart. These pin what the real file
// yields and that anything the translation can't read stops the build.
describe('the security headers Cloudflare Pages sends', () => {
  const rules = headersFromNetlifyToml(readFileSync('netlify.toml', 'utf8'));
  const forPath = (path) => Object.fromEntries(rules.find((r) => r.path === path)?.values ?? []);

  it('are every header netlify.toml sets on every path', () => {
    expect(forPath('/*')).toEqual({
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Strict-Transport-Security': 'max-age=31536000',
    });
  });

  it('keep the long cache for hashed assets and revalidation for the page', () => {
    expect(forPath('/assets/*')).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' });
    expect(forPath('/index.html')).toEqual({ 'Cache-Control': 'public, max-age=0, must-revalidate' });
  });

  it("are written in Cloudflare's _headers format", () => {
    const file = cloudflareHeadersFile(rules);
    expect(file).toContain("/*\n  Content-Security-Policy: frame-ancestors 'none'\n  X-Frame-Options: DENY\n");
    expect(file).toContain('\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n');
    expect(file.endsWith('\n')).toBe(true);
  });
});

describe('reading netlify.toml', () => {
  it('ignores the rest of the file', () => {
    const toml = '[build]\n  command = "npm run build"\n\n[[headers]]\n  for = "/*"\n  [headers.values]\n    # a comment\n    X-Frame-Options = "DENY"\n\n[[redirects]]\n  from = "/*"\n';
    expect(headersFromNetlifyToml(toml)).toEqual([{ path: '/*', values: [['X-Frame-Options', 'DENY']] }]);
  });

  it('refuses what it would otherwise drop', () => {
    expect(() => headersFromNetlifyToml('[[headers]]\n  for = "/*"\n  [headers.values]\n    X-Test = "a \\" b"\n')).toThrow(/double-quoted/);
    expect(() => headersFromNetlifyToml('[[headers]]\n  for = "/*"\n  status = "200"\n')).toThrow(/unexpected key status/);
    expect(() => headersFromNetlifyToml('[[headers]]\n  [headers.values]\n    X-Test = "1"\n')).toThrow(/no `for` path/);
    expect(() => headersFromNetlifyToml('[[headers]]\n  for = "/*"\n')).toThrow(/sets no headers/);
    expect(() => headersFromNetlifyToml('[build]\n  publish = "dist"\n')).toThrow(/no \[\[headers\]\] blocks/);
  });
});
