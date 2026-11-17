import { formatMoney } from './money';

// Goals & debts' goal tables (the revamp, phase 6b; design/prototype
// goalsHalf): a card a group, a row a goal, from lib/goals.js goalStatuses.
// Each row has one status chip, with the sentence it rests on for its
// tooltip; the old screen's two lines of words a goal went (the design
// note, trimmed to the prototype).

export const GOAL_GROUPS = [
  {
    kind: 'near',
    title: 'Next 3 years · from cash',
    info: 'Paid from cash: the current, savings and cash accounts linked to a goal or, with none linked, what is logged to it. No growth is assumed.',
  },
  { kind: 'kept', title: 'Kept, not spent · in cash', info: 'Money kept rather than spent, like an emergency fund. Held in cash and never paid out of the plan.' },
  { kind: 'later', title: 'Later · paid by the plan', info: "Paid by the plan from everything you own, in the goal's year, so Plan and this tab agree about it." },
  { kind: 'undated', title: 'No date', info: 'No plan pays for a goal without a date. Set one to plan for it.' },
];

// Each goal's one status (Planning audit, 1.5). A plan that covers a goal
// held in cash by its date settles it (2.7).
export function goalChip(row) {
  if (row.kind === 'undated') return { label: 'No date', tone: 'neutral' };
  if (row.kind === 'later') {
    if (row.state === 'unchecked') return { label: 'Not checked', tone: 'neutral' };
    if (row.state === 'beyond') return { label: 'Beyond the plan', tone: 'neutral' };
    return row.state === 'short' ? { label: `Short in ${row.year}`, tone: 'warn' } : { label: `Paid in ${row.year}`, tone: 'pos' };
  }
  if (row.state === 'covered') return { label: 'Covered', tone: 'pos' };
  if (row.state === 'due') return { label: 'Due', tone: 'warn' };
  if (row.plan?.enough) return { label: 'Planned', tone: 'pos' };
  if (row.plan?.enough === false) return { label: 'Plan short', tone: 'warn' };
  return { label: 'Saving', tone: 'warn' };
}

// What the household plans a month, after the need.
function planLine(row) {
  const { plan } = row;
  if (!plan) return '';
  if (plan.enough) return ` You plan ${formatMoney(plan.amount)}, which covers it.`;
  if (plan.months == null) return ` You plan ${formatMoney(plan.amount)}, which never covers it.`;
  return ` At the ${formatMoney(plan.amount)} you plan, it is covered by ${plan.byLabel}.`;
}

// The sentence a goal's status rests on: the chip's tooltip.
export function goalWhy(row) {
  const planned = row.planned != null ? ` You plan ${formatMoney(row.planned)} a month towards it.` : '';
  if (row.kind === 'undated') return `Not in any plan: set a date to plan for it.${planned}`;
  if (row.kind === 'later') {
    if (row.state === 'unchecked') return `The plan can't check it yet: it needs ages, an account valuation and three months of records or a budget.${planned}`;
    if (row.state === 'short') return `The plan runs short by ${formatMoney(row.short)} in ${row.year}, the year it is due.${planned}`;
    if (row.state === 'beyond') return `The plan ends before ${row.year}, so it does not plan for it. Move its date, or the ages it plans to.${planned}`;
    return `The plan pays it from your savings and investments in ${row.year}.${planned}`;
  }
  const held = row.kind === 'kept' ? 'Kept, not spent, so held in cash' : 'Due within 3 years, so paid from cash';
  if (row.state === 'covered') return `${held}: covered by what is set aside.`;
  if (row.state === 'due') return `${held}: ${formatMoney(row.remaining)} still needed, and its date has arrived.${planLine(row)}`;
  if (row.perMonth) return `${held}: ${formatMoney(row.perMonth)} a month to ${row.byLabel}.${planLine(row)}`;
  return `${held}: ${formatMoney(row.remaining)} still to set aside.${planLine(row)}`;
}

// A goal's row: its target and date, what is saved and as a share, what it
// needs a month and its pace (a goal held in cash only: the plan pays a later
// one from everything), and its status. A pace below the plan, or nothing
// going in, is marked low.
export function goalTableRow(row) {
  const cash = row.kind === 'near' || row.kind === 'kept';
  const target = Number(row.cost) || 0;
  const saved = cash ? row.cash : (row.progress?.saved ?? 0);
  const needs = cash ? (row.perMonth ?? (row.state === 'due' ? row.remaining : null)) : null;
  const pace = cash && row.pace && !row.pace.short && Number.isFinite(row.pace.perMonth) ? row.pace.perMonth : null;
  const planned = row.plan?.amount ?? row.planned ?? null;
  const paceLow = pace !== null && row.state !== 'covered' && (Math.round(pace) <= 0 || (planned > 0 && pace < planned - 0.5));
  return {
    id: row.goal.id,
    goal: row.goal,
    target,
    by: row.goal.target_date ? (row.byLabel ?? null) : null,
    saved,
    share: target > 0 ? Math.max(0, Math.min(1, saved / target)) : 0,
    needs,
    pace,
    paceLow,
    chip: goalChip(row),
    why: goalWhy(row),
  };
}

// The groups in the prototype's order, an empty one left out, each with its
// rows by priority (unnumbered last) then date, and what the group has
// saved, its target and what it needs a month.
export function goalGroups(rows) {
  const byPriority = (a, b) =>
    (a.goal.priority ?? Infinity) - (b.goal.priority ?? Infinity) ||
    String(a.goal.target_date ?? '9999').localeCompare(String(b.goal.target_date ?? '9999')) ||
    String(a.goal.name).localeCompare(String(b.goal.name));
  return GOAL_GROUPS.map((group) => {
    const mine = rows.filter((r) => r.kind === group.kind).sort(byPriority).map(goalTableRow);
    return {
      ...group,
      rows: mine,
      saved: mine.reduce((s, r) => s + r.saved, 0),
      target: mine.reduce((s, r) => s + r.target, 0),
      needs: mine.reduce((s, r) => s + (r.needs ?? 0), 0),
    };
  }).filter((g) => g.rows.length > 0);
}
