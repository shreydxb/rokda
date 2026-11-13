// Inbox entries that can be approved together.

// Every field an approval takes is already resolved, with no guesswork, and
// the parser was confident about it: the bar the Telegram fast-confirm path
// uses (isReadyForFastConfirm in the bot). Its date is a separate question:
// see the Inbox's isConfident, and undatedBatches below.
export function readsCleanly(item) {
  return (
    !!item.parsed_merchant &&
    item.parsed_amount !== null &&
    Number(item.parsed_amount) > 0 &&
    !!item.parsed_date &&
    !!item.parsed_category_id &&
    !!item.parsed_account_id &&
    (item.parsed_currency == null || item.parsed_currency === 'AED') &&
    Number(item.confidence ?? 0) >= 0.85
  );
}

// Bank SMS pasted several at a time carry no dates, and each entry then
// waited for its own (the feature review, November 2026). The undated
// entries of one Telegram message that read cleanly otherwise are offered
// together, for one date said once by a person. The bot numbers a message's
// entries "<update>", "<update>#1", "<update>#2". One entry alone is dated
// in its editor, as before.
export function undatedBatches(pending = []) {
  const groups = new Map();
  for (const item of pending) {
    if (item.source !== 'telegram' || !item.source_ref || !item.date_guessed || !readsCleanly(item)) continue;
    const key = String(item.source_ref).split('#')[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    // The day the message was sent, which is what the bot dated them.
    .map(([key, items]) => ({ key, sentOn: items[0].parsed_date, items }));
}
