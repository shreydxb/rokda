import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Drawdown from './Drawdown';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const ACCOUNT = { id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null };

// Three closed months spending 4,000 on 10,000 of income: 48,000 a year.
function history() {
  const now = new Date();
  return [1, 2, 3].flatMap((back) => {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 10);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`;
    return [
      { id: `i${back}`, amount: 10000, kind: 'income', occurred_at: day, is_shared: true },
      { id: `s${back}`, amount: -4000, kind: 'expense', occurred_at: day, is_shared: true },
    ];
  });
}

function renderDrawdown(props = {}) {
  return renderScreen(
    <Drawdown household={{ id: 'h' }} accounts={[ACCOUNT]} transactions={history()} holdings={[]} data={{ assumptions: null }} loading={false} {...props} />,
  );
}

afterEach(() => localStorage.clear());

// The headline figure. Each market's figure is repeated in the comparison
// below it, so the hero is read on its own.
const hero = () => document.querySelector('.ov-hero').textContent;

describe('Drawdown: how long the money lasts', () => {
  it('starts from the independence target, which at 4% and 3.4% real lasts 51 years', () => {
    renderDrawdown();
    expect(hero()).toBe('51 years');
    expect(screen.getByText(/Spending AED 48,000 a year from AED 1,200,000/)).toBeTruthy();
  });

  it('switches to what is held today', () => {
    renderDrawdown();
    fireEvent.click(screen.getByText(/Stopping today/));
    // 200,000 at 48,000 a year runs out in the fifth year.
    expect(hero()).toBe('4 years');
  });

  it('a lower return shortens it', () => {
    renderDrawdown();
    fireEvent.click(screen.getByLabelText('Lower return'));
    expect(hero()).not.toBe('51 years');
  });

  it('says there is nothing to draw on when net worth is not above zero', () => {
    renderDrawdown({ accounts: [{ ...ACCOUNT, balance: 0, balance_aed: 0 }] });
    fireEvent.click(screen.getByText(/Stopping today/));
    expect(screen.getByText('Nothing to draw on')).toBeTruthy();
  });

  it('shows a way back to Forecast when there is not enough history', () => {
    renderDrawdown({ transactions: [] });
    expect(screen.getByText('Not enough to project')).toBeTruthy();
  });
});

describe('Drawdown: other income once working stops', () => {
  const RENT = { id: 'r1', name: 'Flat rent', kind: 'yearly', amount: 24000, starts_after_years: 0, lasts_years: null, note: '' };
  const GRATUITY = { id: 'g1', name: 'Gratuity', kind: 'lump_sum', amount: 90000, starts_after_years: 0, lasts_years: null, note: '' };

  it('lists each source and says when it pays', () => {
    renderDrawdown({ data: { assumptions: null, independenceIncome: [RENT, GRATUITY] } });
    expect(screen.getByText('Flat rent')).toBeTruthy();
    expect(screen.getByText(/From the first year, for good · lowers the target/)).toBeTruthy();
    expect(screen.getByText(/One-off, in the first year of independence/)).toBeTruthy();
  });

  it('lowers the target by lasting income, the same as Forecast', () => {
    // 48,000 spend less 24,000 of lasting rent, at 4%: 600,000.
    renderDrawdown({ data: { assumptions: null, independenceIncome: [RENT] } });
    expect(screen.getByText(/from AED 600,000/)).toBeTruthy();
  });

  it('makes today’s pot last longer', () => {
    renderDrawdown({ data: { assumptions: null, independenceIncome: [RENT] } });
    fireEvent.click(screen.getByText(/Stopping today/));
    // 200,000 paying 24,000 a year (48,000 less rent) lasts far past the 4 years it does alone.
    expect(hero()).not.toBe('4 years');
  });

  it('offers to add one when there are none', () => {
    renderDrawdown();
    expect(screen.getByText(/None added/)).toBeTruthy();
    fireEvent.click(screen.getByText('+ Income'));
    expect(screen.getByRole('dialog', { name: 'Add income' })).toBeTruthy();
  });
});

describe('Drawdown: a market fall, early or late', () => {
  it('compares the same fall in year 1 and year 10 against steady', () => {
    renderDrawdown();
    const cards = [...document.querySelectorAll('.dd-market')];
    const years = (card) => Number(card.querySelector('.fig').textContent.match(/^(\d+) years?$/)[1]);
    expect(cards.map((c) => c.firstChild.textContent)).toEqual(['Steady', 'Fall in year 1', 'Fall in year 10']);
    expect(years(cards[0])).toBe(51);
    // The same fall costs more when it comes first.
    expect(years(cards[1])).toBeLessThan(years(cards[2]));
    expect(years(cards[2])).toBeLessThan(51);
    expect(cards[1].textContent).toMatch(/years? shorter than steady/);
  });

  it('choosing a fall moves the headline, the answer and the chart with it', () => {
    renderDrawdown();
    const early = [...document.querySelectorAll('.dd-market')][1];
    const earlyYears = early.querySelector('.fig').textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Fall in year 1' }));
    expect(hero()).toBe(earlyYears);
    expect(screen.getByText(/A fall of 20% then 10% after inflation starts in year 1\./)).toBeTruthy();
    expect(screen.getByText(/even with the fall in year 1/)).toBeTruthy();
    // The steady path stays on the chart to compare against.
    expect(screen.getByText('Steady', { selector: 'text' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Return' })).toBeTruthy();
  });

  it('shows a year the pot lost money as a loss, not a gain', () => {
    renderDrawdown();
    fireEvent.click(screen.getByText(/Stopping today/));
    fireEvent.click(screen.getByRole('button', { name: 'Fall in year 1' }));
    // 200,000 less 48,000 spent is 152,000; 20% of that is lost in year 1.
    const year1 = screen.getAllByRole('row').find((r) => r.firstChild?.textContent === '1');
    expect(year1.textContent).toMatch(/−30,400/);
    expect(year1.textContent).toMatch(/−20\.0%/);
  });

  it('keeps working when the chosen year is past the end of a shorter chart', () => {
    renderDrawdown();
    // Pick the last year of the 60-year chart, then shorten the chart.
    const chart = document.querySelector('.ch');
    chart.focus();
    fireEvent.keyDown(chart, { key: 'End' });
    fireEvent.click(screen.getByText(/Stopping today/));
    fireEvent.click(screen.getByRole('button', { name: 'Fall in year 1' }));
    expect(hero()).toMatch(/years?$/);
    expect(document.querySelector('.ov-chart-readout').textContent).toMatch(/^Year \d+/);
  });

  it('a late fall changes nothing for a pot already gone', () => {
    renderDrawdown();
    fireEvent.click(screen.getByText(/Stopping today/));
    const late = [...document.querySelectorAll('.dd-market')][2];
    expect(late.textContent).toMatch(/The pot is gone before year 10/);
  });
});

describe('Drawdown: the budget stands in until three months close', () => {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const categories = [{ id: 'rent', kind: 'expense', is_savings: false }];
  const budgets = [{ id: 'b1', category_id: 'rent', year: now.getFullYear(), month: now.getMonth() + 1, amount: '4000' }];

  it('shows how long it lasts from the budgeted spend, and says where it came from', () => {
    renderDrawdown({ transactions: [{ id: 'o1', amount: -900, kind: 'expense', occurred_at: thisMonth, is_shared: true }], budgets, categories });
    // 4,000 a month budgeted: the same 48,000 a year as three months of history.
    expect(hero()).toBe('51 years');
    expect(screen.getByRole('note').textContent).toMatch(/From your budget, for now/);
    expect(screen.getByText(/Budgeted · 48K a year/)).toBeTruthy();
  });

  it('with neither history nor a budget, says both would do', () => {
    renderDrawdown({ transactions: [] });
    expect(screen.getByText(/or a\s+monthly budget until then/)).toBeTruthy();
  });
});
