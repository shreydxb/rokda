import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import OverviewNetWorth from './OverviewNetWorth';

const money = { code: 'AED', fmtBalance: (v) => Math.round(v).toLocaleString('en-US'), fmtSigned: (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}` };
const ME = { id: 'm1', display_name: 'Partner A' };
const point = (m, net, isLive = false) => ({ date: new Date(2026, m, 1), label: ['Sep 26', 'Oct 26', 'Nov 26'][m - 8], net, isLive });
const base = {
  scope: 'both', me: ME, members: [ME], netWorthTrustworthy: true, money,
  nw: { netWorth: 100000, unvalued: 0, unpricedHoldings: 0 }, netWorthIsProvisional: false, unconfirmed: [],
  nwChange1mo: { absolute: 2000 }, series: [point(8, 90000), point(9, 98000), point(10, 100000, true)],
};
const show = (over = {}) => render(<MemoryRouter><OverviewNetWorth {...base} {...over} /></MemoryRouter>);

// The cockpit's net worth (the revamp, phase 3): the figure, its change this
// month and its trend, keeping what it rests on in view.
describe('OverviewNetWorth', () => {
  it('shows the figure, its change this month, its trend and a link', () => {
    show();
    expect(screen.getByText(/100,000/)).toBeTruthy();
    expect(screen.getByText(/\+2,000/)).toBeTruthy();
    expect(screen.getByText(/since Sep 26/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Net worth over 3 months' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Net worth →' }).getAttribute('href')).toBe('/wealth');
  });

  it('says a picked month in words, so no figure is only on the chart', () => {
    show();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Net worth over 3 months' }), { key: 'ArrowLeft' });
    expect(document.querySelector('.ov-readout').textContent).toBe('Oct 26 · AED 98,000');
  });

  it('draws no trend with only today to show', () => {
    show({ series: [point(10, 100000, true)] });
    expect(screen.queryByRole('group', { name: /Net worth over/ })).toBeNull();
  });

  it('says Not available, and nothing more, when the figure cannot be trusted', () => {
    show({ netWorthTrustworthy: false });
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.queryByText(/this month/)).toBeNull();
  });

  it('keeps the provisional and incomplete warnings in view, in words and as chips', () => {
    show({ netWorthIsProvisional: true, unconfirmed: [{}, {}], nw: { ...base.nw, unvalued: 1 } });
    expect(screen.getByText(/Provisional — 2 balances not confirmed/)).toBeTruthy();
    expect(screen.getByText(/Incomplete — excludes 1 account/)).toBeTruthy();
    expect(screen.getByText('Provisional').className).toMatch(/ds-chip-warn/);
    expect(screen.getByText('Incomplete').className).toMatch(/ds-chip-warn/);
  });

  it('names whose it is under one person, without the household change', () => {
    show({ scope: 'me' });
    expect(screen.getByRole('region', { name: 'Net worth · Partner A' })).toBeTruthy();
    expect(screen.queryByText(/this month/)).toBeNull();
    // The closed months are the household's (fresh review of the cockpit).
    expect(screen.queryByRole('group', { name: /Net worth over/ })).toBeNull();
  });
});
