import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import './Login.css';

// The app's own floor. The project can set a higher one (Authentication ->
// Sign In / Providers -> Email); anything the server asks for beyond this
// comes back as its own message and is shown as it is.
const MIN_LENGTH = 8;

// Where a reset link lands (docs/decisions.md, "A reset link asks for a new
// password before anything else"). The link has already signed the person
// in; this makes sure they leave with a password they know.
export default function SetPassword() {
  const { user, finishRecovery, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const passwordError = touched && password.length < MIN_LENGTH ? `Use at least ${MIN_LENGTH} characters.` : '';
  const confirmError = touched && !passwordError && confirm !== password ? 'The two passwords do not match.' : '';

  async function handleSubmit(e) {
    e.preventDefault();
    setTouched(true);
    setFormError('');
    if (password.length < MIN_LENGTH || confirm !== password) return;

    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) {
      setFormError(error.message || 'The password was not changed. Try again.');
      return;
    }
    finishRecovery();
  }

  return (
    <div className="om-login">
      <aside className="om-loginside">
        <div className="om-loginbrand">Rokda</div>
        <p className="om-logintag">
          Net worth, cash flow, budgets, and investments — one private household ledger.
        </p>
      </aside>

      <main className="om-loginmain">
        <form className="om-loginform" onSubmit={handleSubmit} noValidate>
          <h1 className="om-loginh1">Set a new password</h1>
          <p className="om-loginmsg">
            Choose a new password for <strong>{user?.email}</strong>. It replaces the old one from now on.
          </p>

          <label className="om-field">
            <span>New password</span>
            <input
              type={showPasswords ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!passwordError}
              aria-describedby={passwordError ? 'new-password-error' : undefined}
            />
            {passwordError && (
              <span id="new-password-error" className="om-fielderr">
                {passwordError}
              </span>
            )}
          </label>

          <label className="om-field">
            <span>Repeat new password</span>
            <input
              type={showPasswords ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={!!confirmError}
              aria-describedby={confirmError ? 'confirm-password-error' : undefined}
            />
            {confirmError && (
              <span id="confirm-password-error" className="om-fielderr">
                {confirmError}
              </span>
            )}
          </label>

          <div className="om-loginrow">
            <label className="om-checkrow">
              <input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} />
              <span>Show passwords</span>
            </label>
          </div>

          {formError && (
            <p className="om-loginerr" role="alert">
              {formError}
            </p>
          )}

          <button type="submit" className="om-loginsubmit" disabled={submitting}>
            {submitting ? 'Please wait…' : 'Save new password'}
          </button>

          <button type="button" className="om-linkbtn om-back" onClick={signOut}>
            Sign out instead
          </button>
        </form>
      </main>
    </div>
  );
}
