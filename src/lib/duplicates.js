const DAY_MS = 24 * 60 * 60 * 1000;

// A record like this already exists — same account, same merchant, same
// amount, within a few days. Shared by the manual transaction form and the
// Inbox review screen so a likely duplicate is caught the same way
// regardless of how the entry was created.
export function findDuplicate(form, allTransactions, excludeId) {
  const merchant = form.merchant.trim().toLowerCase();
  const amount = Number(form.amount);
  if (!merchant || !amount || !form.account_id || !form.occurred_at) return null;
  const occurred = new Date(form.occurred_at).getTime();

  return (
    allTransactions.find((t) => {
      if (t.id === excludeId) return false;
      if (t.account_id !== form.account_id) return false;
      if ((t.merchant ?? '').trim().toLowerCase() !== merchant) return false;
      if (Math.abs(Math.abs(Number(t.amount)) - amount) > 0.01) return false;
      const diffDays = Math.abs(new Date(t.occurred_at).getTime() - occurred) / DAY_MS;
      return diffDays <= 3;
    }) ?? null
  );
}
