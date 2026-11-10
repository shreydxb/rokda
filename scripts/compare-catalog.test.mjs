import { describe, expect, it } from 'vitest';
import { compareCatalogs, parseCatalog, summarize } from './compare-catalog.mjs';

// The outside review, F-02: the release check proved the migration history
// matched, not that production's live definitions did. A function replaced by
// hand in the dashboard keeps its migration row and changes nothing the
// history comparison can see. These compare the live catalog, object by
// object, with one built fresh from the same commit.

const BUILT = [
  'function|private.lock_funds(p_fund_ids uuid[])|aaa',
  'policy|public.accounts.accounts_select|bbb',
  'column|public.accounts.balance|ccc',
].join('\n');

describe('parseCatalog: reading kind|name|hash lines', () => {
  it('keys each object by kind and name', () => {
    const catalog = parseCatalog(BUILT);
    expect(catalog.size).toBe(3);
    expect(catalog.get('function|private.lock_funds(p_fund_ids uuid[])')).toBe('aaa');
  });

  it('ignores blank lines and a trailing newline', () => {
    expect(parseCatalog(`${BUILT}\n\n`).size).toBe(3);
  });

  it('refuses a line that is not kind|name|hash, rather than skipping it', () => {
    expect(() => parseCatalog('function|private.lock_funds()')).toThrow(/line 1/);
  });

  it('refuses the same object twice, which would hide one of them', () => {
    expect(() => parseCatalog(`${BUILT}\nfunction|private.lock_funds(p_fund_ids uuid[])|zzz`)).toThrow(/twice/);
  });
});

describe('compareCatalogs: production against a fresh build', () => {
  it('finds nothing when every object matches', () => {
    const result = compareCatalogs(parseCatalog(BUILT), parseCatalog(BUILT));
    expect(result).toEqual({ missing: [], extra: [], differing: [] });
  });

  it('finds a definition production changed in place', () => {
    const live = BUILT.replace('|aaa', '|edited');
    const result = compareCatalogs(parseCatalog(BUILT), parseCatalog(live));
    expect(result.differing).toEqual([{ kind: 'function', name: 'private.lock_funds(p_fund_ids uuid[])' }]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('finds an object production lacks and one no migration made', () => {
    const live = BUILT.replace('policy|public.accounts.accounts_select|bbb', 'policy|public.accounts.open_to_all|ddd');
    const result = compareCatalogs(parseCatalog(BUILT), parseCatalog(live));
    expect(result.missing).toEqual([{ kind: 'policy', name: 'public.accounts.accounts_select' }]);
    expect(result.extra).toEqual([{ kind: 'policy', name: 'public.accounts.open_to_all' }]);
  });

  it('lists differences sorted, so two runs print the same', () => {
    const live = BUILT.replace('|aaa', '|x').replace('|ccc', '|y');
    const { differing } = compareCatalogs(parseCatalog(BUILT), parseCatalog(live));
    expect(differing.map((d) => d.kind)).toEqual(['column', 'function']);
  });

  it('refuses an empty side, which would otherwise read as everything missing or nothing to check', () => {
    expect(() => compareCatalogs(parseCatalog(''), parseCatalog(BUILT))).toThrow(/fresh build.*empty/);
    expect(() => compareCatalogs(parseCatalog(BUILT), parseCatalog(''))).toThrow(/production.*empty/);
  });
});

describe('summarize: counts by kind for the log', () => {
  it('counts each kind on both sides', () => {
    expect(summarize(parseCatalog(BUILT))).toEqual({ column: 1, function: 1, policy: 1 });
  });
});
