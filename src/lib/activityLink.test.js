import { describe, it, expect } from 'vitest';
import { accountHref, activityHref, holdingHref, activityPeriod, sharedMonth, bucketRange, categoryAndChildren, dateRangeLabel, inDateRange, monthRange, readActivityFilters, tabHref, withActivityFilter, withActivityMonth, withAllDates, withoutFilters } from './activityLink';

// An account's drawer on Wealth (the revamp, phase 5a).
describe('accountHref', () => {
  it('opens one account, on a view when asked, for the household when asked', () => {
    expect(accountHref('c1')).toBe('/wealth?account=c1');
    expect(accountHref('a1', { view: 'details', who: 'both' })).toBe('/wealth?account=a1&view=details&who=both');
  });
});

// A holding's drawer, over Investments (the revamp, phase 5b).
describe('holdingHref', () => {
  it('opens one holding over Investments, on a tab when asked', () => {
    expect(holdingHref('h1')).toBe('/wealth?tab=investments&holding=h1');
    expect(holdingHref('h1', { view: 'dividends' })).toBe('/wealth?tab=investments&holding=h1&view=dividends');
  });
});

describe('activityHref and readActivityFilters', () => {
  // A card's view on Net worth opens every record on the card (the revamp,
  // phase 5a).
  it('opens one account’s records over all dates', () => {
    const href = activityHref({ accountId: 'card-1', allDates: true, who: 'both' });
    expect(href).toBe('/money?tab=activity&who=both&acct=card-1&range=all');
    expect(readActivityFilters(new URL(href, 'https://x').searchParams).accountId).toBe('card-1');
  });

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

describe('withoutFilters', () => {
  it('clears the filters that narrow the list, keeping the view and the sort', () => {
    const params = new URLSearchParams('tab=activity&cat=c1&from=2026-09-01&to=2026-09-30&view=calendar&sort=largest&acct=a1');
    expect(withoutFilters(params).toString()).toBe('tab=activity&view=calendar&sort=largest');
  });
});

// Which dates Activity shows (the revamp, phase 4): the month the address
// names, or this one; every date on `range=all`; a link's range as given,
// counted as its month when it covers one whole month.
describe('activityPeriod', () => {
  const now = new Date(2026, 10, 15, 12);
  const at = (search) => activityPeriod(new URLSearchParams(search), now);

  it('shows this month when the address names no dates', () => {
    expect(at('')).toEqual({ mode: 'month', month: new Date(2026, 10, 1), from: '2026-11-01', to: '2026-11-30' });
  });

  it('shows the month the address names', () => {
    expect(at('month=2026-09')).toMatchObject({ mode: 'month', month: new Date(2026, 8, 1), from: '2026-09-01', to: '2026-09-30' });
  });

  it('counts a range that is one whole month as that month', () => {
    expect(at('from=2026-08-01&to=2026-08-31')).toMatchObject({ mode: 'month', month: new Date(2026, 7, 1) });
  });

  it('keeps any other range as it is, on the month it starts in', () => {
    expect(at('from=2026-11-01&to=2026-11-15')).toEqual({ mode: 'custom', month: new Date(2026, 10, 1), from: '2026-11-01', to: '2026-11-15' });
    expect(at('to=2026-06-30')).toMatchObject({ mode: 'custom', month: new Date(2026, 5, 1), from: null, to: '2026-06-30' });
  });

  it('shows every date on range=all, keeping the month to step from', () => {
    expect(at('range=all&month=2026-09')).toEqual({ mode: 'all', month: new Date(2026, 8, 1), from: null, to: null });
  });
});

describe('withActivityMonth and withAllDates', () => {
  const now = new Date(2026, 10, 15, 12);

  it('moves to a month, dropping a range and All dates, and leaves this month out of the address', () => {
    const start = new URLSearchParams('tab=activity&from=2026-11-01&to=2026-11-15&range=all&cat=c1');
    expect(withActivityMonth(start, new Date(2026, 9, 1), now).toString()).toBe('tab=activity&cat=c1&month=2026-10');
    expect(withActivityMonth(start, new Date(2026, 10, 1), now).toString()).toBe('tab=activity&cat=c1');
  });

  it('shows every date, keeping the month', () => {
    const start = new URLSearchParams('tab=activity&month=2026-09&from=2026-09-01&to=2026-09-30');
    expect(withAllDates(start).toString()).toBe('tab=activity&month=2026-09&range=all');
  });
});

// The month Money's tabs share (the fresh review of 4a): a link's whole
// month counts, so Budget opened from Activity shows the month Activity did.
describe('sharedMonth', () => {
  const now = new Date(2026, 10, 15, 12);
  const at = (search) => sharedMonth(new URLSearchParams(search), now);

  it("is the month in the address, or a link's whole month", () => {
    expect(at('month=2026-09')).toBe('2026-09');
    expect(at('from=2026-09-01&to=2026-09-30')).toBe('2026-09');
  });

  it('is nothing for this month, or for a range that is not one month', () => {
    expect(at('')).toBeNull();
    expect(at('month=2026-11')).toBeNull();
    expect(at('from=2026-09-01&to=2026-09-15')).toBeNull();
  });
});
