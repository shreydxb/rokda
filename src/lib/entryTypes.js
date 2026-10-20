// What each kind of entry is for, with an everyday example and what saving it
// makes, shown under the type choice in the transaction and transfer editors
// (SHR-326). Picking between "money spent" and "money moved" is where a card
// payment used to be recorded as spending; the same wording in both editors
// keeps the choice the same wherever it is made.
export const ENTRY_TYPES = {
  expense: {
    label: 'Expense',
    meaning: 'Money spent: groceries, a bill, something bought on the card.',
    result: 'One record, counted as spending.',
  },
  income: {
    label: 'Income',
    meaning: 'Money earned or received: salary, interest, a gift.',
    result: 'One record, counted as income.',
  },
  refund: {
    label: 'Refund',
    meaning: 'Money back on an earlier purchase: something returned to a shop.',
    result: 'Linked to the purchase you choose, it takes that category and reduces the spending.',
  },
  transfer: {
    label: 'Transfer',
    meaning: 'Money moved between your own accounts: paying the card, putting money into savings.',
    result: 'Two records kept together, one out and one in, counted as neither income nor spending.',
  },
};
