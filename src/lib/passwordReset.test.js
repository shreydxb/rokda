import { describe, it, expect } from 'vitest';
import { isRecoveryRedirect, resetLinkError, resetRedirectUrl } from './passwordReset';

describe('resetRedirectUrl', () => {
  it('keeps a base path, so a project site is not sent outside the app', () => {
    expect(resetRedirectUrl('https://example.github.io', '/rokda/')).toBe('https://example.github.io/rokda/');
  });

  it('is the root on a host that serves the app at /', () => {
    expect(resetRedirectUrl('https://rokda.example.test', '/')).toBe('https://rokda.example.test/');
  });
});

describe('isRecoveryRedirect', () => {
  it('recognises the fragment a reset email lands with', () => {
    expect(isRecoveryRedirect('#access_token=t&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery')).toBe(true);
  });

  it('ignores other sign-in links, an expired-link error and an empty fragment', () => {
    expect(isRecoveryRedirect('#access_token=t&type=magiclink')).toBe(false);
    expect(isRecoveryRedirect('#error=access_denied&error_code=otp_expired')).toBe(false);
    expect(isRecoveryRedirect('')).toBe(false);
    expect(isRecoveryRedirect(undefined)).toBe(false);
  });
});

describe('resetLinkError', () => {
  it('says an expired or used link is exactly that', () => {
    expect(resetLinkError('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).toBe(
      'That reset link has expired or has already been used. Send yourself a new one below.',
    );
  });

  it('reads the reason from the query string as well as the fragment', () => {
    expect(resetLinkError('', '?error=access_denied&error_code=otp_expired')).toMatch(/has expired or has already been used/);
  });

  it('gives any other failure a fixed message, never the text the link carried', () => {
    const message = resetLinkError('#error=server_error&error_description=Call+this+number');
    expect(message).toBe('That link did not sign you in. Send yourself a new reset link below.');
    expect(message).not.toMatch(/number/);
  });

  it('is empty for a working reset link and for an ordinary visit', () => {
    expect(resetLinkError('#access_token=t&refresh_token=r&type=recovery')).toBe('');
    expect(resetLinkError('', '')).toBe('');
    expect(resetLinkError(undefined, undefined)).toBe('');
  });
});
