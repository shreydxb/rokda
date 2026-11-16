import { readsCleanly } from '../../lib/inboxBatches';

// What the Inbox says about a message (the revamp, phase 4c), shared by its
// list and the selected message.

// "3m ago", "2h ago", "4d ago".
export function ago(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Safe to approve unseen: read cleanly and dated by the message itself, the
// bar "Approve N read cleanly" approves to (lib/inboxBatches.js readsCleanly).
export function isConfident(item) {
  return readsCleanly(item) && !item.date_guessed;
}

// The chip beside "What was read": read cleanly; or fields to check, when a
// value was not read or the date is the day it was sent; or, with every
// value found but the reading under the bar, that the bot was unsure (the
// audit, November 2026: it said "Check the flagged rows" with none flagged).
export function readsCleanlyFor(item) {
  if (isConfident(item)) return { label: 'Read cleanly', tone: 'pos' };
  const missing = !item.parsed_merchant || item.parsed_amount === null || !item.parsed_account_id || !item.parsed_category_id || !!item.date_guessed;
  return { label: missing ? 'Check the marked fields' : 'Not sure it read this right', tone: 'warn' };
}
