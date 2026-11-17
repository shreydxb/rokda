import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrendLine, PairedColumns, DatedStrip, MonthBars, PlanBars } from './charts';

// The kit's charts (the revamp, phase 3; design/prototype/js/charts.js).
// Like the app's other charts, a value is never only reachable by hovering:
// hover, touch or the arrow keys pick a point and the screen shows it in a
// readout of its own.

describe('TrendLine', () => {
  const points = [
    { key: 'a', label: 'Sep', value: 100 },
    { key: 'b', label: 'Oct', value: 120 },
    { key: 'c', label: 'Today', value: 150 },
  ];

  it('is a chart named for what it shows, and marks the latest point', () => {
    const { container } = render(<TrendLine points={points} ariaLabel="Net worth, 3 months" />);
    expect(screen.getByRole('group', { name: 'Net worth, 3 months' })).toBeTruthy();
    expect(container.querySelector('.ds-trend-line')).toBeTruthy();
    expect(container.querySelectorAll('.ds-trend-last')).toHaveLength(1);
  });

  it('moves its pick with the arrow keys', () => {
    const pick = vi.fn();
    render(<TrendLine points={points} ariaLabel="Net worth" activeIndex={2} onActiveChange={pick} />);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Net worth' }), { key: 'ArrowLeft' });
    expect(pick).toHaveBeenCalledWith(1);
  });

  it('draws one point as a dot, and nothing at all for none', () => {
    const one = render(<TrendLine points={[points[2]]} ariaLabel="One" />);
    expect(one.container.querySelector('.ds-trend-line')).toBeNull();
    expect(one.container.querySelectorAll('.ds-trend-last')).toHaveLength(1);
    const none = render(<TrendLine points={[]} ariaLabel="None" />);
    expect(none.container.querySelector('svg')).toBeNull();
  });

  it('leaves out a value it cannot read', () => {
    const { container } = render(<TrendLine points={[...points, { key: 'd', label: 'x', value: Number.NaN }]} ariaLabel="Net worth" />);
    expect(container.querySelector('.ds-trend-line').getAttribute('d')).not.toMatch(/NaN/);
  });

  // Plan's "Show the path": a market fall against the steady plan (the
  // revamp, phase 6).
  it('draws a second line to compare against, on the same scale, only when given one', () => {
    const plain = render(<TrendLine points={points} ariaLabel="Plain" />);
    expect(plain.container.querySelector('.ds-trend-compare')).toBeNull();
    const { container } = render(<TrendLine points={points} compare={[100, 200, 300]} ariaLabel="With the steady plan" />);
    const d = container.querySelector('.ds-trend-compare').getAttribute('d');
    expect(d).toMatch(/^M/);
    expect(d).not.toMatch(/NaN/);
    // The steady line runs above the fall at the end, so the scale takes it in.
    const ys = (path) => path.match(/,(-?[\d.]+)/g).map((s) => Number(s.slice(1)));
    expect(Math.min(...ys(d))).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys(d))).toBeLessThan(Math.min(...ys(container.querySelector('.ds-trend-line').getAttribute('d'))));
  });
});

describe('PlanBars', () => {
  // The pot from 2026 to 2075, work stopping in 2050 and the money running
  // out in 2070, a goal in 2035, and the band either side.
  const years = Array.from({ length: 50 }, (_, i) => {
    const year = 2026 + i;
    const value = year < 2050 ? 10000 * (i + 1) : year < 2070 ? 240000 - 12000 * (year - 2050) : 0;
    return { key: year, year, value, after: year >= 2050, low: value * 0.8, high: value * 1.2, goal: year === 2035 ? 'Home' : null };
  });

  it('draws a bar a year with money in it, the years after work paler, and labels the first year and each tenth', () => {
    const { container } = render(<PlanBars years={years} stopYear={2050} runsOutYear={2070} ariaLabel="The pot" />);
    expect(screen.getByRole('group', { name: 'The pot' })).toBeTruthy();
    expect(container.querySelectorAll('.ds-pb-bar')).toHaveLength(44);
    expect(container.querySelectorAll('.ds-pb-bar.ds-pb-after')).toHaveLength(20);
    const labels = [...container.querySelectorAll('.ds-pb-year')].map((t) => t.textContent);
    expect(labels).toEqual(['2026', '2040', '2050', '2060', '2070']);
  });

  it('shades the band only when given one', () => {
    const banded = render(<PlanBars years={years} stopYear={2050} ariaLabel="Banded" />);
    expect(banded.container.querySelector('.ds-pb-band')).toBeTruthy();
    const bare = render(<PlanBars years={years.map((y) => ({ ...y, low: undefined, high: undefined }))} stopYear={2050} ariaLabel="Bare" />);
    expect(bare.container.querySelector('.ds-pb-band')).toBeNull();
  });

  it('marks the year work stops, the year the money runs out, and each goal, named', () => {
    const { container } = render(<PlanBars years={years} stopYear={2050} runsOutYear={2070} ariaLabel="The pot" />);
    expect(container.querySelector('.ds-pb-stop-label').textContent).toBe('Stop 2050');
    expect(container.querySelector('.ds-pb-out-label').textContent).toBe('Runs out 2070');
    expect(container.querySelector('.ds-pb-out')).toBeTruthy();
    const goals = container.querySelectorAll('.ds-pb-goal');
    expect(goals).toHaveLength(1);
    expect(goals[0].querySelector('title').textContent).toBe('Home · 2035');
  });

  it('draws no runs-out mark while the money lasts', () => {
    const { container } = render(<PlanBars years={years} stopYear={2050} ariaLabel="The pot" />);
    expect(container.querySelector('.ds-pb-out')).toBeNull();
  });

  it('draws a year still owing below the line, and moves its pick with the keys', () => {
    const owing = [{ key: 2026, year: 2026, value: -20000, after: false }, ...years.slice(1)];
    const pick = vi.fn();
    const { container } = render(<PlanBars years={owing} stopYear={2050} ariaLabel="The pot" activeIndex={3} onActiveChange={pick} />);
    expect(container.querySelectorAll('.ds-pb-bar.ds-pb-owed')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('group', { name: 'The pot' }), { key: 'ArrowRight' });
    expect(pick).toHaveBeenCalledWith(4);
  });
});

describe('PairedColumns', () => {
  const groups = [
    { key: 'sep', label: 'Sep', a: 0, b: 0, line: null, empty: true },
    { key: 'oct', label: 'Oct', a: 1000, b: 600, line: 400 },
    { key: 'nov', label: 'Nov', a: 1000, b: 1200, line: -200, current: true },
  ];

  it('draws two columns per month with data, and a quiet mark for a month without', () => {
    const { container } = render(<PairedColumns groups={groups} ariaLabel="Income and spending" />);
    expect(container.querySelectorAll('.ds-col-a')).toHaveLength(2);
    expect(container.querySelectorAll('.ds-col-b')).toHaveLength(2);
    expect(container.querySelectorAll('.ds-col-empty')).toHaveLength(1);
  });

  it('draws the line through the months with data, below zero when it goes there', () => {
    const { container } = render(<PairedColumns groups={groups} ariaLabel="Income and spending" />);
    const line = container.querySelector('.ds-col-line');
    expect(line).toBeTruthy();
    // Two points: the empty month has no saved figure.
    expect(line.getAttribute('d').match(/[ML]/g)).toHaveLength(2);
    // An axis tick below zero, because one month spent more than came in.
    expect([...container.querySelectorAll('.ch-tick')].some((t) => t.textContent.startsWith('-') || t.textContent.startsWith('−'))).toBe(true);
  });

  it('has an axis with its labels, and moves its pick with the keys', () => {
    const pick = vi.fn();
    const { container } = render(<PairedColumns groups={groups} ariaLabel="Six months" formatTick={(v) => String(v)} activeIndex={2} onActiveChange={pick} />);
    expect(container.querySelectorAll('.ch-grid, .ch-zero').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Oct')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Six months' }), { key: 'Home' });
    expect(pick).toHaveBeenCalledWith(0);
  });
});

// A bar a month (the revamp, phase 5c; design/prototype charts.bars):
// received solid with presumed receipts paler on it, what is expected
// outlined, and today marked.
describe('MonthBars', () => {
  const months = [
    { key: '2026-10', label: 'Oct', solid: 100, pale: 20, outline: 0 },
    { key: '2026-11', label: 'Nov', solid: 40, pale: 0, outline: 50, today: true },
    { key: '2026-12', label: 'Dec', solid: 0, pale: 0, outline: 80 },
    { key: '2027-01', label: '', solid: 0, pale: 0, outline: 0 },
  ];

  it('stacks received solid and presumed paler, outlines what is expected, and marks today', () => {
    const { container } = render(<MonthBars months={months} ariaLabel="Dividends by month" />);
    expect(container.querySelectorAll('.ds-mb-solid')).toHaveLength(2);
    expect(container.querySelectorAll('.ds-mb-pale')).toHaveLength(1);
    expect(container.querySelectorAll('.ds-mb-outline')).toHaveLength(2);
    expect(container.querySelectorAll('.ds-mb-today')).toHaveLength(1);
  });

  // Nothing in any month is one zero line, not an axis of rounded nothings.
  it('draws only its zero line when every month is nothing', () => {
    const empty = months.map((m) => ({ ...m, solid: 0, pale: 0, outline: 0 }));
    const { container } = render(<MonthBars months={empty} ariaLabel="Dividends by month" formatTick={(v) => String(Math.round(v))} />);
    const ticks = [...container.querySelectorAll('.ch-tick')].filter((t) => !/[A-Za-z]/.test(t.textContent)).map((t) => t.textContent);
    expect(ticks).toEqual(['0']);
  });

  it('labels the months it is given, and moves its pick with the keys', () => {
    const pick = vi.fn();
    render(<MonthBars months={months} ariaLabel="Dividends by month" activeIndex={1} onActiveChange={pick} />);
    expect(screen.getByText('Oct')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Dividends by month' }), { key: 'Home' });
    expect(pick).toHaveBeenCalledWith(0);
  });
});

describe('DatedStrip', () => {
  const marks = [
    { key: 'a', day: 0, amount: -50, tone: 'neg', label: '14 Nov · Gym · −50 · late' },
    { key: 'b', day: 6, amount: -55, tone: '', label: '20 Nov · Streaming · −55' },
    { key: 'c', day: 14, amount: 18000, tone: 'pos', label: '28 Nov · Salary · +18,000' },
  ];

  it('puts each mark on its day, larger for a larger amount, coloured by status', () => {
    const { container } = render(<DatedStrip days={30} marks={marks} ariaLabel="Next 30 days" />);
    expect(screen.getByRole('img', { name: 'Next 30 days' })).toBeTruthy();
    const dots = [...container.querySelectorAll('.ds-strip-mark')];
    expect(dots).toHaveLength(3);
    const x = dots.map((d) => Number(d.getAttribute('cx')));
    expect(x[0]).toBeLessThan(x[1]);
    expect(x[1]).toBeLessThan(x[2]);
    const r = dots.map((d) => Number(d.getAttribute('r')));
    expect(r[2]).toBeGreaterThan(r[1]);
    expect(dots[0].getAttribute('class')).toMatch(/ds-strip-neg/);
    expect(dots[2].getAttribute('class')).toMatch(/ds-strip-pos/);
  });

  it('names each mark on hover', () => {
    const { container } = render(<DatedStrip days={30} marks={marks} ariaLabel="Next 30 days" />);
    expect(container.querySelector('.ds-strip-mark title').textContent).toBe('14 Nov · Gym · −50 · late');
  });

  it('labels today and each week', () => {
    render(<DatedStrip days={30} marks={marks} ariaLabel="Next 30 days" />);
    expect(screen.getByText('today')).toBeTruthy();
    expect(screen.getByText('+7d')).toBeTruthy();
    expect(screen.getByText('+28d')).toBeTruthy();
  });

  it('keeps a mark past the end or before today on the strip', () => {
    const { container } = render(<DatedStrip days={30} marks={[{ key: 'x', day: -3, amount: -10, label: 'late' }, { key: 'y', day: 40, amount: -10, label: 'later' }]} ariaLabel="Next 30 days" />);
    const x = [...container.querySelectorAll('.ds-strip-mark')].map((d) => Number(d.getAttribute('cx')));
    expect(Math.min(...x)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...x)).toBeLessThanOrEqual(640);
  });
});
