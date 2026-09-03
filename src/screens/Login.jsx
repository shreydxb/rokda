import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase, setKeepSignedIn } from '../lib/supabaseClient';
import './Login.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname ?? '/';

  const [mode, setMode] = useState('sign-in'); // 'sign-in' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedInState] = useState(true);
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [resetSent, setResetSent] = useState(false);

  const emailError =
    touched.email && !EMAIL_RE.test(email) ? 'Enter a valid email address.' : '';
  const passwordError =
    touched.password && mode === 'sign-in' && password.length === 0
      ? 'Password is required.'
      : '';

  async function handleSubmit(e) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    setFormError('');

    if (!EMAIL_RE.test(email) || (mode === 'sign-in' && password.length === 0)) {
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/login`,
        });
        if (error) throw error;
        setResetSent(true);
      } else {
        setKeepSignedIn(keepSignedIn);
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate(from, { replace: true });
      }
    } catch (err) {
      setFormError(err.message || 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
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
          <h1 className="om-loginh1">{mode === 'forgot' ? 'Reset password' : 'Sign in'}</h1>

          {mode === 'forgot' && resetSent ? (
            <p className="om-loginmsg">
              If an account exists for <strong>{email}</strong>, a reset link is on its way.
            </p>
          ) : (
            <>
              <label className="om-field">
                <span>Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  aria-invalid={!!emailError}
                  aria-describedby={emailError ? 'email-error' : undefined}
                />
                {emailError && (
                  <span id="email-error" className="om-fielderr">
                    {emailError}
                  </span>
                )}
              </label>

              {mode === 'sign-in' && (
                <label className="om-field">
                  <span>Password</span>
                  <div className="om-passrow">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                      aria-invalid={!!passwordError}
                      aria-describedby={passwordError ? 'password-error' : undefined}
                    />
                    <button
                      type="button"
                      className="om-passtoggle"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {passwordError && (
                    <span id="password-error" className="om-fielderr">
                      {passwordError}
                    </span>
                  )}
                </label>
              )}

              {mode === 'sign-in' && (
                <div className="om-loginrow">
                  <label className="om-checkrow">
                    <input
                      type="checkbox"
                      checked={keepSignedIn}
                      onChange={(e) => setKeepSignedInState(e.target.checked)}
                    />
                    <span>Keep me signed in</span>
                  </label>
                  <button
                    type="button"
                    className="om-linkbtn"
                    onClick={() => {
                      setMode('forgot');
                      setFormError('');
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {formError && (
                <p className="om-loginerr" role="alert">
                  {formError}
                </p>
              )}

              <button type="submit" className="om-loginsubmit" disabled={submitting}>
                {submitting
                  ? 'Please wait…'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : 'Sign in'}
              </button>

              {mode === 'forgot' && (
                <button
                  type="button"
                  className="om-linkbtn om-back"
                  onClick={() => {
                    setMode('sign-in');
                    setFormError('');
                  }}
                >
                  Back to sign in
                </button>
              )}
            </>
          )}
        </form>
      </main>
    </div>
  );
}
