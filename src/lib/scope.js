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
export function scopedValue(value, { isShared, ownerMemberId }, scopeMemberId) {
  const v = Number(value) || 0;
  if (scopeMemberId === null) return v;
  if (isShared) return v / 2;
  if (ownerMemberId === scopeMemberId) return v;
  return 0;
}
