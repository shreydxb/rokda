import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNING_DEFAULTS, assumption, assumptionsSaved } from './planningDefaults';

describe('planningDefaults', () => {
  // The database fills these columns whenever any editor first creates the
  // row, so the app's defaults and the database's must be the same figures.
  it('are the database\'s column defaults, which no later migration changes', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const created = readFileSync(join(dir, '20260903115800_planning.sql'), 'utf8');
    for (const [column, value] of Object.entries(PLANNING_DEFAULTS)) {
      const match = created.match(new RegExp(`${column} numeric\\(6, 3\\) not null default ([\\d.]+)`));
      expect(Number(match?.[1]), column).toBe(value);
    }
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/alter column (nominal_return_pct|inflation_pct|safe_withdrawal_pct) set default/);
    }
  });

  it('reads a figure from the row, or the default with no row', () => {
    expect(assumption(null, 'inflation_pct')).toBe(2.5);
    expect(assumption({ inflation_pct: '3.000' }, 'inflation_pct')).toBe(3);
  });

  it('counts the assumptions as chosen only once the drawer has saved them', () => {
    expect(assumptionsSaved(null)).toBe(false);
    expect(assumptionsSaved({ nominal_return_pct: 6, retirement_year: 2050 })).toBe(false);
    expect(assumptionsSaved({ assumptions_saved_at: '2026-10-23T09:00:00Z' })).toBe(true);
  });
});
