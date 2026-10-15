import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { abandonedTotp, cleanCode, codeProblem, verifiedTotp } from '../lib/twoStep';
import './Login.css';

// The second step of signing in (docs/decisions.md, "Signing in takes a
// password and a code"; SHR-312). Shown after the password, before anything
// of the household loads: the app renders nothing else until the session has
// passed it. A member with an authenticator enters its code; a member without
// one adds one first, from a QR code, and confirms it with its first code.
export default function TwoStep() {
  const { user, twoStep, recheckTwoStep, signOut } = useAuth();

  if (twoStep === 'checking') return <Frame title="Signing in" message="Checking your sign-in…" />;

  if (twoStep === 'error') {
    return (
      <Frame title="Signing in" message="Rokda couldn't check your sign-in just now, so nothing is shown yet.">
        <button type="button" className="om-loginsubmit" onClick={recheckTwoStep}>
          Try again
        </button>
        <button type="button" className="om-linkbtn om-back" onClick={signOut}>
          Sign out
        </button>
      </Frame>
    );
  }

  return twoStep === 'enroll' ? <Enroll email={user?.email} signOut={signOut} /> : <Challenge email={user?.email} signOut={signOut} />;
}

function Frame({ title, message, children }) {
  return (
    <div className="om-login">
      <aside className="om-loginside">
        <div className="om-loginbrand">Rokda</div>
        <p className="om-logintag">Net worth, cash flow, budgets, and investments — one private household ledger.</p>
      </aside>
      <main className="om-loginmain">
        <div className="om-loginform">
          <h1 className="om-loginh1">{title}</h1>
          {message && <p className="om-loginmsg">{message}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}

// The code field and its submit, shared by both steps. `verify` checks the
// code; on success Supabase replaces the session with one that has passed its
// second step, and the app opens on its own.
function CodeForm({ label, submitLabel, verify, signOut, disabled = false }) {
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const problem = touched ? codeProblem(code) : '';

  async function handleSubmit(e) {
    e.preventDefault();
    setTouched(true);
    setFormError('');
    if (codeProblem(code)) return;
    setSubmitting(true);
    const message = await verify(cleanCode(code));
    setSubmitting(false);
    if (message) {
      setFormError(message);
      setCode('');
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <label className="om-field">
        <span>{label}</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={!!problem}
          aria-describedby={problem ? 'two-step-code-error' : undefined}
          disabled={disabled}
        />
        {problem && (
          <span id="two-step-code-error" className="om-fielderr">
            {problem}
          </span>
        )}
      </label>
      {formError && (
        <p className="om-loginerr" role="alert">
          {formError}
        </p>
      )}
      <button type="submit" className="om-loginsubmit" disabled={submitting || disabled}>
        {submitting ? 'Please wait…' : submitLabel}
      </button>
      <button type="button" className="om-linkbtn om-back" onClick={signOut}>
        Sign out
      </button>
    </form>
  );
}

// Supabase's own wording for a wrong or expired code is technical; this says
// what to do.
function verifyMessage(error) {
  if (!error) return '';
  if (/invalid|expired|code/i.test(error.message ?? '')) return "That code didn't work. Codes change every 30 seconds; enter the one showing now.";
  return error.message || "That code couldn't be checked. Try again.";
}

function Challenge({ email, signOut }) {
  const [factor, setFactor] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let live = true;
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (!live) return;
      const found = verifiedTotp(data);
      if (error || !found) setLoadError("Your authenticator couldn't be found. Sign out and in again, or ask the owner to reset it.");
      else setFactor(found);
    });
    return () => {
      live = false;
    };
  }, []);

  async function verify(code) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    return verifyMessage(error);
  }

  return (
    <Frame title="Enter your code" message={`Open your authenticator app and enter the 6-digit code for Rokda${email ? ` (${email})` : ''}.`}>
      {loadError && (
        <p className="om-loginerr" role="alert">
          {loadError}
        </p>
      )}
      <CodeForm label="Code" submitLabel="Continue" verify={verify} signOut={signOut} disabled={!factor} />
    </Frame>
  );
}

function Enroll({ email, signOut }) {
  const [enrolment, setEnrolment] = useState(null);
  const [loadError, setLoadError] = useState('');
  // React runs a mount effect twice in development; one sign-in adds one
  // authenticator.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // An attempt left unconfirmed (a closed tab, a reload) is removed first,
      // so the code entered below is always for the QR code shown.
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) {
        setLoadError("Rokda couldn't start adding an authenticator. Sign out and in again.");
        return;
      }
      for (const stale of abandonedTotp(factors)) await supabase.auth.mfa.unenroll({ factorId: stale.id });
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'Rokda' });
      if (error || !data) setLoadError(error?.message || "Rokda couldn't start adding an authenticator. Sign out and in again.");
      else setEnrolment(data);
    })();
  }, []);

  async function verify(code) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolment.id, code });
    return verifyMessage(error);
  }

  return (
    <Frame
      title="Add an authenticator"
      message={`Rokda asks for a code from an authenticator app each time you sign in${email ? ` as ${email}` : ''}. Scan this with the app (Google Authenticator, 1Password, Authy or similar), then enter the code it shows.`}
    >
      {loadError && (
        <p className="om-loginerr" role="alert">
          {loadError}
        </p>
      )}
      {enrolment && (
        <div>
          <img src={enrolment.totp.qr_code} alt="QR code to add Rokda to an authenticator app" width={180} height={180} style={{ background: '#fff', padding: 8, borderRadius: 6 }} />
          <p className="om-loginmsg" style={{ fontSize: 12.5, marginTop: 10 }}>
            Can't scan it? Enter this key in the app instead:{' '}
            <code style={{ wordBreak: 'break-all', userSelect: 'all' }} data-testid="totp-secret">
              {enrolment.totp.secret}
            </code>
          </p>
        </div>
      )}
      <CodeForm label="Code from the app" submitLabel="Confirm and continue" verify={verify} signOut={signOut} disabled={!enrolment} />
    </Frame>
  );
}
