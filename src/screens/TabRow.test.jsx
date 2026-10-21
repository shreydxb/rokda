import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import TabRow from './TabRow';

const TABS = ['Activity', 'Budget', 'Recurring', 'Insights', 'Inbox', 'Review'].map((label) => ({ id: label.toLowerCase(), label }));

// jsdom lays nothing out, so the row is given a phone's geometry by hand: 350px
// wide, each tab 60px plus the 26px gap, the row scrolled by scrollLeft.
function phoneGeometry() {
  const proto = HTMLElement.prototype;
  const row = () => document.querySelector('.mn-tabs');
  vi.spyOn(proto, 'clientWidth', 'get').mockImplementation(function () {
    return this.classList.contains('mn-tabs') ? 350 : 60;
  });
  vi.spyOn(proto, 'scrollWidth', 'get').mockImplementation(function () {
    return this.classList.contains('mn-tabs') ? TABS.length * 86 - 26 : 60;
  });
  vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('mn-tabs')) return { left: 0, right: 350, width: 350 };
    const i = [...this.parentElement.children].indexOf(this);
    const left = i * 86 - (row()?.scrollLeft ?? 0);
    return { left, right: left + 60, width: 60 };
  });
}

afterEach(() => vi.restoreAllMocks());

describe('TabRow: one scrolling row on a phone', () => {
  it('brings an open tab that lies past the edge into view', () => {
    phoneGeometry();
    render(<TabRow tabs={TABS} active="review" onChange={() => {}} />);
    const row = document.querySelector('.mn-tabs');
    const review = row.querySelector('[data-active="true"]').getBoundingClientRect();
    expect(review.left).toBeGreaterThanOrEqual(0);
    expect(review.right).toBeLessThanOrEqual(350);
  });

  it('fades the edge while tabs lie beyond it, and not once scrolled to the end', () => {
    phoneGeometry();
    render(<TabRow tabs={TABS} active="activity" onChange={() => {}} />);
    const row = document.querySelector('.mn-tabs');
    expect(row.dataset.more).toBe('true');
    row.scrollLeft = 160;
    fireEvent.scroll(row);
    expect(row.dataset.more).toBe('false');
  });

  it('keeps the tab buttons the screens and tests rely on', () => {
    const onChange = vi.fn();
    render(<TabRow tabs={TABS} active="budget" onChange={onChange} />);
    const tabs = document.querySelectorAll('.mn-tabs .om-tab');
    expect(tabs).toHaveLength(6);
    expect(document.querySelector('.om-tab[data-active="true"]').textContent).toBe('Budget');
    fireEvent.click(tabs[5]);
    expect(onChange).toHaveBeenCalledWith('review');
  });
});
