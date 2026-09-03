// Merchant-pattern rules for auto-categorization — a suggestion while
// reviewing intake, or a bulk backfill onto existing uncategorised
// transactions. Never overwrites a category someone already chose.
export function matchesRule(merchant, rule) {
  if (!merchant) return false;
  const m = merchant.toLowerCase();
  const p = rule.pattern.toLowerCase();
  return rule.match_type === 'starts_with' ? m.startsWith(p) : m.includes(p);
}

export function firstMatchingRule(merchant, rules) {
  return rules.find((r) => !r.archived && matchesRule(merchant, r)) ?? null;
}

// Supabase .ilike() pattern equivalent to a rule's match, for a server-side
// bulk backfill without pulling every transaction down to filter client-side.
export function ilikePattern(rule) {
  const escaped = rule.pattern.replace(/[%_]/g, (c) => `\\${c}`);
  return rule.match_type === 'starts_with' ? `${escaped}%` : `%${escaped}%`;
}
