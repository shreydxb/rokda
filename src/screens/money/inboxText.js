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

// The chip beside "What was read", from the form as it stands: fields to
// check while one is empty or the date is the day the message was sent; read
// cleanly; or, with every field filled but the reading under the bar, that
// the bot was unsure (the audit, November 2026, and the fresh review of 4c:
// it asked to check marked fields when none was marked).
export function readingChip(item, { filled, dateSettled }) {
  if (!filled || (item.date_guessed && !dateSettled)) return { label: 'Check the marked fields', tone: 'warn' };
  if (isConfident(item)) return { label: 'Read cleanly', tone: 'pos' };
  return { label: 'Not sure it read this right', tone: 'warn' };
}
