import { describe, it, expect, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The prefs row as the database holds it: every signal on, the default.
const ROW = {
  recurring_enabled: true,
  credit_card_enabled: true,
  cash_cover_enabled: true,
  brief_enabled: true,
  unusual_spend_enabled: true,
  balance_checkin_enabled: true,
  statement_enabled: true,
  dividends_enabled: true,
};
const selected = [];
const upserts = [];
vi.mock('../../lib/supabaseClient', () => {
  const chain = (table) => {
    const c = {
      select: (cols) => {
        selected.push({ table, cols });
        return c;
      },
      eq: () => c,
      gte: () => Promise.resolve({ data: [], error: null }),
      upsert: (row) => {
        upserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      // Returns only the columns asked for, as PostgREST does.
      maybeSingle: () => {
        const cols = selected.at(-1).cols.split(',').map((x) => x.trim());
        return Promise.resolve({ data: Object.fromEntries(cols.map((k) => [k, ROW[k]])), error: null });
      },
    };
    return c;
  };
  return { supabase: { from: chain } };
});

const { default: Telegram } = await import('./Telegram');

describe('Telegram: each signal reads as it is stored', () => {
  it('shows Card statements as On when the stored row has it on', async () => {
    await act(async () => {
      renderScreen(<Telegram household={{ id: 'h1' }} loading={false} />);
    });
    const row = screen.getByText('Card statements').closest('button');
    expect(within(row).getByText('On')).toBeTruthy();
    expect(screen.queryByText('Off')).toBeNull();
    expect(selected.find((s) => s.table === 'telegram_notification_prefs').cols).toMatch(/statement_enabled/);
  });
});

describe('Telegram: the dividend question', () => {
  it('is a switch of its own, saved as dividends_enabled', async () => {
    await act(async () => {
      renderScreen(<Telegram household={{ id: 'h1' }} loading={false} />);
    });
    const row = screen.getByText('Dividends').closest('button');
    expect(within(row).getByText('Each morning, asks about dividends paid into a broker fund that day; reply "yes" once they\'re in')).toBeTruthy();
    expect(within(row).getByText('On')).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(upserts.at(-1)).toEqual({ table: 'telegram_notification_prefs', row: expect.objectContaining({ household_id: 'h1', dividends_enabled: false }) });
    expect(within(row).getByText('Off')).toBeTruthy();
  });
});

// The outside review, E-08: each switch saves only its own column, so two
// switched in quick succession cannot undo each other.
describe('Telegram: two switches flipped together', () => {
  it('saves each switch on its own, never the other one\'s old value', async () => {
    await act(async () => {
      renderScreen(<Telegram household={{ id: 'h1' }} loading={false} />);
    });
    upserts.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByText('Dividends').closest('button'));
      fireEvent.click(screen.getByText('Card statements').closest('button'));
    });
    expect(upserts.map((u) => u.row)).toEqual([
      { household_id: 'h1', dividends_enabled: false },
      { household_id: 'h1', statement_enabled: false },
    ]);
  });
});
