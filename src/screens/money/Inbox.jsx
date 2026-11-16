import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { INTAKE_SOURCE_LABELS, approvalArgs } from '../../lib/intake';
import { householdToday, parseDay } from '../../lib/day';
import { neverLoaded } from '../../lib/loadState';
import { readsCleanly, undatedBatches } from '../../lib/inboxBatches';
import { alreadyRecordedAll } from '../../lib/alreadyRecorded';
import { Card, Chip, EmptyState } from '../../design-system/kit';
import Withheld from '../planning/Withheld';
import InboxDetail from './InboxDetail';
import { Tools } from './MoneyTools';
import { ago, isConfident } from './inboxText';
import './TransactionEditor.css';
import './Inbox.css';

// The Inbox, as the prototype lays it out (the revamp, phase 4c;
// design/prototype Inbox; review S-inbox-1 to 9): what waits, newest first,
// beside the message chosen and what was read from it. Bulk approval sits in
// the page header; the undated entries of one message are dated together
// above the list.

function senderName(item, members) {
  if (!item.member_id) return null;
  return members.find((m) => m.id === item.member_id)?.display_name ?? null;
}

// Two pending intake rows for the same merchant/amount, within a few days of
// each other -- e.g. sent the same expense to the bot twice by accident.
// Intake has no account yet at this stage, so this only compares
// merchant/amount/date, unlike the post-approval duplicate check.
const PENDING_DUPLICATE_WINDOW_DAYS = 3;
function findDuplicatePending(item, otherPending) {
  const merchant = (item.parsed_merchant ?? '').trim().toLowerCase();
  const amount = item.parsed_amount !== null ? Number(item.parsed_amount) : null;
  if (!merchant || !amount || !item.parsed_date) return null;
  const occurred = new Date(item.parsed_date).getTime();
  return (
    otherPending.find((o) => {
      if (o.id === item.id) return false;
      if ((o.parsed_merchant ?? '').trim().toLowerCase() !== merchant) return false;
      if (o.parsed_amount === null || Math.abs(Number(o.parsed_amount) - amount) > 0.01) return false;
      if (!o.parsed_date) return false;
      const diffDays = Math.abs(new Date(o.parsed_date).getTime() - occurred) / 86400000;
      return diffDays <= PENDING_DUPLICATE_WINDOW_DAYS;
    }) ?? null
  );
}

// The undated entries of one message, and the one date to approve them on.
// The field starts empty: the day the message was sent is only when it was
// pasted, so it is not offered as the answer.
function UndatedBatch({ batch, leftOut = 0, disabled, onApprove }) {
  const [date, setDate] = useState('');
  // The picker stops at today; a day typed past it is not taken either.
  const usable = date !== '' && date <= householdToday();
  const n = batch.items.length;
  const sent = parseDay(batch.sentOn).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <div className="ds-card ib-batch" role="group" aria-label={`${n} entries with no date`}>
      <div>
        <div>{`${n} entries from one message, sent ${sent}, have no date.`}</div>
        <div className="ib-note ib-batch-note">
          {`Give the day they were paid to approve them together: ${batch.items.map((i) => i.parsed_merchant).filter((m, k, all) => all.indexOf(m) === k).slice(0, 3).join(', ')}. Paid on different days? Open each one instead.`}
          {leftOut > 0 && ` ${leftOut} more ${leftOut === 1 ? 'looks' : 'look'} already recorded and ${leftOut === 1 ? 'is' : 'are'} left out.`}
        </div>
      </div>
      <div className="ib-batch-actions">
        <input type="date" className="ds-select" aria-label={`Paid on, for these ${n} entries`} value={date} max={householdToday()} onChange={(e) => setDate(e.target.value)} />
        <button type="button" className="ds-btn" disabled={disabled || !usable} onClick={() => onApprove(batch, date)}>
          {`Approve ${n} on this date`}
        </button>
      </div>
    </div>
  );
}

export default function Inbox({ household = null, members = [], accounts, categories, data, loading }) {
  const { intake, categoryRules, transactions, reload } = data;
  const [selectedId, setSelectedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  // The selected message's Approve and Reject, for the keys (InboxDetail).
  const actionsRef = useRef(null);
  // What the keys move through, as last drawn.
  const listRef = useRef({ ids: [], selected: null });
  // A approves, R rejects, the arrows move (review S-inbox-7). Typed into a
  // field, or with an editor open over the page, they are just keys.
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const { ids, selected } = listRef.current;
      if (ids.length === 0) return;
      const at = Math.max(0, ids.indexOf(selected));
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        const to = ids[at + (key === 'ArrowDown' ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        setSelectedId(to);
      } else if (key === 'a') {
        actionsRef.current?.approve();
      } else if (key === 'r') {
        actionsRef.current?.reject();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!data.intake) return;
    const ids = [...data.intake.filter((i) => i.status === 'pending')].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((i) => i.id);
    listRef.current = { ids, selected: ids.includes(selectedId) ? selectedId : (ids[0] ?? null) };
  });

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  // An inbox that never loaded is not an empty one: it read "Inbox zero" with
  // captures waiting (round 2 of the outside review, E2-3).
  const missing = neverLoaded(data, ['intake']);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={reload}>
        What&rsquo;s waiting for review isn&rsquo;t shown, rather than shown as nothing.
      </Withheld>
    );
  }

  // Newest first, so the latest arrival leads.
  const pending = [...intake.filter((i) => i.status === 'pending')].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const selected = pending.find((i) => i.id === selectedId) ?? pending[0] ?? null;
  const confident = pending.filter(isConfident);
  // Dated the day they were sent to the bot; each waits for its real date.
  const undated = pending.filter((i) => i.date_guessed);
  // Undated entries that repeat a record already made (lib/alreadyRecorded.js):
  // marked, left out of the batch date, and set aside together. Oldest first,
  // so where two entries could repeat one record, the one sent first is the
  // copy.
  const recordedById = alreadyRecordedAll([...pending].reverse(), transactions ?? [], intake);
  const batches = undatedBatches(pending.filter((i) => !recordedById.has(i.id)));
  // Only those the batch would otherwise have held.
  const recordedIn = (batch) => pending.filter((i) => recordedById.has(i.id) && readsCleanly(i) && String(i.source_ref ?? '').split('#')[0] === batch.key).length;

  // Rejected, each only if still waiting, so it cannot undo an approval made
  // meanwhile. Kept in the Inbox's history as rejected, as "Not a spend" does.
  async function setAsideRecorded() {
    setBulkSaving(true);
    setError('');
    for (const id of recordedById.keys()) {
      const { error: updError } = await supabase.from('intake').update({ status: 'rejected' }).eq('id', id).eq('status', 'pending');
      if (updError) setError(updError.message);
    }
    setBulkSaving(false);
    setSelectedId(null);
    await reload();
  }

  // The entries of one message, approved on the one date a person gave for
  // them, which is what confirms it (approve_intake refuses a guessed date
  // otherwise). One failure never blocks the rest.
  async function approveBatch(batch, date) {
    setBulkSaving(true);
    setError('');
    for (const item of batch.items) {
      const form = { accountId: item.parsed_account_id, amount: item.parsed_amount, date, dateGuessed: true, dateConfirmed: true, kind: item.parsed_kind ?? 'expense', categoryId: item.parsed_category_id, currency: 'AED', merchant: item.parsed_merchant, isShared: true, ownerMemberId: null };
      const { error: rpcError } = await supabase.rpc('approve_intake', approvalArgs(item, form));
      if (rpcError) setError(`${item.parsed_merchant}: ${rpcError.message}`);
    }
    setBulkSaving(false);
    setSelectedId(null);
    await reload();
  }

  async function approveConfident() {
    setBulkSaving(true);
    setError('');
    for (const item of confident) {
      // No dateConfirmed: nobody looked at these. isConfident leaves out a
      // guessed date, and approve_intake would refuse one anyway.
      const form = {
        accountId: item.parsed_account_id,
        amount: item.parsed_amount,
        date: item.parsed_date,
        // Trusts the parser's own classification (SHR-282) -- a confidently-
        // parsed salary credit bulk-approved here must not silently become a
        // negative expense just because this was never asked interactively.
        kind: item.parsed_kind ?? 'expense',
        categoryId: item.parsed_category_id,
        currency: 'AED',
        merchant: item.parsed_merchant,
        isShared: true,
        ownerMemberId: null,
      };
      // One failure must never block the rest -- each item approves
      // independently, same as the Telegram fast-confirm path.
      const { error: rpcError } = await supabase.rpc('approve_intake', approvalArgs(item, form));
      if (rpcError) setError(`${item.parsed_merchant}: ${rpcError.message}`);
    }
    setBulkSaving(false);
    setSelectedId(null);
    await reload();
  }

  // After an approval or a rejection the next message is chosen, so the
  // list is worked from the top down without reaching for it.
  const next = (id) => {
    const at = pending.findIndex((i) => i.id === id);
    return (pending[at + 1] ?? pending[at - 1] ?? null)?.id ?? null;
  };

  return (
    <div className="ib">
      <Tools>
        {recordedById.size > 0 && (
          <button type="button" className="ds-btn" disabled={bulkSaving} onClick={setAsideRecorded}>
            {`Set aside ${recordedById.size} already recorded`}
          </button>
        )}
        {/* Offered only when something read cleanly; the list says how many. */}
        {confident.length > 0 && (
          <button type="button" className="ds-btn" disabled={bulkSaving} onClick={approveConfident}>
            {bulkSaving ? 'Approving…' : `Approve ${confident.length} read cleanly`}
          </button>
        )}
      </Tools>

      {batches.map((batch) => (
        <UndatedBatch key={batch.key} batch={batch} leftOut={recordedIn(batch)} disabled={bulkSaving} onApprove={approveBatch} />
      ))}

      {pending.length === 0 ? (
        <Card>
          <EmptyState title="Inbox zero" body="Nothing waiting on review. Approved items appear in Activity straight away." />
        </Card>
      ) : (
        <div className="ib-panes">
          <Card
            title="Waiting"
            className="ib-list-card"
            flush
            right={<span className="ib-note">{`${confident.length} read cleanly${undated.length ? ` · ${undated.length} with no date` : ''}`}</span>}
          >
            <ul className="ib-list" aria-label="Waiting">
              {pending.map((i) => (
                <li key={i.id}>
                  <button type="button" className="ib-row-btn" aria-pressed={selected?.id === i.id} data-on={selected?.id === i.id || undefined} onClick={() => setSelectedId(i.id)}>
                    <span className="ib-tag">{i.photo_path ? 'photo' : 'text'}</span>
                    <span className="ib-row-main">
                      <span className="ib-row-top">
                        <span className="ib-row-name">{i.parsed_merchant || 'Unrecognised merchant'}</span>
                        <span className="ib-row-amt">
                          {i.parsed_amount === null ? '—' : i.parsed_currency && i.parsed_currency !== 'AED' ? `${i.parsed_currency} ${formatMoney(i.parsed_amount)}` : `−${formatMoney(i.parsed_amount)}`}
                        </span>
                      </span>
                      <span className="ib-row-sub">
                        <span>
                          {senderName(i, members) ?? INTAKE_SOURCE_LABELS[i.source] ?? 'Unknown sender'} · {ago(i.created_at)}
                        </span>
                        {recordedById.has(i.id) ? (
                          <Chip tone="warn" title="The same amount on the same card, recorded in the two weeks before it was sent">
                            Already recorded
                          </Chip>
                        ) : i.date_guessed ? (
                          <Chip tone="warn" title="Not in the message: dated the day it was sent">
                            No date
                          </Chip>
                        ) : isConfident(i) ? (
                          <Chip tone="pos">Read cleanly</Chip>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {selected && (
            <InboxDetail
              key={selected.id}
              item={selected}
              sender={senderName(selected, members)}
              accounts={accounts}
              members={members}
              categories={categories}
              categoryRules={categoryRules}
              allTransactions={transactions ?? []}
              rates={{ history: data.fxRateHistory ?? [], current: household?.inr_per_aed ?? null }}
              duplicatePending={findDuplicatePending(selected, pending)}
              recorded={recordedById.get(selected.id) ?? null}
              saving={saving}
              setSaving={setSaving}
              error={error}
              setError={setError}
              actionsRef={actionsRef}
              onDone={async () => {
                setSelectedId(next(selected.id));
                setError('');
                await reload();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
