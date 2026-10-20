import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderScreen } from '../../test/renderScreen';

// The type choice says what each kind of entry is for, with an example and
// what saving it makes, so a card payment is recorded as money moved rather
// than money spent (SHR-326).
vi.mock('../../lib/supabaseClient', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }) }) } }));

const { default: TransactionEditor } = await import('./TransactionEditor');
const { default: TransferEditor } = await import('./TransferEditor');

const ACCOUNTS = [
  { id: 'current', name: 'Current account', type: 'checking', archived_at: null, is_shared: true },
  { id: 'card', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true },
];
const note = () => document.querySelector('.te-type-note').textContent;

describe('Choosing what an entry is', () => {
  it('explains the chosen type with an example, and points a moved payment to Transfer', () => {
    renderScreen(<TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} onClose={() => {}} onSaved={() => {}} onSwitchToTransfer={() => {}} />);
    expect(note()).toBe('Money spent: groceries, a bill, something bought on the card. One record, counted as spending. Moved money between your own accounts? Choose Transfer.');
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    expect(note()).toMatch(/^Money back on an earlier purchase: something returned to a shop\. Linked to the purchase you choose/);
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    expect(note()).toMatch(/^Money earned or received: salary, interest, a gift\. One record, counted as income\./);
  });

  it('says the same about a transfer in the transfer editor', () => {
    renderScreen(<TransferEditor transfer={null} householdId="hh" accounts={ACCOUNTS} members={[]} onClose={() => {}} onSaved={() => {}} />);
    expect(note()).toBe(
      'Money moved between your own accounts: paying the card, putting money into savings. Two records kept together, one out and one in, counted as neither income nor spending.',
    );
  });
});
