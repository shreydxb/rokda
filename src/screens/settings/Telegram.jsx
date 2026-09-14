import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

const DEFAULTS = {
  recurring_enabled: true,
  credit_card_enabled: true,
  cash_cover_enabled: true,
  brief_enabled: true,
  unusual_spend_enabled: true,
};

const SIGNALS = [
  { key: 'recurring_enabled', label: 'Missed recurring bills', note: "Nudge when a bill's due date passes with nothing logged for it" },
  { key: 'credit_card_enabled', label: 'Credit card due dates', note: 'Nudge 1-2 days before a card is due, and again if it still shows owing after' },
  { key: 'cash_cover_enabled', label: 'Cash cover', note: "Weekly warning if liquid balances can't cover what's due in the next 7 days" },
  { key: 'brief_enabled', label: 'Weekly & month-end brief', note: 'The /brief digest, sent automatically every Monday and after each month closes' },
  { key: 'unusual_spend_enabled', label: 'Unusual spend', note: "Nudge once when a category runs well past its usual trailing average -- a deliberately high bar to avoid false alarms" },
];

export default function Telegram({ household, loading }) {
  const [prefs, setPrefs] = useState(DEFAULTS);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [saving, setSaving] = useState(null); // key currently being saved, or null
  const [error, setError] = useState('');

  useEffect(() => {
    if (!household?.id) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    setPrefsLoading(true);
    supabase
      .from('telegram_notification_prefs')
      .select('recurring_enabled, credit_card_enabled, cash_cover_enabled, brief_enabled, unusual_spend_enabled')
      .eq('household_id', household.id)
      .maybeSingle()
      .then(({ data, error: fetchError }) => {
        if (cancelled) return;
        if (fetchError) {
          setError(fetchError.message);
        } else {
          // No row yet means every signal defaults on -- same as the bot's
          // own fallback, so a household that's never opened this tab sees
          // exactly the behaviour it already has today.
          setPrefs(data ?? DEFAULTS);
        }
        setPrefsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [household?.id]);

  async function toggle(key) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSaving(key);
    setError('');
    const { error: saveError } = await supabase
      .from('telegram_notification_prefs')
      .upsert({ household_id: household.id, ...next }, { onConflict: 'household_id' });
    setSaving(null);
    if (saveError) {
      setPrefs(prefs); // revert the optimistic flip
      setError(saveError.message);
    }
  }

  if (loading || prefsLoading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <p className="ov-muted" style={{ marginTop: 0 }}>
        Which proactive nudges this household's linked Telegram members get. Budget-threshold alerts (80/90/100% of a
        category's budget) aren't here -- they're set per category in Money → Budget, since some categories matter and
        others don't.
      </p>

      {SIGNALS.map((s) => (
        <button
          key={s.key}
          type="button"
          className="te-togglerow"
          onClick={() => toggle(s.key)}
          disabled={saving === s.key}
        >
          <div>
            <div className="te-togglelabel">{s.label}</div>
            <div className="te-togglenote">{s.note}</div>
          </div>
          <span className={`te-togglestate ${prefs[s.key] ? '' : 'te-togglestate-warn'}`}>
            {saving === s.key ? '…' : prefs[s.key] ? 'On' : 'Off'}
          </span>
        </button>
      ))}

      {error && (
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
          {error}
        </p>
      )}
    </div>
  );
}
