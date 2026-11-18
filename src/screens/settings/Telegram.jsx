import { useEffect, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { householdToday } from '../../lib/day';
import { shortDate } from '../../lib/dividends';
import { Avatar, Card, Chip, Drawer, Fold, InfoButton, Switch } from '../../design-system/kit';
import './SettingsTabs.css';

// Settings -> Telegram, like the prototype (the revamp, phase 7; review
// S-telegram and T19): what the bot sends, as two cards of switches, who is
// linked, and a drawer that links a member with a link, a QR code and the
// code itself. The switches are the household's (design note, decision 1).

const DEFAULTS = {
  recurring_enabled: true,
  credit_card_enabled: true,
  cash_cover_enabled: true,
  brief_enabled: true,
  unusual_spend_enabled: true,
  balance_checkin_enabled: true,
  statement_enabled: true,
  dividends_enabled: true,
};

const MORNING = [
  { key: 'recurring_enabled', label: 'Missed bills', note: "When a bill's date passes with nothing recorded" },
  { key: 'credit_card_enabled', label: 'Card due dates', note: 'A day or two before, and again if still owing' },
  { key: 'cash_cover_enabled', label: 'Cash cover', note: "Once a week, if cash can't cover the next 7 days" },
  { key: 'unusual_spend_enabled', label: 'Unusual spending', note: 'Once, when a category runs well past its usual' },
  { key: 'brief_enabled', label: 'Weekly and month-end brief', note: 'Every Monday, and when a month ends' },
];
const QUESTIONS = [
  { key: 'statement_enabled', label: 'Card statements', note: 'When one closes, and 3 days before it is due' },
  { key: 'dividends_enabled', label: 'Dividends', note: 'When dividends are paid into a broker fund' },
  { key: 'balance_checkin_enabled', label: 'Month-end balances', note: 'On the 1st, with the monthly brief' },
];
const SIGNALS = [...MORNING, ...QUESTIONS];

const STATS_WINDOW_DAYS = 30;

// The bot's username, for a link that opens it with the code filled in. A
// build setting, so the public repository names no household's bot; without
// it the drawer gives the code alone.
const botName = () => String(import.meta.env.VITE_TELEGRAM_BOT ?? '').trim().replace(/^@/, '');

export default function Telegram({ household, members = [], me, loading }) {
  const [prefs, setPrefs] = useState(DEFAULTS);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [saving, setSaving] = useState(null); // the key being saved, or null
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (!household?.id) return undefined;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    setPrefsLoading(true);
    supabase
      .from('telegram_notification_prefs')
      // Read every signal the screen shows. A hand-written list left out
      // statement_enabled, so "Card statements" read Off while the bot,
      // reading the column, treated it as on.
      .select(SIGNALS.map((sig) => sig.key).join(', '))
      .eq('household_id', household.id)
      .maybeSingle()
      .then(({ data, error: fetchError }) => {
        if (cancelled) return;
        if (fetchError) setError(fetchError.message);
        // No row yet means every signal is on, as the bot reads it.
        else setPrefs(data ?? DEFAULTS);
        setPrefsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [household?.id]);

  // Each switch saves only its own column, and a failure puts back only that
  // switch. Sending the whole row let two switches flipped together undo each
  // other, whichever save landed last (outside review, E-08).
  async function toggle(key) {
    const value = !prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaving(key);
    setError('');
    const { error: saveError } = await supabase.from('telegram_notification_prefs').upsert({ household_id: household.id, [key]: value }, { onConflict: 'household_id' });
    setSaving(null);
    if (saveError) {
      setPrefs((p) => ({ ...p, [key]: !value }));
      setError(saveError.message);
    }
  }

  if (loading || prefsLoading) return <div className="ov-skel" aria-busy="true" />;

  const iAmOwner = me?.role === 'owner';
  const canLink = (m) => iAmOwner || m.id === me?.id;
  const linking = members.find((m) => m.id === params.get('link')) ?? null;
  const setLink = (id) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (id) p.set('link', id);
        else p.delete('link');
        return p;
      },
      { replace: true },
    );

  const row = (s) => (
    <div key={s.key} className="st-row">
      <div className="st-row-main">
        <div className="st-row-title">{s.label}</div>
        <div className="st-row-sub">{s.note}</div>
      </div>
      <Switch label={s.label} checked={Boolean(prefs[s.key])} onChange={() => toggle(s.key)} disabled={saving === s.key} />
    </div>
  );

  return (
    <div className="st-grid st-grid-7-5">
      <div className="st-stack">
        <Card title="Morning message" info={<InfoButton about="Morning message">Everything that needs no answer arrives together, once, in the morning.</InfoButton>} flush>
          <div className="st-rows">
            {MORNING.map(row)}
            <div className="st-row">
              <div className="st-row-main">
                <div className="st-row-title">Budget alerts</div>
                <div className="st-row-sub">Set per category, at 80%, 90% and over</div>
              </div>
              <RouterLink className="st-link" to="/money?tab=budget">
                Budget →
              </RouterLink>
            </div>
          </div>
        </Card>
        <Card title="Questions that need an answer" info={<InfoButton about="Questions that need an answer">Each arrives as its own message, after the morning message, and waits for an answer.</InfoButton>} flush>
          <div className="st-rows">{QUESTIONS.map(row)}</div>
        </Card>
        {error && (
          <p className="ds-warn-ink st-note" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="st-stack">
        <Card title="Linked accounts" flush>
          <div className="st-rows">
            {members.map((m, at) => (
              <div key={m.id} className="st-row">
                <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={at === 0 ? 'a' : 'b'} />
                <div className="st-row-main">
                  <div className="st-row-title">{m.display_name}</div>
                </div>
                {m.telegram_user_id ? <Chip tone="pos">Linked</Chip> : <Chip tone="warn">Not linked</Chip>}
                {canLink(m) && (
                  <button type="button" className="ds-btn ds-btn-sm" aria-label={`${m.telegram_user_id ? 'Link again' : 'Link'} ${m.display_name}`} onClick={() => setLink(m.id)}>
                    {m.telegram_user_id ? 'Link again' : 'Link'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
        <section className="ds-card st-diag">
          <Fold label="Diagnostics · last 30 days">
            <Diagnostics household={household} />
          </Fold>
        </section>
      </div>

      {linking && <LinkDrawer key={linking.id} member={linking} allowed={canLink(linking)} onClose={() => setLink(null)} />}
    </div>
  );
}

// Links a member's Telegram (review T19): Open Telegram starts the bot with
// the code filled in, the QR code is the same link for a phone, and the code
// is the fallback. The code is a 122-bit token (QA #8), made when the drawer
// opens, and works once, for 15 minutes.
function LinkDrawer({ member, allowed, onClose }) {
  const [code, setCode] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const bot = botName();

  useEffect(() => {
    if (!allowed) return undefined;
    let cancelled = false;
    supabase.rpc('generate_telegram_link_code', { p_member_id: member.id }).then(({ data, error: rpcError }) => {
      if (cancelled) return;
      if (rpcError) setError(rpcError.message);
      // A code that never came would leave the drawer waiting for good.
      else if (!data) setError('No code came back. Try again.');
      else {
        setError('');
        setCode(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [allowed, member.id, attempt]);

  const link = code && bot ? `https://t.me/${bot}?start=${code}` : null;
  const footer = (
    <div className="st-dfoot">
      <div className="te-actions st-dfoot-row">
        <div className="te-actions-right">
          <button type="button" className="ds-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Drawer kicker="Telegram" title={`Link ${member.display_name}`} onClose={onClose} onEscape={onClose} footer={footer}>
      <div className="st-linkbody">
        {!allowed ? (
          <p className="ds-muted">Only an owner can link another member.</p>
        ) : error ? (
          <>
            <p className="ds-warn-ink st-note" role="alert">
              {error}
            </p>
            <button type="button" className="ds-btn" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </>
        ) : !code ? (
          <div className="ov-skel" aria-busy="true" />
        ) : (
          <>
            {link && (
              <>
                <a className="ds-btn ds-btn-primary" href={link} target="_blank" rel="noopener noreferrer">
                  Open Telegram
                </a>
                <p className="ds-muted st-note">or scan with the phone that has Telegram</p>
                <QrCode text={link} />
                <p className="ds-muted st-note">or send this code to the bot</p>
              </>
            )}
            {!link && <p className="ds-muted st-note">Send this code to the bot.</p>}
            <div className="st-code">
              <span className="st-code-box">{code}</span>
              <button
                type="button"
                className="ds-btn ds-btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(code);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="ds-muted st-note">Works once, for 15 minutes.</p>
          </>
        )}
      </div>
    </Drawer>
  );
}

// The QR code, drawn as squares from uqr's grid. The library is loaded only
// when a code is to be drawn.
function QrCode({ text }) {
  const [grid, setGrid] = useState(null);
  useEffect(() => {
    let cancelled = false;
    import('uqr').then(({ encode }) => {
      if (!cancelled) setGrid(encode(text, { border: 1 }).data);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);
  if (!grid) return <div className="st-qr" aria-busy="true" />;
  const size = grid.length;
  let path = '';
  grid.forEach((line, y) =>
    line.forEach((on, x) => {
      if (on) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg className="st-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code to open Telegram" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

// The bot's own record of the messages it handled (SHR-288): how many, and
// how many it read without error, by day. Never what they said, which isn't
// stored (see the telegram_call_log migration).
function Diagnostics({ household }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!household?.id) return undefined;
    let cancelled = false;
    const since = new Date();
    since.setDate(since.getDate() - STATS_WINDOW_DAYS);
    supabase
      .from('telegram_call_log')
      .select('occurred_at, success')
      .eq('household_id', household.id)
      .gte('occurred_at', since.toISOString())
      .then(({ data, error: fetchError }) => {
        if (cancelled) return;
        if (fetchError) setError(fetchError.message);
        else setRows(data ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [household?.id]);

  if (error) {
    return (
      <p className="ds-warn-ink st-note" role="alert">
        {error}
      </p>
    );
  }
  if (rows === null) return <div className="ov-skel" aria-busy="true" />;
  if (rows.length === 0) return <p className="ds-muted st-note">No messages in the last 30 days.</p>;

  const handled = rows.length;
  const readWell = Math.round((rows.filter((r) => r.success).length / handled) * 100);
  const byDay = new Map();
  for (const r of rows) {
    const day = householdToday(new Date(r.occurred_at));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);

  return (
    <div className="st-diag-body">
      <div className="st-diag-kpis">
        <div>
          <div className="st-diag-label">Messages handled</div>
          <div className="st-diag-fig">{handled}</div>
        </div>
        <div>
          <div className="st-diag-label">Read without error</div>
          <div className="st-diag-fig">{`${readWell}%`}</div>
        </div>
      </div>
      <table className="ds-table st-diag-table">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col" className="ds-num">
              Messages
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map(([day, count]) => (
            <tr key={day}>
              <td className="ds-muted st-mono">{shortDate(day)}</td>
              <td className="ds-num">{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
