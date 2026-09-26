import { describe, it, expect } from 'vitest';
import { nearestIndex, niceTicks, stackSegments, yScale } from './scale';
import { formatCompact } from '../lib/money';

describe('niceTicks', () => {
  it('always includes zero and covers the data', () => {
    const { min, max, ticks } = niceTicks(120000, 870000);
    expect(ticks).toContain(0);
    expect(min).toBe(0);
    expect(max).toBeGreaterThanOrEqual(870000);
    expect(ticks[ticks.length - 1]).toBe(max);
  });

  it('uses round steps a reader can add up', () => {
    const { ticks } = niceTicks(0, 870000);
    const step = ticks[1] - ticks[0];
    expect([100000, 200000, 250000, 500000]).toContain(step);
  });

  it('extends below zero for negative values', () => {
    const { min, ticks } = niceTicks(-3200, 9000);
    expect(min).toBeLessThanOrEqual(-3200);
    expect(ticks).toContain(0);
  });

  it('survives an empty or flat series', () => {
    expect(niceTicks(Infinity, -Infinity).ticks).toContain(0);
    expect(niceTicks(0, 0).max).toBeGreaterThan(0);
  });

  it('produces exact multiples, not float drift', () => {
    const { ticks } = niceTicks(0, 0.7);
    for (const t of ticks) expect(String(t).length).toBeLessThan(6);
  });
});

describe('yScale', () => {
  it('maps the domain onto the plot height, top down', () => {
    const y = yScale(0, 100, 200);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(50)).toBe(100);
  });
});

describe('nearestIndex', () => {
  it('picks the band under the pointer and clamps at the edges', () => {
    expect(nearestIndex(5, 100, 4)).toBe(0);
    expect(nearestIndex(60, 100, 4)).toBe(2);
    expect(nearestIndex(-10, 100, 4)).toBe(0);
    expect(nearestIndex(500, 100, 4)).toBe(3);
    expect(nearestIndex(10, 100, 0)).toBeNull();
  });
});

describe('stackSegments', () => {
  it('stacks positives upward in order', () => {
    expect(stackSegments([100, 50, 25])).toEqual([
      [0, 100],
      [100, 150],
      [150, 175],
    ]);
  });

  it('stacks negatives downward rather than as money held', () => {
    expect(stackSegments([-40, 100, -10])).toEqual([
      [-40, 0],
      [0, 100],
      [-50, -40],
    ]);
  });
});

describe('formatCompact', () => {
  it('abbreviates thousands, millions and billions', () => {
    expect(formatCompact(850)).toBe('850');
    expect(formatCompact(12500)).toBe('12.5K');
    expect(formatCompact(250000)).toBe('250K');
    expect(formatCompact(1250000)).toBe('1.3M');
    expect(formatCompact(2e9)).toBe('2B');
  });

  it('keeps the sign', () => {
    expect(formatCompact(-40000)).toBe('−40K');
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(-0.2)).toBe('0');
  });

  it('moves up a unit instead of reading 1000K', () => {
    expect(formatCompact(999960)).toBe('1M');
  });
});
