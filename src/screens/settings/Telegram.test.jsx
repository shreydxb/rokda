import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
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
};
const selected = [];
vi.mock('../../lib/supabaseClient', () => {
  const chain = (table) => {
    const c = {
      select: (cols) => {
        selected.push({ table, cols });
        return c;
      },
      eq: () => c,
      gte: () => Promise.resolve({ data: [], error: null }),
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
