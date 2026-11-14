import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import OverviewNetWorth from './OverviewNetWorth';

const money = { code: 'AED', fmtBalance: (v) => Math.round(v).toLocaleString('en-US'), fmtSigned: (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}` };
const ME = { id: 'm1', display_name: 'Partner A' };
const base = {
  scope: 'both', me: ME, members: [ME], netWorthTrustworthy: true, money,
  nw: { netWorth: 100000, unvalued: 0, unpricedHoldings: 0 }, netWorthIsProvisional: false, unconfirmed: [],
  nwChange1mo: { absolute: 2000 }, runway: { available: true, months: 6.4 },
};
const show = (over = {}) => render(<MemoryRouter><OverviewNetWorth {...base} {...over} /></MemoryRouter>);

// The Overview redesign (November 2026): net worth as the fifth figure keeps
// what it rests on in view.
describe('OverviewNetWorth', () => {
  it('shows the figure, its change this month, the runway to one place and a link', () => {
    show();
    expect(screen.getByText(/100,000/)).toBeTruthy();
    expect(screen.getByText(/\+2,000/)).toBeTruthy();
    expect(screen.getByText('Runway 6.4 months')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Net worth →' }).getAttribute('href')).toBe('/wealth');
  });

  it('never rounds a short runway down to nothing, and says one month as one', () => {
    show({ runway: { available: true, months: 0.4 } });
    expect(screen.getByText('Runway 0.4 months')).toBeTruthy();
    document.body.innerHTML = '';
    show({ runway: { available: true, months: 1 } });
    expect(screen.getByText('Runway 1.0 month')).toBeTruthy();
  });

  it('says Not available, and nothing more, when the figure cannot be trusted', () => {
    show({ netWorthTrustworthy: false });
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.queryByText(/this month/)).toBeNull();
  });

  it('keeps the provisional and incomplete warnings in view', () => {
    show({ netWorthIsProvisional: true, unconfirmed: [{}, {}], nw: { ...base.nw, unvalued: 1 } });
    expect(screen.getByText(/Provisional — 2 balances not confirmed/)).toBeTruthy();
    expect(screen.getByText(/Incomplete — excludes 1 account/)).toBeTruthy();
  });

  it('names whose it is under one person, without the household change', () => {
    show({ scope: 'me' });
    expect(screen.getByText('Net worth · Partner A')).toBeTruthy();
    expect(screen.queryByText(/this month/)).toBeNull();
  });
});
