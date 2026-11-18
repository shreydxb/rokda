import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, within, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// The prefs row as the database holds it: every signal on, the default.
const ROW = {
  recurring_enabled: true,
  credit_card_enabled: true,
  cash_cover_enabled: true,
  brief_enabled: true,
  unusual_spend_enabled: false,
  balance_checkin_enabled: true,
  statement_enabled: true,
  dividends_enabled: true,
};
const calls = vi.hoisted(() => ({ selected: [], upserts: [], rpcs: [], log: [], rpcError: null, rpcEmpty: false }));
vi.mock('../../lib/supabaseClient', () => {
  const chain = (table) => {
    const c = {
      select: (cols) => {
        calls.selected.push({ table, cols });
        return c;
      },
      eq: () => c,
      gte: () => Promise.resolve({ data: calls.log, error: null }),
      upsert: (row) => {
        calls.upserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      // Returns only the columns asked for, as PostgREST does.
      maybeSingle: () => {
        const cols = calls.selected.at(-1).cols.split(',').map((x) => x.trim());
        return Promise.resolve({ data: Object.fromEntries(cols.map((k) => [k, ROW[k]])), error: null });
      },
    };
    return c;
  };
  return {
    supabase: {
      from: chain,
      rpc: async (name, args) => {
        calls.rpcs.push({ name, args });
        if (calls.rpcError) return { data: null, error: calls.rpcError };
        return { data: calls.rpcEmpty ? null : '0123456789abcdef0123456789abcdef', error: null };
      },
    },
  };
});

const { default: Telegram } = await import('./Telegram');

beforeEach(() => {
  calls.selected.length = 0;
  calls.upserts.length = 0;
  calls.rpcs.length = 0;
  calls.log = [];
  calls.rpcError = null;
  calls.rpcEmpty = false;
});
afterEach(() => vi.unstubAllEnvs());

const ME = { id: 'm1', display_name: 'Alex', role: 'owner', user_id: 'u1', telegram_user_id: 1 };
const PARTNER = { id: 'm2', display_name: 'Sam', role: 'member', user_id: 'u2', telegram_user_id: null };

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}
const where = () => screen.getByTestId('where').textContent;

async function renderTelegram({ me = ME, at = '/settings?tab=telegram' } = {}) {
  await act(async () => {
    renderScreen(
      <MemoryRouter initialEntries={[at]}>
        <Telegram household={{ id: 'h1' }} members={[ME, PARTNER]} me={me} loading={false} />
        <Where />
      </MemoryRouter>,
    );
  });
}
const morning = () => screen.getByRole('region', { name: 'Morning message' });
const questions = () => screen.getByRole('region', { name: 'Questions that need an answer' });

// Settings -> Telegram like the prototype (the revamp, phase 7): two cards of
// switches, the linked accounts with the link drawer, and Diagnostics folded.
describe('Telegram: the switches', () => {
  it('groups what comes in the morning apart from the questions', async () => {
    await renderTelegram();
    expect(within(morning()).getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['Missed bills', 'Card due dates', 'Cash cover', 'Unusual spending', 'Weekly and month-end brief']);
    expect(within(questions()).getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['Card statements', 'Dividends', 'Month-end balances']);
    expect(within(morning()).getByRole('link', { name: 'Budget →' }).getAttribute('href')).toBe('/money?tab=budget');
  });

  it('reads each as it is stored, Card statements among them', async () => {
    await renderTelegram();
    expect(within(questions()).getByRole('switch', { name: 'Card statements' }).getAttribute('aria-checked')).toBe('true');
    expect(within(morning()).getByRole('switch', { name: 'Unusual spending' }).getAttribute('aria-checked')).toBe('false');
    expect(calls.selected.find((s) => s.table === 'telegram_notification_prefs').cols).toMatch(/statement_enabled/);
  });

  it('saves the dividend question as dividends_enabled', async () => {
    await renderTelegram();
    const toggle = within(questions()).getByRole('switch', { name: 'Dividends' });
    await act(async () => fireEvent.click(toggle));
    expect(calls.upserts.at(-1)).toEqual({ table: 'telegram_notification_prefs', row: { household_id: 'h1', dividends_enabled: false } });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  // The outside review, E-08: each switch saves only its own column, so two
  // switched in quick succession cannot undo each other.
  it("saves each switch on its own, never the other one's old value", async () => {
    await renderTelegram();
    await act(async () => {
      fireEvent.click(within(questions()).getByRole('switch', { name: 'Dividends' }));
      fireEvent.click(within(questions()).getByRole('switch', { name: 'Card statements' }));
    });
    expect(calls.upserts.map((u) => u.row)).toEqual([
      { household_id: 'h1', dividends_enabled: false },
      { household_id: 'h1', statement_enabled: false },
    ]);
  });

  it('says when each one comes', async () => {
    await renderTelegram();
    expect(within(questions()).getByText('When one closes, and 3 days before it is due')).toBeTruthy();
    expect(within(morning()).getByText('Set per category, at 80%, 90% and over')).toBeTruthy();
  });
});

describe('Telegram: linked accounts', () => {
  it('lists each member with a chip, and Link for each to an owner', async () => {
    await renderTelegram();
    const linked = screen.getByRole('region', { name: 'Linked accounts' });
    expect(within(linked).getByRole('button', { name: 'Link again Alex' })).toBeTruthy();
    expect(within(linked).getByRole('button', { name: 'Link Sam' })).toBeTruthy();
    expect(within(linked).getByText('Not linked')).toBeTruthy();
  });

  it('offers a member Link for themselves only', async () => {
    await renderTelegram({ me: PARTNER });
    const linked = screen.getByRole('region', { name: 'Linked accounts' });
    expect(within(linked).queryByRole('button', { name: 'Link again Alex' })).toBeNull();
    expect(within(linked).getByRole('button', { name: 'Link Sam' })).toBeTruthy();
  });

  it('opens the link drawer through the address', async () => {
    await renderTelegram();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Link Sam' })));
    expect(where()).toBe('/settings?tab=telegram&link=m2');
    expect(screen.getByRole('dialog', { name: 'Link Sam' })).toBeTruthy();
  });
});

describe('Telegram: the link drawer', () => {
  it('makes a code for the member, with Copy, and says it works once', async () => {
    await renderTelegram({ at: '/settings?tab=telegram&link=m2' });
    const drawer = screen.getByRole('dialog', { name: 'Link Sam' });
    expect(calls.rpcs).toEqual([{ name: 'generate_telegram_link_code', args: { p_member_id: 'm2' } }]);
    expect(within(drawer).getByText('0123456789abcdef0123456789abcdef')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(within(drawer).getByText('Works once, for 15 minutes.')).toBeTruthy();
  });

  it('opens the bot with the code, and draws it as a QR code, when the bot is named', async () => {
    vi.stubEnv('VITE_TELEGRAM_BOT', 'test_bot');
    await renderTelegram({ at: '/settings?tab=telegram&link=m2' });
    const drawer = screen.getByRole('dialog', { name: 'Link Sam' });
    expect(within(drawer).getByRole('link', { name: 'Open Telegram' }).getAttribute('href')).toBe('https://t.me/test_bot?start=0123456789abcdef0123456789abcdef');
    expect(await within(drawer).findByRole('img', { name: 'QR code to open Telegram' })).toBeTruthy();
  });

  it('gives the code alone when the bot is not named', async () => {
    vi.stubEnv('VITE_TELEGRAM_BOT', '');
    await renderTelegram({ at: '/settings?tab=telegram&link=m2' });
    const drawer = screen.getByRole('dialog', { name: 'Link Sam' });
    expect(within(drawer).queryByRole('link', { name: 'Open Telegram' })).toBeNull();
    expect(within(drawer).getByText('Send this code to the bot.')).toBeTruthy();
  });

  it('closes by taking the member out of the address', async () => {
    await renderTelegram({ at: '/settings?tab=telegram&link=m2' });
    const drawer = screen.getByRole('dialog', { name: 'Link Sam' });
    await act(async () => fireEvent.click(within(drawer).getAllByRole('button', { name: 'Close' }).at(-1)));
    expect(where()).toBe('/settings?tab=telegram');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('makes no code for another member when not an owner', async () => {
    await renderTelegram({ me: PARTNER, at: '/settings?tab=telegram&link=m1' });
    const drawer = screen.getByRole('dialog', { name: 'Link Alex' });
    expect(within(drawer).getByText('Only an owner can link another member.')).toBeTruthy();
    expect(calls.rpcs).toHaveLength(0);
  });

  it('says when no code could be made, and tries again', async () => {
    calls.rpcError = { message: 'not allowed' };
    await renderTelegram({ at: '/settings?tab=telegram&link=m2' });
    const drawer = screen.getByRole('dialog', { name: 'Link Sam' });
    expect(within(drawer).getByRole('alert').textContent).toBe('not allowed');
    calls.rpcError = null;
    await act(async () => fireEvent.click(within(drawer).getByRole('button', { name: 'Try again' })));
    expect(within(drawer).getByText('0123456789abcdef0123456789abcdef')).toBeTruthy();
  });

  it('says so, rather than waiting, when no code comes back', async () => {
    calls.rpcEmpty = true;
    await renderTelegram({ at: '/settings?tab=telegram&link=m2' });
    const drawer = screen.getByRole('dialog', { name: 'Link Sam' });
    expect(within(drawer).getByRole('alert').textContent).toBe('No code came back. Try again.');
    expect(within(drawer).queryByRole('img')).toBeNull();
  });

  it('opens for no one when the address names no member', async () => {
    await renderTelegram({ at: '/settings?tab=telegram&link=gone' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.rpcs).toHaveLength(0);
  });
});

describe('Telegram: diagnostics', () => {
  it('counts the messages handled and read without error, by day, folded', async () => {
    const day = new Date().toISOString().slice(0, 10);
    calls.log = [
      { occurred_at: `${day}T08:00:00Z`, success: true },
      { occurred_at: `${day}T09:00:00Z`, success: true },
      { occurred_at: `${day}T10:00:00Z`, success: false },
      { occurred_at: `${day}T11:00:00Z`, success: true },
    ];
    await renderTelegram();
    const fold = screen.getByText('Diagnostics · last 30 days').closest('details');
    expect(fold.open).toBe(false);
    await waitFor(() => expect(within(fold).getByText('Messages handled')).toBeTruthy());
    expect([...fold.querySelectorAll('.st-diag-fig')].map((f) => f.textContent)).toEqual(['4', '75%']);
    expect(within(fold).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Day', 'Messages']);
    expect(calls.selected.find((s) => s.table === 'telegram_call_log').cols).not.toMatch(/tokens/);
  });

  it('says when there were none', async () => {
    await renderTelegram();
    const fold = screen.getByText('Diagnostics · last 30 days').closest('details');
    await waitFor(() => expect(within(fold).getByText('No messages in the last 30 days.')).toBeTruthy());
  });
});
