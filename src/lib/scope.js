// Resolves the sidebar Both/Me/Partner toggle to a concrete household_member id
// (or null for "both"). 'partner' with no second member yet resolves to a
// sentinel that matches nothing, rather than silently falling back to "both".
const NO_PARTNER = '__no_partner__';

export function resolveScopeMemberId(scope, me, members) {
  if (scope === 'me') return me?.id ?? null;
  if (scope === 'partner') {
    const partner = members.find((m) => m.id !== me?.id);
    return partner?.id ?? NO_PARTNER;
  }
  return null;
}

// Shared/joint rows split evenly between the two individual scopes, so
// Me + Partner reconciles exactly to Both rather than double-counting.
// Takes the raw row (transaction, account, ...) as fetched from Supabase —
// snake_case is_shared/owner_member_id, matching the Postgres columns.
export function scopedValue(value, row, scopeMemberId) {
  const v = Number(value) || 0;
  if (scopeMemberId === null) return v;
  if (row.is_shared) return v / 2;
  if (row.owner_member_id === scopeMemberId) return v;
  return 0;
}
