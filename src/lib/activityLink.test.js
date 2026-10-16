import { describe, it, expect } from 'vitest';
import { activeFilterCount, activityHref, bucketRange, categoryAndChildren, datePresets, dateRangeLabel, inDateRange, monthRange, presetFor, readActivityFilters, tabHref, withActivityFilter, withoutFilters } from './activityLink';

describe('activityHref and readActivityFilters', () => {
  it('round-trips a month and category through the address', () => {
    const href = activityHref({ categoryId: 'c1', ...monthRange(2026, 9) });
    expect(href).toBe('/money?tab=activity&cat=c1&from=2026-09-01&to=2026-09-30');
    const filters = readActivityFilters(new URL(href, 'http://x').searchParams);
    expect(filters).toMatchObject({ categoryId: 'c1', from: '2026-09-01', to: '2026-09-30', dateBasis: 'posted', view: 'list', search: '', needsReview: false });
  });

  it('leaves defaults out of the address', () => {
    expect(activityHref({ categoryId: 'all', dateBasis: 'posted', search: '' })).toBe('/money?tab=activity');
  });

  it('ignores malformed values rather than showing a state the controls cannot', () => {
    const filters = readActivityFilters(new URLSearchParams('from=yesterday&dates=sometimes&view=grid'));
    expect(filters).toMatchObject({ from: null, dateBasis: 'posted', view: 'list' });
  });
});

describe('withActivityFilter', () => {
  it('sets, replaces and clears one filter, keeping the rest', () => {
    let p = new URLSearchParams('tab=activity&cat=c1');
    p = withActivityFilter(p, 'needsReview', true);
    expect(p.toString()).toBe('tab=activity&cat=c1&review=1');
    p = withActivityFilter(p, 'categoryId', 'all');
    expect(p.toString()).toBe('tab=activity&review=1');
  });
});

describe('monthRange', () => {
  it('ends on the last day of the month, leap years included', () => {
    expect(monthRange(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange(2026, 12)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('inDateRange', () => {
  it('includes both ends and allows either to be open', () => {
    const row = (d) => ({ occurred_at: d });
    expect(inDateRange(row('2026-09-01'), '2026-09-01', '2026-09-30')).toBe(true);
    expect(inDateRange(row('2026-09-30'), '2026-09-01', '2026-09-30')).toBe(true);
    expect(inDateRange(row('2026-10-01'), '2026-09-01', '2026-09-30')).toBe(false);
    expect(inDateRange(row('2020-01-01'), null, '2026-09-30')).toBe(true);
  });
});

describe('dateRangeLabel', () => {
  it('names a whole month, and otherwise both ends', () => {
    expect(dateRangeLabel('2026-09-01', '2026-09-30')).toBe('September 2026');
    expect(dateRangeLabel('2026-07-01', '2026-10-15')).toBe('1 Jul – 15 Oct 2026');
    expect(dateRangeLabel('2025-12-01', '2026-01-15')).toBe('1 Dec 2025 – 15 Jan 2026');
    expect(dateRangeLabel(null, null)).toBeNull();
  });
});

describe('categoryAndChildren', () => {
  it('includes a group’s subcategories', () => {
    const cats = [{ id: 'g' }, { id: 's1', parent_id: 'g' }, { id: 's2', parent_id: 'g' }, { id: 'x', parent_id: 'other' }];
    expect([...categoryAndChildren('g', cats)].sort()).toEqual(['g', 's1', 's2']);
  });
});

describe('bucketRange', () => {
  it('turns an exclusive end into the last day, and stops the running bucket at today', () => {
    const now = new Date(2026, 9, 15, 12);
    expect(bucketRange({ start: new Date(2026, 8, 1), end: new Date(2026, 9, 1) }, now)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(bucketRange({ start: new Date(2026, 9, 1), end: new Date(2026, 10, 1) }, now)).toEqual({ from: '2026-10-01', to: '2026-10-15' });
  });
});

describe('tabHref', () => {
  it('names the tab in the address', () => {
    expect(tabHref('/money', 'recurring')).toBe('/money?tab=recurring');
    expect(tabHref('/wealth')).toBe('/wealth');
  });
});

describe('date presets', () => {
  const now = new Date(2026, 9, 15, 12);
  it('works each preset out from today', () => {
    const byId = Object.fromEntries(datePresets(now).map((p) => [p.id, p]));
    expect(byId['this-month']).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(byId['last-month']).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(byId['90-days']).toMatchObject({ from: '2026-07-18', to: '2026-10-15' });
    expect(byId['this-year']).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(byId.all).toMatchObject({ from: null, to: null });
  });

  it('recognises a range as a preset, or not', () => {
    expect(presetFor('2026-09-01', '2026-09-30', now)).toBe('last-month');
    expect(presetFor(null, null, now)).toBe('all');
    expect(presetFor('2026-08-01', '2026-08-31', now)).toBeNull();
  });

  it('crosses a year boundary for last month in January', () => {
    const jan = new Date(2027, 0, 10);
    expect(datePresets(jan).find((p) => p.id === 'last-month')).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('activeFilterCount and withoutFilters', () => {
  it('counts the filters that narrow the list, and clears them keeping the view', () => {
    const params = new URLSearchParams('tab=activity&cat=c1&from=2026-09-01&to=2026-09-30&view=calendar&sort=largest&acct=a1');
    expect(activeFilterCount(readActivityFilters(params))).toBe(3);
    expect(withoutFilters(params).toString()).toBe('tab=activity&view=calendar&sort=largest');
  });
});
