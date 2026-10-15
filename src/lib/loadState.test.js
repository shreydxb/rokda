import { describe, expect, it, vi } from 'vitest';
import { SOURCE_LABELS, failureMessage } from './loadState';

vi.mock('./supabaseClient', () => ({ supabase: {} }));

const { OVERVIEW_SOURCE_KEYS } = await import('../screens/useOverviewData');
const { PLANNING_SOURCE_KEYS } = await import('../screens/usePlanningData');

describe('a failed load is named in words', () => {
  // Five sources had no label, so a failed statements read said "Couldn't
  // load statementReconciliations." (QA, 15 Oct).
  it.each([...OVERVIEW_SOURCE_KEYS, ...PLANNING_SOURCE_KEYS])('%s has a label', (key) => {
    expect(SOURCE_LABELS[key]).toBeTruthy();
    expect(SOURCE_LABELS[key]).not.toMatch(/[A-Z]/);
  });

  it('lists several failures in a sentence', () => {
    expect(failureMessage({ statementReconciliations: new Error('x'), notes: new Error('y') })).toBe('Couldn’t load card statements and household notes.');
  });
});
