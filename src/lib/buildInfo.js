// A deployed preview must be able to say which commit it is: QA verifies an
// exact commit, and "the preview looks right" is not evidence unless the
// preview names what it was built from. Values are injected at build time by
// vite.config.js (Netlify COMMIT_REF / CI GITHUB_SHA / local git HEAD).
const SHA = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown';
const BUILT_AT = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : null;

export const buildSha = SHA;
export const buildShortSha = SHA === 'unknown' ? 'unknown' : SHA.slice(0, 7);
export const buildTime = BUILT_AT;

export function buildLabel() {
  if (SHA === 'unknown') return 'build unknown';
  return `build ${buildShortSha}`;
}

export function buildTitle() {
  const when = BUILT_AT ? new Date(BUILT_AT).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time';
  return `Commit ${SHA} · built ${when}`;
}
