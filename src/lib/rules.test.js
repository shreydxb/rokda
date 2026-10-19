import { describe, it, expect } from 'vitest';
import { firstMatchingRule, rememberMerchantCheck, ruleLabel } from './rules';
// The bot's own copy of how a new expense is categorised, so a remembered
// merchant is checked against the path a Telegram message takes too.
import { pickCategory } from '../../supabase/functions/_shared/applib/merchants.js';

const GROCERIES = 'cat-groceries';
const DINING = 'cat-dining';
const rule = (id, pattern, category_id, extra = {}) => ({ id, pattern, match_type: 'contains', category_id, archived: false, ...extra });

describe('rememberMerchantCheck', () => {
  it('proposes the rule as entered, trimmed, when no active rule matches the merchant', () => {
    expect(rememberMerchantCheck('Corner Market 12', { pattern: '  Corner Market 12 ', match_type: 'contains', category_id: GROCERIES }, [])).toEqual({
      status: 'new',
      rule: { pattern: 'Corner Market 12', match_type: 'contains', category_id: GROCERIES },
    });
  });

  it('refuses an empty pattern, or one that would not match the merchant itself', () => {
    expect(rememberMerchantCheck('Corner Market', { pattern: ' ', match_type: 'contains', category_id: GROCERIES }).status).toBe('invalid');
    const startsWith = rememberMerchantCheck('Corner Market', { pattern: 'Market', match_type: 'starts_with', category_id: GROCERIES });
    expect(startsWith.status).toBe('invalid');
    expect(startsWith.reason).toContain('doesn’t start with “Market”');
    expect(rememberMerchantCheck('Corner Market', { pattern: 'Market', match_type: 'contains', category_id: GROCERIES }).status).toBe('new');
  });

  it('matches whatever the letter case, as every rule does', () => {
    expect(rememberMerchantCheck('CORNER MARKET', { pattern: 'corner', match_type: 'starts_with', category_id: GROCERIES }).status).toBe('new');
  });

  it('adds nothing when an active rule already files the merchant under the same category', () => {
    const same = rule('r1', 'CORNER MARKET', GROCERIES);
    expect(rememberMerchantCheck('Corner Market', { pattern: 'corner market', match_type: 'contains', category_id: GROCERIES }, [same])).toEqual({ status: 'duplicate', rule: same });
    // A different pattern that changes nothing for this merchant is no new rule either.
    const broader = rule('r2', 'corner', GROCERIES);
    expect(rememberMerchantCheck('Corner Market', { pattern: 'Corner Market', match_type: 'contains', category_id: GROCERIES }, [broader]).status).toBe('duplicate');
  });

  it('reports the rule that would keep winning when it files the merchant elsewhere', () => {
    const other = rule('r1', 'corner', DINING);
    expect(rememberMerchantCheck('Corner Market', { pattern: 'Corner Market', match_type: 'contains', category_id: GROCERIES }, [other])).toEqual({ status: 'conflict', rule: other });
  });

  it('keeps precedence: the earliest matching rule is the one compared', () => {
    const first = rule('r1', 'corner', DINING);
    const second = rule('r2', 'corner market', GROCERIES);
    expect(rememberMerchantCheck('Corner Market', { pattern: 'Corner Market', match_type: 'contains', category_id: GROCERIES }, [first, second])).toEqual({ status: 'conflict', rule: first });
  });

  it('leaves archived rules out, as matching does', () => {
    const archived = rule('r1', 'corner', DINING, { archived: true });
    expect(rememberMerchantCheck('Corner Market', { pattern: 'Corner Market', match_type: 'contains', category_id: GROCERIES }, [archived]).status).toBe('new');
  });

  it('ignores rules that match other merchants', () => {
    expect(rememberMerchantCheck('Corner Market', { pattern: 'Corner Market', match_type: 'contains', category_id: GROCERIES }, [rule('r1', 'cafe', DINING)]).status).toBe('new');
  });
});

describe('ruleLabel', () => {
  it('names a rule as Settings lists it', () => {
    expect(ruleLabel({ pattern: 'corner', match_type: 'contains' })).toBe('Contains “corner”');
    expect(ruleLabel({ pattern: 'corner', match_type: 'starts_with' })).toBe('Starts with “corner”');
  });
});

describe('a remembered merchant on the next entry', () => {
  // The rule exactly as the editor adds it, after the rules that were there.
  const existing = [rule('r1', 'cafe', DINING)];
  const remembered = { id: 'r2', archived: false, ...rememberMerchantCheck('Corner Market', { pattern: 'Corner Market', match_type: 'contains', category_id: GROCERIES }, existing).rule };
  const rules = [...existing, remembered];

  it('is what the bot files a new message under, ahead of history and the model', () => {
    const history = [{ merchant: 'Corner Market', category_id: DINING, uses: 9, last_used: '2026-09-01' }];
    expect(pickCategory('CORNER MARKET 0042 DUBAI ARE', { rules, history })).toEqual({ categoryId: GROCERIES, source: 'rule' });
  });

  it('is what the Inbox suggests for an entry from the same merchant', () => {
    expect(firstMatchingRule('corner market', rules)).toBe(remembered);
    expect(firstMatchingRule('Other shop', rules)).toBeNull();
  });
});
