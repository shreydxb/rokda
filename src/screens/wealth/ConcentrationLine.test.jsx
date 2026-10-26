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

const { default: ConcentrationLine } = await import('./ConcentrationLine');

const PRICED = '2026-09-01T00:00:00Z';
const holding = (name, value, extra = {}) => ({ id: name, name, value_aed: value, asset_class: 'us_equity', is_shared: true, priced_at: PRICED, ...extra });
const CHIPS = [holding('Chip A', 3000, { sector: 'technology' }), holding('Chip B', 2700, { sector: 'technology' }), holding('World fund', 4300, { sector: 'broad' })];

function render(holdings, household = { id: 'hh', concentration_cap_pct: null }, onCapSaved = vi.fn()) {
  renderScreen(<ConcentrationLine holdings={holdings} scopeMemberId={null} household={household} onCapSaved={onCapSaved} />);
  return onCapSaved;
}
const line = () => document.querySelector('.wl-concentration-line').textContent;

beforeEach(() => {
  writes.length = 0;
  cleanup();
});

// Wealth said nothing when most of the investments sat in one sector
// (Planning audit, 4.17). One line names the largest concentration and its
// share, against the household's cap.
describe('the concentration line', () => {
  it('names the largest sector and its share, and offers a cap', () => {
    render(CHIPS);
    expect(line()).toBe('Largest concentration: Technology, 57% of investmentsSet a cap');
  });

  it('says when that is past the cap, and when it is within it', () => {
    render(CHIPS, { id: 'hh', concentration_cap_pct: '25.00' });
    expect(line()).toBe('Largest concentration: Technology, 57% of investmentsabove your 25% capChange cap');
    expect(screen.getByText('above your 25% cap').className).toBe('ov-warn');
    cleanup();
    render(CHIPS, { id: 'hh', concentration_cap_pct: 60 });
    expect(line()).toMatch(/within your 60% cap/);
  });

  it('names one holding when no sector is larger, and asks for the sectors not tagged', () => {
    render([holding('Chip A', 3000), holding('Oil', 1000, { sector: 'energy' })]);
    expect(line()).toBe('Largest concentration: Chip A, one holding, 75% of investmentsSet a cap');
    expect(screen.getByText(/1 holding has no sector yet, so it counts only on its own/)).toBeTruthy();
  });

  it('says nothing stands out when everything is in broad funds, and nothing with nothing invested', () => {
    render([holding('World fund', 4300, { sector: 'broad' })]);
    expect(line()).toMatch(/^Nothing stands out: everything invested is in funds spread across sectors/);
    cleanup();
    render([holding('Cash', 4300, { asset_class: 'cash' })]);
    expect(document.querySelector('.wl-concentration')).toBeNull();
  });

  it('saves a cap for the household and reloads it', async () => {
    const onCapSaved = render(CHIPS);
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
    expect(line()).toMatch(/^Largest concentration: A \(Technology\), one holding, 25\.4% of investmentsabove your 25% cap/);
  });
});
