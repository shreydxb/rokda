// The outside review, E-12: every field in an editor has an accessible name,
// so a screen reader says what it is for, and a test (or a member) can find
// it by its label. A field named only by a span beside it, or by its
// placeholder, has none.
import { describe, it, expect, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderScreen } from '../test/renderScreen';

// A database that answers every read with nothing, so each editor opens as
// it would for a new household.
vi.mock('../lib/supabaseClient', () => {
  const answer = { data: [], error: null };
  const chain = () =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? (resolve) => resolve(answer) : chain()),
      apply: () => chain(),
    });
  return { supabase: { from: () => chain(), rpc: async () => answer, auth: { getUser: async () => ({ data: { user: null } }) }, storage: { from: () => chain() } } };
});

const ROLES = ['textbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'listbox', 'searchbox', 'switch'];
function unnamedFields() {
  return ROLES.flatMap((role) => screen.queryAllByRole(role, { name: '' }).map((el) => `${role}: ${el.outerHTML.slice(0, 140)}`));
}

const MEMBERS = [{ id: 'm1', display_name: 'Partner A', role: 'owner', user_id: 'u1' }];
const ACCOUNTS = [
  { id: 'a1', name: 'Bank', type: 'checking', currency: 'AED', balance: 100, is_shared: true, owner_member_id: null, archived_at: null },
  { id: 'f1', name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD', balance: 100, is_shared: true, owner_member_id: null, archived_at: null },
];
const CATEGORIES = [{ id: 'c1', name: 'Groceries', kind: 'expense', parent_id: null }];
const HOLDING = { id: 'h1', name: 'ABC', currency: 'USD', asset_class: 'us_equity', quantity: 10, avg_price: 10, current_price: 12, trades_version: 1, funds_account_id: 'f1', is_shared: true, dividend_tax_pct: 30 };
const noop = () => {};

const EDITORS = {
  TransactionEditor: async () => {
    const { default: C } = await import('./money/TransactionEditor');
    return <C tx={null} householdId="h" accounts={ACCOUNTS} categories={CATEGORIES} members={MEMBERS} onClose={noop} onSaved={noop} />;
  },
  TransferEditor: async () => {
    const { default: C } = await import('./money/TransferEditor');
    return <C transfer={null} householdId="h" accounts={ACCOUNTS} members={MEMBERS} onClose={noop} onSaved={noop} />;
  },
  RecurringEditor: async () => {
    const { default: C } = await import('./money/RecurringEditor');
    return <C item={null} householdId="h" accounts={ACCOUNTS} categories={CATEGORIES} members={MEMBERS} onClose={noop} onSaved={noop} />;
  },
  BudgetEditor: async () => {
    const { default: C } = await import('./money/BudgetEditor');
    return <C item={{ category: CATEGORIES[0], categoryId: 'c1', amount: 0 }} householdId="h" categories={CATEGORIES} year={2026} month={11} onClose={noop} onSaved={noop} />;
  },
  AccountEditor: async () => {
    const { default: C } = await import('./wealth/AccountEditor');
    return <C account={null} defaultType="checking" householdId="h" members={MEMBERS} onClose={noop} onSaved={noop} />;
  },
  TradeForm: async () => {
    const { default: C } = await import('./wealth/TradeForm');
    return <C holding={HOLDING} accounts={ACCOUNTS} onCancel={noop} onSaved={noop} />;
  },
  GoalEditor: async () => {
    const { default: C } = await import('./planning/GoalEditor');
    return <C goal={null} contributions={[]} allocations={[]} accounts={ACCOUNTS} holdings={[]} householdId="h" members={MEMBERS} onClose={noop} onSaved={noop} />;
  },
  DebtEditor: async () => {
    const { default: C } = await import('./planning/DebtEditor');
    return <C debt={null} householdId="h" members={MEMBERS} accounts={ACCOUNTS} onClose={noop} onSaved={noop} />;
  },
  IncomeEditor: async () => {
    const { default: C } = await import('./planning/IncomeEditor');
    return <C row={null} householdId="h" onClose={noop} onSaved={noop} />;
  },
  CostEditor: async () => {
    const { default: C } = await import('./planning/CostEditor');
    return <C row={null} householdId="h" onClose={noop} onSaved={noop} />;
  },
  CategoryEditor: async () => {
    const { default: C } = await import('./settings/CategoryEditor');
    return <C category={null} householdId="h" members={MEMBERS} onClose={noop} onSaved={noop} />;
  },
  MemberEditor: async () => {
    const { default: C } = await import('./settings/MemberEditor');
    return <C member={null} householdId="h" isSelf={false} isLastOwner={false} onClose={noop} onSaved={noop} />;
  },
  RuleEditor: async () => {
    const { default: C } = await import('./settings/RuleEditor');
    return <C rule={null} householdId="h" categories={CATEGORIES} onClose={noop} onSaved={noop} />;
  },
};

describe('every editor field has a name', () => {
  for (const [name, make] of Object.entries(EDITORS)) {
    it(name, async () => {
      cleanup();
      renderScreen(await make());
      expect(unnamedFields()).toEqual([]);
    });
  }
});
