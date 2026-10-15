import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// The second step of signing in. The Supabase client is mocked so the test
// sees exactly which factor each code is checked against.
const mfa = vi.hoisted(() => ({
  factors: null,
  calls: [],
  verifyError: null,
  enrolled: { id: 'new-factor', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg></svg>', secret: 'JBSWY3DPEHPK3PXP' } },
}));
const auth = vi.hoisted(() => ({ value: null }));

vi.mock('../lib/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: async () => ({ data: mfa.factors, error: null }),
        unenroll: async ({ factorId }) => {
          mfa.calls.push(['unenroll', factorId]);
          return { error: null };
        },
        enroll: async (params) => {
          mfa.calls.push(['enroll', params]);
          return { data: mfa.enrolled, error: null };
        },
        challengeAndVerify: async (params) => {
          mfa.calls.push(['verify', params]);
          return { data: mfa.verifyError ? null : {}, error: mfa.verifyError };
        },
      },
    },
  },
}));

const { default: TwoStep } = await import('./TwoStep');

async function renderStep(twoStep) {
  auth.value = { user: { email: 'owner@example.test' }, twoStep, recheckTwoStep: vi.fn(), signOut: vi.fn() };
  render(<TwoStep />);
  await act(async () => {});
}

async function enter(code, button) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: button }));
  });
}

describe('TwoStep', () => {
  beforeEach(() => {
    mfa.calls.length = 0;
    mfa.verifyError = null;
    mfa.factors = {
      totp: [{ id: 'phone-1', status: 'verified', factor_type: 'totp' }],
      all: [{ id: 'phone-1', status: 'verified', factor_type: 'totp' }],
    };
  });

  it('checks the code against the member\'s authenticator', async () => {
    await renderStep('challenge');
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
    await enter('123 456', 'Continue');
    expect(mfa.calls).toEqual([['verify', { factorId: 'phone-1', code: '123456' }]]);
  });

  it('says plainly when a code is wrong, and lets them try again', async () => {
    mfa.verifyError = { message: 'Invalid TOTP code entered' };
    await renderStep('challenge');
    await enter('123456', 'Continue');
    expect(screen.getByRole('alert').textContent).toMatch(/didn't work/);
    expect(screen.getByRole('textbox').value).toBe('');
  });

  it('checks nothing until the code is six digits', async () => {
    await renderStep('challenge');
    await enter('12345', 'Continue');
    expect(screen.getByText('The code is 6 digits.')).toBeTruthy();
    expect(mfa.calls).toEqual([]);
  });

  it('adds an authenticator once, after clearing an abandoned one, and confirms it with its first code', async () => {
    mfa.factors = { totp: [], all: [{ id: 'old', status: 'unverified', factor_type: 'totp' }] };
    await renderStep('enroll');
    expect(screen.getByRole('heading', { name: 'Add an authenticator' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /QR code/ }).getAttribute('src')).toBe(mfa.enrolled.totp.qr_code);
    expect(screen.getByTestId('totp-secret').textContent).toBe('JBSWY3DPEHPK3PXP');
    await enter('654321', 'Confirm and continue');
    expect(mfa.calls).toEqual([
      ['unenroll', 'old'],
      ['enroll', { factorType: 'totp', issuer: 'Rokda' }],
      ['verify', { factorId: 'new-factor', code: '654321' }],
    ]);
  });

  it('offers a retry and a way out when the check failed', async () => {
    await renderStep('error');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(auth.value.recheckTwoStep).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.value.signOut).toHaveBeenCalled();
  });
});
