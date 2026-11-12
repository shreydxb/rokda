// The goal editor's form, as data: what it opens with, what is wrong with
// it, the row a save writes, and what a link to an account or holding may
// be. Moved out of screens/planning/GoalEditor.jsx (the round 2 cleanup,
// SHR-383).
import { isArchived } from './accounts';

export function initialForm(goal) {
  if (goal) {
    return {
      name: goal.name,
      note: goal.note ?? '',
      target_amount: String(goal.target_amount ?? ''),
      target_date: goal.target_date ?? '',
      funding_source: goal.funding_source ?? '',
      owner: goal.is_shared ? 'shared' : (goal.owner_member_id ?? ''),
      cost_today: !!goal.cost_today,
      inflation_pct: goal.inflation_pct != null ? String(Number(goal.inflation_pct)) : '',
      priority: goal.priority != null ? String(goal.priority) : '',
      kept: goal.counts_in_life_plan === false,
      planned_monthly: goal.planned_monthly != null ? String(Number(goal.planned_monthly)) : '',
    };
  }
  return { name: '', note: '', target_amount: '', target_date: '', funding_source: '', owner: 'shared', cost_today: false, inflation_pct: '', priority: '', kept: false, planned_monthly: '' };
}

// What is wrong with each field, or '' when nothing is. The rise is read
// only for a cost given in today's money.
export function goalProblems(form) {
  const rateText = String(form.inflation_pct).trim();
  const priorityText = String(form.priority).trim();
  const plannedText = String(form.planned_monthly).trim();
  return {
    name: form.name.trim() === '' ? 'Name it.' : '',
    target: !form.target_amount || Number(form.target_amount) <= 0 ? 'Set a target above zero.' : '',
    rate: form.cost_today && rateText !== '' && !(Number.isFinite(Number(rateText)) && Number(rateText) >= -10 && Number(rateText) <= 30) ? 'A yearly rise between −10% and 30%.' : '',
    priority: priorityText !== '' && !(/^\d+$/.test(priorityText) && Number(priorityText) >= 1 && Number(priorityText) <= 999) ? 'Priority is a whole number from 1.' : '',
    planned: plannedText !== '' && !(Number.isFinite(Number(plannedText)) && Number(plannedText) >= 0) ? 'A monthly amount of 0 or more, or blank for no plan.' : '',
  };
}

// The row a save writes.
export function goalPayload(form, householdId) {
  const rateText = String(form.inflation_pct).trim();
  const priorityText = String(form.priority).trim();
  const plannedText = String(form.planned_monthly).trim();
  return {
    household_id: householdId,
    name: form.name.trim(),
    note: form.note.trim(),
    target_amount: Number(form.target_amount),
    target_date: form.target_date || null,
    funding_source: form.funding_source.trim(),
    is_shared: form.owner === 'shared',
    owner_member_id: form.owner === 'shared' ? null : form.owner,
    cost_today: form.cost_today,
    inflation_pct: form.cost_today && rateText !== '' ? Number(rateText) : null,
    priority: priorityText === '' ? null : Number(priorityText),
    // Kept money, an emergency fund, is never paid out of the Life plan's
    // pot. Only the Life plan could set this (Planning audit, 1.6).
    counts_in_life_plan: !form.kept,
    // What the household means to put towards it a month; blank is no
    // plan, and 0 is a plan of nothing (Planning audit, 2.7).
    planned_monthly: plannedText === '' ? null : Number(plannedText),
  };
}

// The database's own wording for a link it refuses names neither the account
// nor what to do instead.
export function linkErrorMessage(err) {
  if (err?.code === '23514' && /exceed 100%/.test(err.message ?? '')) {
    const already = /already ([\d.]+)/.exec(err.message)?.[1];
    return `That would link more than 100% of it to goals${already ? `: ${Number(already)}% is already linked to other goals` : ''}. Lower the share.`;
  }
  if (err?.code === '23505') return 'This goal already links it. Change the share on its row instead.';
  return err?.message ?? 'That did not save.';
}

// The database takes any share above 0 and up to 100, fractions included.
export const shareProblem = (text) => {
  const pct = Number(text);
  return String(text ?? '').trim() !== '' && Number.isFinite(pct) && pct > 0 && pct <= 100 ? '' : 'A share above 0 and up to 100%.';
};

// Why a link made before loans, cards and closed accounts were refused now counts for nothing.
export function linkCountsAsNothing(account) {
  if (!account) return 'the account is gone';
  if (isArchived(account)) return 'the account is closed';
  if (account.type === 'loan') return 'a loan is owed, not saved';
  return 'a card is owed, not saved';
}
