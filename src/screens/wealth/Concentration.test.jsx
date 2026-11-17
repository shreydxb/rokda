import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      update: (payload) => ({
        eq: async (_field, id) => {
          writes.push({ table, payload, id });
          return { error: null };
        },
      }),
    }),
  },
}));

const { default: Concentration } = await import('./Concentration');

const PRICED = '2026-09-01T00:00:00Z';
const holding = (name, value, extra = {}) => ({ id: name, name, value_aed: value, asset_class: 'us_equity', is_shared: true, priced_at: PRICED, ...extra });
const CHIPS = [holding('Chip A', 3000, { sector: 'technology' }), holding('Chip B', 2700, { sector: 'technology' }), holding('World fund', 4300, { sector: 'broad' })];

function render(holdings, household = { id: 'hh', concentration_cap_pct: null }, { onCapSaved = vi.fn(), onOpenHolding = vi.fn() } = {}) {
  renderScreen(<Concentration holdings={holdings} scopeMemberId={null} household={household} onCapSaved={onCapSaved} onOpenHolding={onOpenHolding} />);
  return { onCapSaved, onOpenHolding };
}
const block = () => document.querySelector('.inv-conc').textContent;
const bar = () => screen.getByRole('progressbar');

beforeEach(() => {
  writes.length = 0;
  cleanup();
});

// Wealth said nothing when most of the investments sat in one sector
// (Planning audit, 4.17). Under Allocation (the revamp, phase 5b), the
// largest concentration and its share as a bar, against the household's cap,
// whose tick it carries.
describe('the largest concentration', () => {
  it('names the largest sector and its share, and offers a cap', () => {
    render(CHIPS);
    expect(block()).toContain('Technology · sector');
    expect(block()).toContain('57%');
    expect(bar().getAttribute('aria-label')).toBe('Technology: 57% of investments');
    expect(screen.getByRole('button', { name: 'Set a cap' })).toBeTruthy();
    expect(document.querySelector('.ds-bar-tick')).toBeNull();
  });

  it('says when that is past the cap, and when it is within it, the cap a tick on the bar', () => {
    render(CHIPS, { id: 'hh', concentration_cap_pct: '25.00' });
    expect(screen.getByText('Above 25% cap').className).toContain('ds-chip-warn');
    expect(document.querySelector('.ds-bar-fill').className).toContain('ds-bar-warn');
    expect(document.querySelector('.ds-bar-tick')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change cap' })).toBeTruthy();
    cleanup();
    render(CHIPS, { id: 'hh', concentration_cap_pct: 60 });
    expect(screen.getByText('Within 60% cap').className).toContain('ds-chip-pos');
  });

  it('names one holding when no sector is larger, and opens the one most worth tagging', () => {
    const { onOpenHolding } = render([holding('Chip A', 3000), holding('Oil', 1000, { sector: 'energy' })]);
    expect(block()).toContain('Chip A · one holding');
    expect(block()).toContain('75%');
    fireEvent.click(screen.getByRole('button', { name: '1 untagged' }));
    expect(onOpenHolding).toHaveBeenCalledWith('Chip A');
  });

  it('names the sector of a holding that stands alone in it', () => {
    render([holding('A', 254, { sector: 'technology' }), holding('B', 746, { sector: 'broad' })], { id: 'hh', concentration_cap_pct: 25 });
    expect(block()).toContain('A · one holding in Technology');
  });

  it('says nothing stands out when everything is in broad funds, and nothing with nothing invested', () => {
    render([holding('World fund', 4300, { sector: 'broad' })]);
    expect(block()).toContain('Nothing stands out: everything invested is in funds spread across sectors');
    expect(screen.queryByRole('progressbar')).toBeNull();
    cleanup();
    render([holding('Cash', 4300, { asset_class: 'cash' })]);
    expect(document.querySelector('.inv-conc')).toBeNull();
  });

  it('saves a cap for the household and reloads it', async () => {
    const { onCapSaved } = render(CHIPS);
    fireEvent.click(screen.getByRole('button', { name: 'Set a cap' }));
    const input = screen.getByLabelText('No single sector or holding above');
    fireEvent.change(input, { target: { value: '0' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByRole('alert').textContent).toBe('Enter a share above 0 and at most 100.');
    expect(writes).toEqual([]);
    fireEvent.change(input, { target: { value: '25' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(writes).toEqual([{ table: 'households', payload: { concentration_cap_pct: 25 }, id: 'hh' }]);
    expect(onCapSaved).toHaveBeenCalledTimes(1);
  });

  it('clears a cap with No cap', async () => {
    render(CHIPS, { id: 'hh', concentration_cap_pct: 25 });
    fireEvent.click(screen.getByRole('button', { name: 'Change cap' }));
    expect(screen.getByLabelText('No single sector or holding above').value).toBe('25');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'No cap' })));
    expect(writes).toEqual([{ table: 'households', payload: { concentration_cap_pct: null }, id: 'hh' }]);
  });

  it('shows a share that rounds to the cap with a decimal, so above reads true', () => {
    render([holding('A', 254, { sector: 'technology' }), holding('B', 746, { sector: 'broad' })], { id: 'hh', concentration_cap_pct: 25 });
    expect(block()).toContain('25.4%');
    expect(screen.getByText('Above 25% cap')).toBeTruthy();
  });
});
