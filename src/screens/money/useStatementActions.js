import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';

// What the card statements table writes (screens/money/StatementsTable.jsx),
// kept apart so the "Mark n done" button can sit wherever the screen puts it
// and share the table's ticks.

// What each status says, and its chip's tone, wherever a statement is listed
// (Month end's table, a card's Statements tab on Net worth).
export const STATEMENT_STATUS = {
  unchecked: { label: 'To check', tone: 'warn' },
  waiting: { label: 'Waiting', tone: 'neutral' },
  mismatch: { label: 'Doesn’t match', tone: 'neg' },
  confirmed: { label: 'Done', tone: 'pos' },
  reconciled: { label: 'Reconciled', tone: 'pos' },
};

// Marking done answers a statement nobody has looked at, or one the bot is
// asking about. One that doesn't match asks what was done about it, so it is
// resolved on its own, never ticked with the rest.
export const canMarkDone = (row) => row.status === 'unchecked' || row.status === 'waiting';
export const keyOf = (row) => `${row.account.id}:${row.statementDate}`;
export const shortDate = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep');
export const nameOf = (row) => `${row.account.name}, ${shortDate(row.periodStart)} to ${shortDate(row.statementDate)}`;

// Settles a statement ('confirmed') or opens it again ('waiting'), with who
// did it and, when given, why. Only a write that changed the row counts: one
// that matched nothing (changed elsewhere, or not allowed) says so. An update
// applies only while the statement still has the status on screen: the bot
// may have recorded a mismatch since, which Mark done must not settle unseen
// (the fresh review of 4d).
async function writeStatus(household, me, row, next, why = '') {
  const payload =
    next === 'waiting' ? { status: 'waiting', closed_at: null, closed_by_member_id: null } : { status: 'confirmed', closed_at: new Date().toISOString(), closed_by_member_id: me?.id ?? null };
  if (why.trim()) payload.note = why.trim();
  if (row.record) {
    const { data: saved, error } = await supabase.from('statement_reconciliations').update(payload).eq('id', row.record.id).eq('status', row.status).select('id');
    return error?.message ?? ((saved ?? []).length === 0 ? 'Nothing was saved: this statement may have changed elsewhere. Reload the page and try again.' : null);
  }
  const { error } = await supabase.from('statement_reconciliations').insert({
    household_id: household.id,
    account_id: row.account.id,
    statement_date: row.statementDate,
    period_start: row.periodStart,
    due_date: row.dueDate,
    ...payload,
  });
  return error?.message ?? null;
}

export function useStatementActions({ household, me, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ticked, setTicked] = useState(() => new Set());

  const toggle = (row) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(keyOf(row))) next.delete(keyOf(row));
      else next.add(keyOf(row));
      return next;
    });

  // One statement. True once it is saved and the records are read again.
  const setStatus = async (row, next, why = '') => {
    setBusy(true);
    setError(null);
    const failed = await writeStatus(household, me, row, next, why);
    setBusy(false);
    if (failed) {
      setError(failed);
      return false;
    }
    setTicked((prev) => {
      const left = new Set(prev);
      left.delete(keyOf(row));
      return left;
    });
    await reload();
    return true;
  };

  // Several at once. Each is its own write; the ones that fail are named and
  // stay ticked, and the records are read again once if any were saved.
  const markDone = async (rows) => {
    setBusy(true);
    setError(null);
    const results = await Promise.all(rows.map(async (row) => ({ row, failed: await writeStatus(household, me, row, 'confirmed') })));
    setBusy(false);
    const failures = results.filter((r) => r.failed);
    if (failures.length) setError(failures.map((r) => `${nameOf(r.row)}: ${r.failed}`).join(' · '));
    const saved = new Set(results.filter((r) => !r.failed).map((r) => keyOf(r.row)));
    setTicked((prev) => new Set([...prev].filter((k) => !saved.has(k))));
    if (saved.size) await reload();
  };

  return { busy, error, ticked, toggle, setStatus, markDone };
}
