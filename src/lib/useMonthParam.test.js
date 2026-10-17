import { describe, it, expect } from 'vitest';
import { monthFromParam, monthParam } from './useMonthParam';

describe('monthFromParam', () => {
  it('reads a YYYY-MM month as its first day, and nothing else', () => {
    expect(monthFromParam('2026-09')).toEqual(new Date(2026, 8, 1));
    expect(monthFromParam('2026-13')).toBeNull();
    expect(monthFromParam('soon')).toBeNull();
    expect(monthFromParam(null)).toBeNull();
  });

  it('writes a month back the same way', () => {
    expect(monthParam(new Date(2025, 2, 17))).toBe('2025-03');
  });
});
