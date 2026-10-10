import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, supabaseOrigin } from './csp.mjs';

function directives(policy) {
  return Object.fromEntries(policy.split('; ').map((d) => {
    const [name, ...values] = d.split(' ');
    return [name, values];
  }));
}

describe('supabaseOrigin', () => {
  it('keeps only the origin of the project URL', () => {
    expect(supabaseOrigin('https://abcdefgh.supabase.co')).toBe('https://abcdefgh.supabase.co');
    expect(supabaseOrigin('https://abcdefgh.supabase.co/rest/v1/')).toBe('https://abcdefgh.supabase.co');
    expect(supabaseOrigin(' http://localhost:54321 ')).toBe('http://localhost:54321');
  });

  it('refuses anything that is not an http(s) URL', () => {
    for (const bad of [undefined, null, '', '   ', 'not a url', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://example.com']) {
      expect(supabaseOrigin(bad)).toBeNull();
    }
  });
});

describe('contentSecurityPolicy', () => {
  it('lets the app reach its own Supabase project and nothing else', () => {
    const d = directives(contentSecurityPolicy('https://abcdefgh.supabase.co'));
    expect(d['connect-src']).toEqual(["'self'", 'https://abcdefgh.supabase.co']);
    expect(d['connect-src'].join(' ')).not.toMatch(/\*/);
  });

  it('shows images from the app and from its own Supabase project, where receipt photos are', () => {
    const d = directives(contentSecurityPolicy('https://abcdefgh.supabase.co'));
    expect(d['img-src']).toEqual(["'self'", 'data:', 'https://abcdefgh.supabase.co']);
  });

  it('falls back to the app alone when the build has no Supabase URL', () => {
    const d = directives(contentSecurityPolicy(undefined));
    expect(d['connect-src']).toEqual(["'self'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:']);
  });

  it('allows no inline or cross-origin script', () => {
    const d = directives(contentSecurityPolicy('https://abcdefgh.supabase.co'));
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
  });

  it('allows the Google Fonts stylesheet and font files the page links', () => {
    const d = directives(contentSecurityPolicy('https://abcdefgh.supabase.co'));
    expect(d['style-src']).toContain('https://fonts.googleapis.com');
    expect(d['font-src']).toContain('https://fonts.gstatic.com');
  });

  it('carries no directive a <meta> policy ignores', () => {
    // Chrome logs a console error for each, which the browser suite counts.
    const d = directives(contentSecurityPolicy('https://abcdefgh.supabase.co'));
    for (const headerOnly of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
      expect(d).not.toHaveProperty(headerOnly);
    }
  });
});
