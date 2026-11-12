import { useState } from 'react';
import { supabase } from './supabaseClient';
import { unvaluedAccounts } from './accounts';
import { isAwaitingFirstValuation } from './valuation';
import { closeRowFor, pendingClose } from './snapshots';
import { incompleteNote, netWorthSummary } from '../screens/overviewMath';

// Closing the month just ended: the household's totals recorded as that
// month's point in the net worth history. Net worth and the monthly review
// both offer it (screens/wealth/MonthCloseForm.jsx); it used to be reached
// only from Net worth, and no month was ever closed (the feature review,
// November 2026).
//
// Closing is a two-step, explicit act (SHR-246): `open` only shows what
// would be written, today's live totals, offered as a starting point, not a
// fact yet. Nothing is written until `confirm` is pressed on those (possibly
// edited) numbers. They are kept as raw strings, not coerced numbers, so a
// blank field or a stray character is a validation error instead of silently
// becoming zero.
export function useMonthClose({ householdId, accounts, holdings, netWorthSnapshots, now, onClosed }) {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const pending = pendingClose(netWorthSnapshots, now);
  const monthLabel = pending ? pending.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '';

  // A total with gaps (an account not converted, a holding never valued) is
  // not offered at all: confirming it as it stands would put a partial
  // balance sheet into the history for good. The fields start empty, and the
  // month stays open, saying why, until the gaps are fixed or someone types
  // what the month actually closed at (docs/decisions.md, "A month closes on
  // complete totals"). The close is the household's, whoever is selected.
  const unvalued = unvaluedAccounts(accounts);
  const unpriced = holdings.filter(isAwaitingFirstValuation);
  const gaps = { accounts: unvalued.length, holdings: unpriced.length };
  const gapNames = [...unvalued, ...unpriced].map((r) => r.name).join(', ');

  function open() {
    if (!pending) return;
    if (incompleteNote(gaps)) {
      setDraft({ assets: '', liabilities: '' });
      return;
    }
    const householdWide = netWorthSummary(accounts, null, holdings);
    setDraft({ assets: String(householdWide.assets), liabilities: String(householdWide.liabilities) });
  }

  const assets = draft ? Number(draft.assets) : null;
  const liabilities = draft ? Number(draft.liabilities) : null;
  const assetsError = draft && (draft.assets.trim() === '' || !Number.isFinite(assets)) ? 'Enter a number.' : null;
  const liabilitiesError = draft && (draft.liabilities.trim() === '' || !Number.isFinite(liabilities)) ? 'Enter a number.' : null;
  const valid = !!draft && !assetsError && !liabilitiesError;

  // Upserting on (household_id, snapshot_date) with ignoreDuplicates means
  // closing the same month twice from the same session changes nothing — but
  // it also means a second, stale session cannot silently overwrite a month
  // another session already closed with different numbers. Whoever closes it
  // first wins; a later attempt is a no-op, not a clobber — and .select()
  // lets that no-op be told apart from a real write, so a stale session is
  // told plainly rather than reloading as if its numbers had been saved.
  async function confirm() {
    if (!pending || !householdId || !valid) return;
    setClosing(true);
    setError(null);
    const { data, error: writeError } = await supabase
      .from('net_worth_snapshots')
      .upsert(closeRowFor(householdId, pending.snapshotDate, { assets, liabilities }), {
        onConflict: 'household_id,snapshot_date',
        ignoreDuplicates: true,
      })
      .select();
    setClosing(false);
    if (writeError) {
      setError(writeError.message);
      return;
    }
    if (!data || data.length === 0) {
      setError(`${monthLabel} was already closed by another session. Your values were not saved — reload to see what was recorded.`);
      return;
    }
    setDraft(null);
    await onClosed();
  }

  return { pending, monthLabel, draft, setDraft, open, cancel: () => setDraft(null), confirm, closing, error, valid, assetsError, liabilitiesError, gaps, gapNames };
}
