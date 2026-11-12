import { supabase } from '../../lib/supabaseClient';
import { rememberMerchantCheck } from '../../lib/rules';

// Adds a household rule for a merchant once its record is saved (the Inbox's
// "Remember this merchant"). The household's rules are read again first, so
// a rule added meanwhile, by the other person or by an attempt whose answer
// was lost, isn't added twice. Returns what happened:
// 'added', 'duplicate' (a rule already files it there), 'conflict' (a rule
// files it elsewhere, and being earlier would keep winning), or 'failed'
// with the reason.
export async function addMerchantRule({ householdId, merchant, proposal }) {
  const { data: rules, error: readError } = await supabase.from('category_rules').select('*').eq('household_id', householdId).order('created_at').order('id');
  if (readError) return { status: 'failed', reason: `the household’s rules couldn’t be read: ${readError.message}` };
  const check = rememberMerchantCheck(merchant, proposal, rules ?? []);
  if (check.status === 'duplicate' || check.status === 'conflict') return check;
  if (check.status !== 'new') return { status: 'failed', reason: check.reason };
  const { error: insertError } = await supabase
    .from('category_rules')
    .insert({ household_id: householdId, pattern: check.rule.pattern, match_type: check.rule.match_type, category_id: check.rule.category_id })
    .select('id')
    .single();
  if (insertError) return { status: 'failed', reason: insertError.message };
  return { status: 'added', rule: check.rule };
}
