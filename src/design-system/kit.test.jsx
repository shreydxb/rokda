import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useCloseGuard } from '../lib/useCloseGuard';
import { Card, KpiStrip, Chip, WarningRow, InfoButton, MonthStepper, Segmented, Switch, Fold, EmptyState, Banner, Drawer, ProgressBar, StackBar, BarList } from './kit';

// The shared kit (the revamp, phase 2; design/prototype/styles.css). Each
// piece is used by every rebuilt screen, so what it says to a screen reader
// and how it answers the keyboard are pinned here once.

describe('Card', () => {
  it('names its region by its title and shows the right-hand link', () => {
    render(
      <Card title="Next 30 days" right={<a href="/money">Recurring →</a>}>
        body
      </Card>,
    );
    const region = screen.getByRole('region', { name: 'Next 30 days' });
    expect(within(region).getByRole('link', { name: 'Recurring →' })).toBeTruthy();
    expect(within(region).getByText('body')).toBeTruthy();
  });

  // Fresh review of the kit: the (i) inside the heading joined the region's
  // name ("Where it went About Where it went").
  it('keeps its info button out of its name', () => {
    render(
      <Card title="Where it went" info={<InfoButton about="Where it went">Before refunds.</InfoButton>}>
        body
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Where it went' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About Where it went' })).toBeTruthy();
  });

  it('marks the one card that needs action now', () => {
    render(<Card title="Needs you" action>x</Card>);
    expect(screen.getByRole('region', { name: 'Needs you' }).className).toMatch(/ds-card-action/);
  });
});

describe('KpiStrip', () => {
  it('pairs each figure with its label', () => {
    render(<KpiStrip items={[{ label: 'Income', value: '1,000', sub: 'expected 28 Nov' }, { label: 'Spent', value: '500' }]} />);
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    const values = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(terms).toEqual(['Income', 'Spent']);
    expect(values[0]).toContain('1,000');
    expect(values[0]).toContain('expected 28 Nov');
  });
});

describe('KpiStrip: names', () => {
  it('keeps an info button out of the label', () => {
    render(<KpiStrip items={[{ label: 'Spent', value: '500', info: <InfoButton about="Spent">x</InfoButton> }]} />);
    expect(screen.getByRole('term').textContent).toBe('Spent');
  });

  it('takes two figures with the same label', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<KpiStrip items={[{ label: 'Spent', value: '1' }, { label: 'Spent', value: '2' }]} />);
    expect(err.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    err.mockRestore();
  });
});

describe('Chip', () => {
  it('carries its tone, and says it in words as well as colour', () => {
    render(<Chip tone="warn">Provisional</Chip>);
    const chip = screen.getByText('Provisional');
    expect(chip.className).toMatch(/ds-chip-warn/);
  });

  it('is grey when no tone is given', () => {
    render(<Chip>Upcoming</Chip>);
    expect(screen.getByText('Upcoming').className).toMatch(/ds-chip-neutral/);
  });
});

describe('WarningRow', () => {
  it('stays in view with its one action', () => {
    const fix = vi.fn();
    render(<WarningRow action={{ label: 'Confirm balance', onClick: fix }}>Cash wallet · balance not confirmed</WarningRow>);
    expect(screen.getByText('Cash wallet · balance not confirmed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm balance' }));
    expect(fix).toHaveBeenCalledOnce();
  });
});

describe('WarningRow: links', () => {
  // A plain <a> reloaded the whole app; it moves within it.
  it('follows its link inside the app', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<WarningRow action={{ label: 'Check', href: '/wealth' }}>Statement to check</WarningRow>} />
          <Route path="/wealth" element={<p>Wealth page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Check' }));
    expect(screen.getByText('Wealth page')).toBeTruthy();
  });
});

describe('InfoButton', () => {
  it('opens its explanation in place, and closes on Escape with focus back', () => {
    render(<InfoButton about="Spent">Purchases less refunds, in AED.</InfoButton>);
    const button = screen.getByRole('button', { name: 'About Spent' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Purchases less refunds, in AED.')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Purchases less refunds, in AED.')).toBeTruthy();
    // Escape is pressed where focus is, on the button.
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByText('Purchases less refunds, in AED.')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes when focus moves on', () => {
    render(
      <>
        <InfoButton about="Spent">Explained.</InfoButton>
        <button type="button">next</button>
      </>,
    );
    // A browser focuses a button as it is clicked; jsdom does not.
    const info = screen.getByRole('button', { name: 'About Spent' });
    act(() => info.focus());
    fireEvent.click(info);
    act(() => {
      screen.getByRole('button', { name: 'next' }).focus();
    });
    expect(screen.queryByText('Explained.')).toBeNull();
  });

  it('closes on a click elsewhere', () => {
    render(
      <>
        <InfoButton about="Spent">Explained.</InfoButton>
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'About Spent' }));
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByText('Explained.')).toBeNull();
  });
});

describe('MonthStepper', () => {
  it('steps either way and says which month it shows', () => {
    const prev = vi.fn();
    const next = vi.fn();
    render(<MonthStepper label="Nov 2026" onPrev={prev} onNext={next} />);
    expect(screen.getByText('Nov 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(prev).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it('cannot step past the last month there is', () => {
    render(<MonthStepper label="Nov 2026" onPrev={() => {}} onNext={() => {}} nextDisabled />);
    expect(screen.getByRole('button', { name: 'Next month' }).disabled).toBe(true);
  });

  it('can be named for a year instead', () => {
    render(<MonthStepper unit="year" label="2046" onPrev={() => {}} onNext={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous year' })).toBeTruthy();
  });
});

describe('Segmented', () => {
  it('says which choice is pressed and changes on a click', () => {
    const change = vi.fn();
    render(
      <Segmented
        label="Period"
        options={[
          { id: 'month', label: 'Month' },
          { id: 'year', label: 'Year' },
        ]}
        value="month"
        onChange={change}
      />,
    );
    const group = within(screen.getByRole('group', { name: 'Period' }));
    expect(group.getByRole('button', { name: 'Month' }).getAttribute('aria-pressed')).toBe('true');
    expect(group.getByRole('button', { name: 'Year' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(group.getByRole('button', { name: 'Year' }));
    expect(change).toHaveBeenCalledWith('year');
  });
});

describe('Switch', () => {
  it('is a switch that says whether it is on', () => {
    const change = vi.fn();
    render(<Switch label="Missed bills" checked={false} onChange={change} />);
    const sw = screen.getByRole('switch', { name: 'Missed bills' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(change).toHaveBeenCalledWith(true);
  });
});

describe('Fold', () => {
  it('is closed until opened, and gives its count', () => {
    render(
      <Fold label="Done" count={4}>
        <p>inside</p>
      </Fold>,
    );
    const summary = screen.getByText('Done (4)');
    expect(summary.closest('details').open).toBe(false);
    fireEvent.click(summary);
    expect(summary.closest('details').open).toBe(true);
  });
});

describe('EmptyState', () => {
  it('names what is missing and offers the next step', () => {
    const add = vi.fn();
    render(<EmptyState title="No goals yet" action={{ label: '+ Goal', onClick: add }} />);
    expect(screen.getByText('No goals yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+ Goal' }));
    expect(add).toHaveBeenCalledOnce();
  });
});

describe('Banner', () => {
  it('is announced, and offers Try again when there is a way to retry', () => {
    const retry = vi.fn();
    render(<Banner onRetry={retry}>Couldn&apos;t load accounts. Net worth not shown.</Banner>);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load accounts");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('Banner: tone', () => {
  it('is a polite status when it only warns', () => {
    render(<Banner tone="warn">Prices are a day old.</Banner>);
    expect(screen.getByRole('status').textContent).toContain('Prices are a day old.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Fold: empty', () => {
  it('gives no count when there is nothing in it', () => {
    render(<Fold label="Done" count={0}>x</Fold>);
    expect(screen.getByText('Done')).toBeTruthy();
  });
});

describe('Drawer', () => {
  const open = (props = {}) =>
    render(
      <>
        <button type="button">opener</button>
        <Drawer kicker="Transaction" title="Coffee shop" onClose={props.onClose ?? (() => {})} footer={<button type="button">Save</button>} {...props}>
          <input aria-label="Amount" />
        </Drawer>
      </>,
    );

  it('is a modal dialog named by its title, with its footer', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Coffee shop' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(dialog).getByText('Transaction')).toBeTruthy();
  });

  it('says when there are unsaved changes', () => {
    open({ dirty: true });
    expect(screen.getByText('Unsaved')).toBeTruthy();
  });

  it('closes on Escape, once', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on its close button', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hands Escape to the editor's own step back when it has one", () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    open({ onClose, onEscape });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Fresh review of the kit: the drawer's own Escape and the editor's close
  // guard both answered one key, so "Discard changes?" was skipped.
  it("takes the editor's Discard changes? check, one Escape at a time", () => {
    const onClose = vi.fn();
    function Editor() {
      const [dirty] = useState(true);
      const { confirmingClose, requestClose, escapeKey } = useCloseGuard({ dirty, onClose, listen: false });
      return (
        <Drawer title="Edit" onClose={requestClose} onEscape={escapeKey}>
          {confirmingClose && <p>Discard changes?</p>}
          <input aria-label="Amount" />
        </Drawer>
      );
    }
    render(<Editor />);
    const dialog = screen.getByRole('dialog', { name: 'Edit' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the drawer on top', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Drawer title="Plan" onClose={outer}>
        <Drawer title="Cost" onClose={inner}>
          <input aria-label="Amount" />
        </Drawer>
      </Drawer>,
    );
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Cost' }), { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('closes an info popover inside it, and not itself', () => {
    const onClose = vi.fn();
    render(
      <Drawer title="Edit" onClose={onClose}>
        <InfoButton about="Rate">Explained.</InfoButton>
      </Drawer>,
    );
    const info = screen.getByRole('button', { name: 'About Rate' });
    fireEvent.click(info);
    fireEvent.keyDown(info, { key: 'Escape' });
    expect(screen.queryByText('Explained.')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('switches between its tabs, by click and by arrow key', () => {
    function Tabs() {
      const [tab, setTab] = useState('details');
      return (
        <Drawer
          title="Holding"
          onClose={() => {}}
          tabs={[
            { id: 'details', label: 'Details' },
            { id: 'trades', label: 'Trades' },
          ]}
          tab={tab}
          onTab={setTab}
        >
          <p>{tab} panel</p>
        </Drawer>
      );
    }
    render(<Tabs />);
    const list = within(screen.getByRole('tablist', { name: 'Holding' }));
    const details = list.getByRole('tab', { name: 'Details' });
    expect(details.getAttribute('aria-selected')).toBe('true');
    expect(details.tabIndex).toBe(0);
    expect(list.getByRole('tab', { name: 'Trades' }).tabIndex).toBe(-1);
    expect(screen.getByRole('tabpanel', { name: 'Details' }).textContent).toContain('details panel');
    fireEvent.keyDown(details, { key: 'ArrowRight' });
    const trades = list.getByRole('tab', { name: 'Trades' });
    expect(trades.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(trades);
    fireEvent.click(list.getByRole('tab', { name: 'Details' }));
    expect(screen.getByRole('tabpanel', { name: 'Details' })).toBeTruthy();
  });
});

describe('ProgressBar', () => {
  // Fresh review of the kit: a value past the end broke ARIA's rules and hid
  // the over-budget state; the tick took a share where everything else takes
  // an amount.
  it('says when it is over, and never draws past full', () => {
    render(<ProgressBar label="Budget" value={150} max={100} tick={47} tone="neg" />);
    const bar = screen.getByRole('progressbar', { name: 'Budget' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('150 of 100, 50 over');
    expect(bar.querySelector('.ds-bar-fill').style.width).toBe('100%');
    expect(bar.querySelector('.ds-bar-tick').style.left).toBe('47%');
  });

  it('says plainly how much of it is used', () => {
    render(<ProgressBar label="Budget" value={40} max={100} format={(n) => `AED ${n}`} />);
    expect(screen.getByRole('progressbar', { name: 'Budget' }).getAttribute('aria-valuetext')).toBe('AED 40 of AED 100');
  });

  it('draws nothing for a value it cannot read', () => {
    render(<ProgressBar label="Budget" value={Number.NaN} max={100} />);
    const bar = screen.getByRole('progressbar', { name: 'Budget' });
    expect(bar.querySelector('.ds-bar-fill').style.width).toBe('0%');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });

  it('draws nothing for a zero target rather than dividing by it', () => {
    render(<ProgressBar label="Budget" value={10} max={0} />);
    expect(screen.getByRole('progressbar', { name: 'Budget' }).querySelector('.ds-bar-fill').style.width).toBe('0%');
  });
});

describe('StackBar', () => {
  it('draws each part by its share and lists them in words', () => {
    render(
      <StackBar
        label="Assets"
        parts={[
          { label: 'Cash', value: 75 },
          { label: 'Shares', value: 25 },
        ]}
      />,
    );
    const parts = document.querySelectorAll('.ds-stack-part');
    expect(parts[0].style.width).toBe('75%');
    expect(parts[1].style.width).toBe('25%');
    expect(screen.getByText('Cash 75%')).toBeTruthy();
    expect(screen.getByText('Shares 25%')).toBeTruthy();
  });

  it('leaves out parts worth nothing or less', () => {
    render(
      <StackBar
        label="Assets"
        parts={[
          { label: 'Cash', value: 100 },
          { label: 'Owed', value: -20 },
        ]}
      />,
    );
    expect(document.querySelectorAll('.ds-stack-part')).toHaveLength(1);
  });
});

describe('BarList', () => {
  it('ranks by value, scales to the largest, and marks the usual', () => {
    render(
      <BarList
        items={[
          { id: 'g', label: 'Groceries', value: 100, display: '100', usual: 80 },
          { id: 'r', label: 'Rent', value: 400, display: '400' },
        ]}
      />,
    );
    const rows = [...document.querySelectorAll('.ds-bl-row')];
    expect(rows.map((r) => r.querySelector('.ds-bl-label').textContent)).toEqual(['Rent', 'Groceries']);
    expect(rows[0].querySelector('.ds-bl-fill').style.width).toBe('100%');
    expect(rows[1].querySelector('.ds-bl-fill').style.width).toBe('25%');
    expect(rows[1].querySelector('.ds-bl-tick').style.left).toBe('20%');
  });

  // Fresh review of the kit: one value it could not read blanked every bar.
  it('leaves out a value it cannot read, and draws the rest', () => {
    render(
      <BarList
        items={[
          { id: 'a', label: 'Groceries', value: Number.NaN, display: '?' },
          { id: 'b', label: 'Rent', value: 400, display: '400' },
        ]}
      />,
    );
    const rows = [...document.querySelectorAll('.ds-bl-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.ds-bl-fill').style.width).toBe('100%');
  });

  it('opens a row when it can be chosen', () => {
    const pick = vi.fn();
    render(<BarList items={[{ id: 'r', label: 'Rent', value: 400, display: '400' }]} onSelect={pick} />);
    fireEvent.click(screen.getByRole('button', { name: /Rent/ }));
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }));
  });
});

describe('StackBar: many parts', () => {
  it('folds a fifth part and beyond into Other', () => {
    render(<StackBar label="Assets" parts={[50, 20, 10, 10, 6, 4].map((v, i) => ({ label: `P${i}`, value: v }))} />);
    expect(document.querySelectorAll('.ds-stack-part')).toHaveLength(4);
    expect(screen.getByText('Other 20%')).toBeTruthy();
  });
});
