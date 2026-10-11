// The Content-Security-Policy every production build carries.
//
// It ships as a <meta> tag in index.html (vite.config.js adds it at build
// time) rather than only as a Netlify header, for two reasons. GitHub Pages,
// the credit-free host, cannot set response headers at all, so a header-only
// policy would protect one of the two addresses the household uses. And the
// browser suite (e2e/) serves a real build, so a policy that blocks something
// the app needs shows up there as a console error and fails the run, instead
// of being discovered on the live site.
//
// The one place the app talks to is its own Supabase project, and that is
// known only at build time (VITE_SUPABASE_URL), so connect-src and img-src
// are built from it. Pinning the project rather than allowing
// https://*.supabase.co matters: after a script injection, a wildcard would
// let the page send the household's data to any Supabase project, including
// one an attacker made for the purpose. The app makes no realtime
// subscriptions, so there is no wss origin.
//
// Directives a <meta> policy cannot carry (frame-ancestors, report-uri) are
// set as headers in netlify.toml instead; Chrome logs an error for each one
// it finds in a meta tag.

// The origin of the Supabase URL a build is made against, or null when it is
// missing or not an http(s) URL -- connect-src then allows only the app's own
// origin, and the app fails closed instead of the policy being widened.
export function supabaseOrigin(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(supabaseUrl) {
  const origin = supabaseOrigin(supabaseUrl);
  const directives = [
    ['default-src', "'self'"],
    // Vite emits module scripts as files; nothing inline and nothing from
    // another origin. This is the directive that makes an injected <script>
    // or inline handler inert.
    ['script-src', "'self'"],
    // 'unsafe-inline' for styles only: the Google Fonts stylesheet is
    // cross-origin, and React's style props are applied through the CSSOM,
    // which a policy does not govern, but a future <style> element would be.
    // Inline styles cannot run code.
    ['style-src', "'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    ['font-src', "'self'", 'https://fonts.gstatic.com'],
    // data: for small images Vite inlines into the CSS. The project origin
    // for receipt photos in the Inbox: an <img> whose src is a signed
    // Storage URL on the Supabase origin, which connect-src does not cover.
    ['img-src', "'self'", 'data:', ...(origin ? [origin] : [])],
    ['connect-src', "'self'", ...(origin ? [origin] : [])],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
  ];
  return directives.map((directive) => directive.join(' ')).join('; ');
}
