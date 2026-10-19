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

// What remembering a corrected record's merchant as a rule would do, given the
// household's rules in the order they were written. The earliest active rule
// that matches a merchant decides its category (firstMatchingRule, in the app
// and in the bot alike), so a new rule only changes anything for this merchant
// when no active rule matches it yet:
// - 'invalid': the pattern is empty, or would not match this merchant at all.
// - 'duplicate': an active rule already files this merchant under the chosen
//   category, so there is nothing to add.
// - 'conflict': an active rule files it elsewhere, and being earlier it would
//   keep winning; the household changes that rule in Settings, not here.
// - 'new': the rule to add.
// Archived rules are left out, as they are everywhere else: they no longer
// match anything.
export function rememberMerchantCheck(merchant, { pattern, match_type, category_id }, rules = []) {
  const trimmed = (pattern ?? '').trim();
  if (!trimmed) return { status: 'invalid', reason: 'Enter a merchant pattern.' };
  const proposed = { pattern: trimmed, match_type: match_type === 'starts_with' ? 'starts_with' : 'contains', category_id };
  if (!matchesRule(merchant, proposed)) {
    return {
      status: 'invalid',
      reason: `“${merchant}” doesn’t ${proposed.match_type === 'starts_with' ? 'start with' : 'contain'} “${trimmed}”, so this rule wouldn’t cover it.`,
    };
  }
  const existing = firstMatchingRule(merchant, rules);
  if (existing) return { status: existing.category_id === category_id ? 'duplicate' : 'conflict', rule: existing };
  return { status: 'new', rule: proposed };
}

// "Contains “carrefour”", as the rules list in Settings names a rule.
export function ruleLabel(rule) {
  return `${rule.match_type === 'starts_with' ? 'Starts with' : 'Contains'} “${rule.pattern}”`;
}
