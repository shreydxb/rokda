import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import '../money/TransactionEditor.css';

// Who the life plan is for, and what it assumes about the years after work
// stops. Ages are kept per member (member_life); the rest is the household's
// planning assumptions. Blank optional fields mean "the same as now": spending
// at today's rate, the same return as before, the same spending for one.
const whole = (v) => /^\d+$/.test(String(v).trim());
const numeric = (v) => String(v).trim() !== '' && Number.isFinite(Number(v));
const blank = (v) => String(v ?? '').trim() === '';
// Names that usually stop by the time work does: a hint, never a default.
const USUALLY_STOPS = /\b(rent|emi|loan|mortgage|instal?ments?)\b/i;

function initialForm(members, memberLife, assumptions) {
  const byMember = new Map(memberLife.map((r) => [r.member_id, r]));
  const people = members.map((m) => ({
    id: m.id,
    name: m.display_name,
    birthYear: byMember.has(m.id) ? String(byMember.get(m.id).birth_year) : '',
    lifeExpectancy: byMember.has(m.id) ? String(byMember.get(m.id).life_expectancy) : '',
    had: byMember.has(m.id),
  }));
  const str = (v) => (v == null ? '' : String(Number(v)));
  return {
    people,
    stopYear: str(assumptions?.retirement_year),
    spend: str(assumptions?.retirement_annual_spend),
    returnPct: str(assumptions?.retirement_return_pct),
    survivorPct: str(assumptions?.survivor_spend_pct),
  };
}

export default function LifePlanEditor({ householdId, members, memberLife, assumptions, categories = [], spendByCategory = new Map(), onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(members, memberLife, assumptions));
  // Spending categories, the ones with spending first, and which of them stop.
  const spendCategories = categories
    .filter((c) => c.kind === 'expense' && !c.is_savings && (!c.archived || c.stops_after_work))
    .sort((a, b) => (spendByCategory.get(b.id) ?? 0) - (spendByCategory.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const [stops, setStops] = useState(() => new Set(categories.filter((c) => c.stops_after_work).map((c) => c.id)));
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const thisYear = new Date().getFullYear();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmingClose]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function toggleStop(id) {
    setStops((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  }

  function setPerson(id, key, value) {
    setForm((f) => ({ ...f, people: f.people.map((p) => (p.id === id ? { ...p, [key]: value } : p)) }));
    setDirty(true);
  }

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  const planned = form.people.filter((p) => !blank(p.birthYear) || !blank(p.lifeExpectancy));
  const first = planned[0];
  const suggestedStop = first && whole(first.birthYear) ? Number(first.birthYear) + 60 : null;

  // The same limits the database enforces, said here in words first.
  function problem() {
    if (!planned.length) return 'Add a birth year and an age to plan to for at least one person.';
    for (const p of planned) {
      if (!whole(p.birthYear) || Number(p.birthYear) < 1900 || Number(p.birthYear) > thisYear) return `Enter ${p.name}'s birth year.`;
      if (!whole(p.lifeExpectancy) || Number(p.lifeExpectancy) < 40 || Number(p.lifeExpectancy) > 120) return `Plan ${p.name} to an age between 40 and 120.`;
      if (Number(p.birthYear) + Number(p.lifeExpectancy) < thisYear) return `${p.name}'s plan would already have ended; plan to a later age.`;
    }
    if (!blank(form.stopYear) && (!whole(form.stopYear) || Number(form.stopYear) < thisYear || Number(form.stopYear) > 2200)) return 'Stop working this year or later.';
    if (!blank(form.spend) && !(numeric(form.spend) && Number(form.spend) >= 0)) return 'Spending after work stops is an amount of zero or more.';
    if (!blank(form.returnPct) && !(numeric(form.returnPct) && Number(form.returnPct) >= -20 && Number(form.returnPct) <= 50)) return 'A return between −20% and 50%.';
    if (!blank(form.survivorPct) && !(numeric(form.survivorPct) && Number(form.survivorPct) >= 10 && Number(form.survivorPct) <= 100)) return 'Spending for one between 10% and 100%.';
    return '';
  }

  async function handleSave(e) {
    e.preventDefault();
    const issue = problem();
    if (issue) {
      setError(issue);
      return;
    }
    setSaving(true);
    setError('');
    const now = new Date().toISOString();
    const rows = planned.map((p) => ({
      member_id: p.id,
      household_id: householdId,
      birth_year: Number(p.birthYear),
      life_expectancy: Number(p.lifeExpectancy),
      updated_at: now,
    }));
    const cleared = form.people.filter((p) => p.had && blank(p.birthYear) && blank(p.lifeExpectancy)).map((p) => p.id);
    const changedStops = categories.filter((c) => !!c.stops_after_work !== stops.has(c.id));
    const results = await Promise.all([
      ...changedStops.map((c) => supabase.from('categories').update({ stops_after_work: stops.has(c.id) }).eq('id', c.id)),
      supabase.from('member_life').upsert(rows, { onConflict: 'member_id' }),
      cleared.length ? supabase.from('member_life').delete().in('member_id', cleared) : Promise.resolve({ error: null }),
      supabase.from('planning_assumptions').upsert(
        {
          household_id: householdId,
          retirement_year: blank(form.stopYear) ? (suggestedStop ?? null) : Number(form.stopYear),
          retirement_annual_spend: blank(form.spend) ? null : Number(form.spend),
          retirement_return_pct: blank(form.returnPct) ? null : Number(form.returnPct),
          survivor_spend_pct: blank(form.survivorPct) ? null : Number(form.survivorPct),
          updated_at: now,
        },
        { onConflict: 'household_id' },
      ),
    ]);
    setSaving(false);
    const failed = results.find((r) => r.error);
    if (failed) {
      setError(failed.error.message);
      return;
    }
    await onSaved();
  }

  const stopAges =
    whole(form.stopYear || suggestedStop || '') &&
    planned
      .filter((p) => whole(p.birthYear))
      .map((p) => `${p.name} ${Number(form.stopYear || suggestedStop) - Number(p.birthYear)}`)
      .join(' · ');

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label="Life plan">
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">Life plan</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">Who it is for, and when work stops</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="ov-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            Each person is planned for until the end of the year they reach the age you give. It is the age to plan to, not a prediction:
            planning a little long is the safer mistake. Leave someone blank to leave them out.
          </div>

          {form.people.map((p) => (
            <div key={p.id} className="te-fieldgrid">
              <div className="te-fieldcell">
                <span className="te-fieldlabel">{p.name} · birth year</span>
                <input
                  className="te-fieldvalue"
                  type="number"
                  inputMode="numeric"
                  min="1900"
                  max={thisYear}
                  value={p.birthYear}
                  onChange={(e) => setPerson(p.id, 'birthYear', e.target.value)}
                  placeholder="e.g. 1994"
                  aria-label={`${p.name}'s birth year`}
                />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Plan to age</span>
                <input
                  className="te-fieldvalue"
                  type="number"
                  inputMode="numeric"
                  min="40"
                  max="120"
                  value={p.lifeExpectancy}
                  onChange={(e) => setPerson(p.id, 'lifeExpectancy', e.target.value)}
                  placeholder="e.g. 85"
                  aria-label={`Age to plan ${p.name} to`}
                />
              </div>
            </div>
          ))}

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Stop working in</span>
              <input
                className="te-fieldvalue"
                type="number"
                inputMode="numeric"
                min={thisYear}
                value={form.stopYear}
                onChange={(e) => set('stopYear', e.target.value)}
                placeholder={suggestedStop ? String(suggestedStop) : 'year'}
                aria-label="Stop working in"
              />
              {stopAges && <span className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{stopAges}</span>}
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Spending a year after work stops · AED, today&rsquo;s money</span>
              <input
                className="te-fieldvalue"
                type="number"
                min="0"
                step="100"
                value={form.spend}
                onChange={(e) => set('spend', e.target.value)}
                placeholder="blank: today's, less what stops"
                aria-label="Spending a year after work stops"
              />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Return after work stops · % a year</span>
              <input
                className="te-fieldvalue"
                type="number"
                step="0.1"
                value={form.returnPct}
                onChange={(e) => set('returnPct', e.target.value)}
                placeholder="blank: same as before"
                aria-label="Return after work stops"
              />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Spending for one · % of two</span>
              <input
                className="te-fieldvalue"
                type="number"
                min="10"
                max="100"
                step="5"
                value={form.survivorPct}
                onChange={(e) => set('survivorPct', e.target.value)}
                placeholder="blank: 100%"
                aria-label="Spending once one person remains"
              />
            </div>
          </div>

          {spendCategories.length > 0 && (
            <div>
              <span className="te-fieldlabel">Stops when work stops</span>
              <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 6 }}>
                Spending you expect to have ended by then: rent on a home you will own, instalments on a loan that will be paid off. Left
                blank above, spending after work stops is today&rsquo;s less these.
              </div>
              <div className="lp-stop-list" style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                {spendCategories.map((c) => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={stops.has(c.id)} onChange={() => toggleStop(c.id)} />
                    <span>{c.name}</span>
                    {spendByCategory.get(c.id) > 0 && <span className="ov-muted fig" style={{ fontSize: 11.5 }}>{formatMoney(spendByCategory.get(c.id))} a year</span>}
                    {!stops.has(c.id) && USUALLY_STOPS.test(c.name) && <span className="ov-muted" style={{ fontSize: 11.5 }}>· often stops</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            The return is before inflation, like the one in Forecast&rsquo;s assumptions, and moves with the scenario. Spending for one applies
            once only one person is still planned for.
          </div>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              <div className="te-actions-right">
                {confirmingClose ? (
                  <>
                    <span className="ov-muted" style={{ marginRight: 8 }}>
                      Discard changes?
                    </span>
                    <button type="button" className="om-btn" onClick={onClose}>
                      Discard
                    </button>
                    <button type="button" className="om-btn" onClick={() => setConfirmingClose(false)}>
                      Keep editing
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="om-btn" onClick={requestClose}>
                      Cancel
                    </button>
                    <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : 'Save plan'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
