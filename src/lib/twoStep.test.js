import { describe, expect, it } from 'vitest';
import { abandonedTotp, cleanCode, codeProblem, twoStepState, verifiedTotp } from './twoStep';

describe('twoStepState', () => {
  it('lets a session through only once it has passed its second step', () => {
    expect(twoStepState({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe('ok');
  });

  it('asks for a code when an authenticator is set up', () => {
    expect(twoStepState({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe('challenge');
  });

  it('asks for an authenticator to be added when none is', () => {
    expect(twoStepState({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe('enroll');
  });

  it('shows nothing when the check failed, rather than guessing', () => {
    expect(twoStepState(null, new Error('network'))).toBe('error');
    expect(twoStepState({ currentLevel: 'aal2', nextLevel: 'aal2' }, new Error('x'))).toBe('error');
    expect(twoStepState(null, null)).toBe('error');
  });
});

describe('factors', () => {
  const factors = {
    totp: [{ id: 'f1', status: 'verified' }],
    all: [
      { id: 'f1', factor_type: 'totp', status: 'verified' },
      { id: 'f2', factor_type: 'totp', status: 'unverified' },
      { id: 'f3', factor_type: 'phone', status: 'unverified' },
    ],
  };

  it('checks codes against the verified authenticator', () => {
    expect(verifiedTotp(factors).id).toBe('f1');
    expect(verifiedTotp({ totp: [] })).toBeNull();
    expect(verifiedTotp(undefined)).toBeNull();
  });

  it('finds authenticators that were started and never confirmed', () => {
    expect(abandonedTotp(factors).map((f) => f.id)).toEqual(['f2']);
  });
});

describe('codes', () => {
  it('accepts six digits, with or without the space apps show', () => {
    expect(codeProblem('123456')).toBe('');
    expect(codeProblem('123 456')).toBe('');
    expect(cleanCode(' 123 456 ')).toBe('123456');
  });

  it('says what is wrong with anything else', () => {
    expect(codeProblem('')).toMatch(/Enter the 6-digit code/);
    expect(codeProblem('12345')).toBe('The code is 6 digits.');
    expect(codeProblem('12345a')).toBe('The code is 6 digits.');
  });
});
