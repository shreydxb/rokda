// When a price provider says a price was quoted, as an ISO timestamp for
// holdings.priced_at (price-refresh). How old a price is comes from here, not
// from when Rokda fetched it, so a stale quote reads as stale.

// A provider's quote time in seconds since the epoch, as an ISO timestamp.
// Missing, malformed or more than an hour in the future reads as unknown.
export function quoteTime(seconds: unknown, now = Date.now()): string | null {
  const s = Number(seconds);
  if (seconds == null || seconds === "" || !Number.isFinite(s) || s <= 0) return null;
  const ms = s * 1000;
  if (ms > now + 3_600_000) return null;
  return new Date(ms).toISOString();
}

// mfapi dates a NAV "dd-mm-yyyy", for the Indian trading day. Read as that
// day's market close (15:30 IST), the time the NAV is struck against.
export function navQuoteTime(date: unknown, now = Date.now()): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date ?? ""));
  if (!m) return null;
  const at = new Date(`${m[3]}-${m[2]}-${m[1]}T15:30:00+05:30`);
  if (Number.isNaN(at.getTime())) return null;
  return quoteTime(at.getTime() / 1000, now);
}
