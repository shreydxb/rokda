import { describe, it, expect } from 'vitest';
import { amountInCategory, categoryParts, inCategory, splitProblem, unallocated } from './splits';

const receipt = {
  amount: -500,
  is_split: true,
  category_id: null,
  transaction_splits: [
    { category_id: 'groceries', amount: -400 },
    { category_id: 'household', amount: -100 },
  ],
};

describe('categoryParts', () => {
  it('is the whole record for an ordinary one', () => {
    expect(categoryParts({ amount: -60, category_id: 'fuel' })).toEqual([{ categoryId: 'fuel', amount: -60 }]);
    expect(categoryParts({ amount: -60, category_id: null })).toEqual([{ categoryId: null, amount: -60 }]);
  });

  it('is one part per line for a split one, adding up to it', () => {
    const parts = categoryParts(receipt);
    expect(parts).toEqual([
      { categoryId: 'groceries', amount: -400 },
      { categoryId: 'household', amount: -100 },
    ]);
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(-500);
  });

  it('gives nothing to any category when a split record came without its lines', () => {
    expect(categoryParts({ ...receipt, transaction_splits: undefined })).toEqual([]);
  });
});

describe('amountInCategory and inCategory', () => {
  it('counts only the line in the category asked about', () => {
    expect(amountInCategory(receipt, 'household')).toBe(-100);
    expect(amountInCategory(receipt, new Set(['groceries', 'household']))).toBe(-500);
    expect(amountInCategory(receipt, 'fuel')).toBe(0);
    expect(inCategory(receipt, 'groceries')).toBe(true);
    expect(inCategory(receipt, 'fuel')).toBe(false);
  });
});

describe('splitProblem', () => {
  const line = (category_id, amount) => ({ category_id, amount });
  it('accepts lines that add up to the total, to the cent', () => {
    expect(splitProblem([line('a', '0.1'), line('b', '0.2')], 0.3)).toBe('');
    expect(unallocated([line('a', '400'), line('b', '99.99')], 500)).toBe(0.01);
  });

  it('says what is wrong otherwise', () => {
    expect(splitProblem([line('a', '500')], 500)).toMatch(/at least two/);
    expect(splitProblem([line('a', '400'), line('', '100')], 500)).toMatch(/category for every line/);
    expect(splitProblem([line('a', '400'), line('b', '0')], 500)).toMatch(/above zero/);
    expect(splitProblem([line('a', '400'), line('a', '100')], 500)).toMatch(/Each category once/);
    expect(splitProblem([line('a', '400'), line('b', '50')], 500)).toBe('50.00 still to allocate.');
    expect(splitProblem([line('a', '400'), line('b', '150')], 500)).toBe('The lines are 50.00 more than the total.');
  });
});
