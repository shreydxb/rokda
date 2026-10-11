import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SetPassword from './SetPassword';

const auth = vi.hoisted(() => ({ updateUser: vi.fn(), finishRecovery: vi.fn(), signOut: vi.fn() }));

vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { updateUser: auth.updateUser } },
}));

vi.mock('../lib/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'owner@example.test' }, finishRecovery: auth.finishRecovery, signOut: auth.signOut }),
}));

beforeEach(() => {
  auth.updateUser.mockReset().mockResolvedValue({ data: { user: {} }, error: null });
  auth.finishRecovery.mockReset();
  auth.signOut.mockReset();
});

function submit(password, confirm = password) {
  render(<SetPassword />);
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
}

describe('SetPassword', () => {
  it('saves the new password, then opens the app', async () => {
    submit('a-long-new-password');
    await waitFor(() => expect(auth.finishRecovery).toHaveBeenCalledTimes(1));
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-long-new-password' });
  });

  it('refuses a short password without calling Supabase', () => {
    submit('short');
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses two passwords that differ', () => {
    submit('a-long-new-password', 'a-long-new-passwort');
    expect(screen.getByText('The two passwords do not match.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('stays on the screen and says why when Supabase refuses', async () => {
    auth.updateUser.mockResolvedValue({ data: null, error: { message: 'Password should be at least 12 characters.' } });
    submit('a-long-new-password');
    expect((await screen.findByRole('alert')).textContent).toBe('Password should be at least 12 characters.');
    expect(auth.finishRecovery).not.toHaveBeenCalled();
  });

  it('offers signing out instead', () => {
    render(<SetPassword />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out instead' }));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
