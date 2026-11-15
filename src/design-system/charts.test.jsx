import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrendLine, PairedColumns, DatedStrip } from './charts';

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
