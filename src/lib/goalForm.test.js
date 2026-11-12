import { describe, it, expect } from 'vitest';
import { goalPayload, goalProblems, initialForm, linkCountsAsNothing, linkErrorMessage, shareProblem } from './goalForm';

const GOAL = { id: 'g1', name: 'Car', note: null, target_amount: 50000, target_date: '2028-06-01', funding_source: null, is_shared: false, owner_member_id: 'm1', cost_today: true, inflation_pct: 3, priority: 2, counts_in_life_plan: false, planned_monthly: 0 };
const form = (over) => ({ ...initialForm(GOAL), ...over });

describe('initialForm', () => {
  it('opens a goal as text fields, kept money as kept, and a plan of nothing as 0', () => {
    expect(initialForm(GOAL)).toEqual({
      name: 'Car', note: '', target_amount: '50000', target_date: '2028-06-01', funding_source: '', owner: 'm1', cost_today: true, inflation_pct: '3', priority: '2', kept: true, planned_monthly: '0',
    });
  });

  it('starts a new goal shared and empty', () => {
    expect(initialForm(null)).toMatchObject({ name: '', owner: 'shared', cost_today: false, kept: false, planned_monthly: '' });
  });
});

describe('goalProblems', () => {
  it('finds nothing wrong with a goal as it was saved', () => {
    expect(goalProblems(form())).toEqual({ name: '', target: '', rate: '', priority: '', planned: '' });
  });

  it('says what each field needs', () => {
    expect(goalProblems(form({ name: ' ', target_amount: '0', inflation_pct: '31', priority: '1.5', planned_monthly: '-1' }))).toEqual({
      name: 'Name it.',
      target: 'Set a target above zero.',
      rate: 'A yearly rise between −10% and 30%.',
      priority: 'Priority is a whole number from 1.',
      planned: 'A monthly amount of 0 or more, or blank for no plan.',
    });
  });

  it('reads the yearly rise only for a cost in today\'s money', () => {
    expect(goalProblems(form({ cost_today: false, inflation_pct: '99' })).rate).toBe('');
  });
});

describe('goalPayload', () => {
  it('writes blanks as nothing, the rise only for a cost in today\'s money, and kept money out of the Life plan', () => {
    expect(goalPayload(form({ note: ' saving up ', priority: '', planned_monthly: '' }), 'h1')).toEqual({
      household_id: 'h1', name: 'Car', note: 'saving up', target_amount: 50000, target_date: '2028-06-01', funding_source: '', is_shared: false, owner_member_id: 'm1',
      cost_today: true, inflation_pct: 3, priority: null, counts_in_life_plan: false, planned_monthly: null,
    });
    expect(goalPayload(form({ cost_today: false, owner: 'shared', target_date: '' }), 'h1')).toMatchObject({ inflation_pct: null, is_shared: true, owner_member_id: null, target_date: null });
  });
});

describe('the links', () => {
  it('takes a share above 0 and up to 100', () => {
    expect(shareProblem('100')).toBe('');
    expect(shareProblem('0.5')).toBe('');
    expect(shareProblem('0')).toBe('A share above 0 and up to 100%.');
    expect(shareProblem('')).toBe('A share above 0 and up to 100%.');
  });

  it('puts the database\'s refusals in words', () => {
    expect(linkErrorMessage({ code: '23514', message: 'shares exceed 100%: already 60' })).toBe('That would link more than 100% of it to goals: 60% is already linked to other goals. Lower the share.');
    expect(linkErrorMessage({ code: '23505', message: 'duplicate' })).toBe('This goal already links it. Change the share on its row instead.');
    expect(linkErrorMessage({ code: 'XX', message: 'other' })).toBe('other');
  });

  it('says why an old link counts for nothing', () => {
    expect(linkCountsAsNothing(null)).toBe('the account is gone');
    expect(linkCountsAsNothing({ type: 'loan', archived_at: null })).toBe('a loan is owed, not saved');
    expect(linkCountsAsNothing({ type: 'credit_card', archived_at: null })).toBe('a card is owed, not saved');
    expect(linkCountsAsNothing({ type: 'checking', archived_at: '2026-01-01T00:00:00Z' })).toBe('the account is closed');
  });
});
