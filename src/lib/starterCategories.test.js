import { describe, it, expect } from 'vitest';
import { STARTER_TEMPLATE, missingKeys, planStarter, starterInserts } from './starterCategories';

const HH = 'h1';
let n = 0;
const cat = (name, kind = 'expense', parent_id = null, extra = {}) => ({ id: `c${++n}`, name, kind, parent_id, archived: false, ...extra });

// A set a household built by hand, named its own way.
function handBuilt() {
  const housing = cat('Housing');
  const utilities = cat('Utilities');
  const food = cat('Food & Dining');
  const transport = cat('Transport');
  const subs = cat('Subscriptions');
  return [
    housing,
    cat('Rent', 'expense', housing.id),
    utilities,
    cat('DEWA', 'expense', utilities.id),
    cat('Du Wifi', 'expense', utilities.id),
    food,
    cat('Groceries', 'expense', food.id),
    cat('Weekend Outings', 'expense', food.id),
    transport,
    cat('Car EMI', 'expense', transport.id),
    cat('Salik / Parking / Misc', 'expense', transport.id),
    subs,
    cat('Mobile Bill (A)', 'expense', subs.id),
    cat('Netflix / Gdrive', 'expense', subs.id),
    cat('Salary', 'income'),
  ];
}

const group = (plan, name) => plan.find((g) => g.name === name);
const child = (plan, g, c) => group(plan, g).children.find((x) => x.name === c);

describe('planStarter: what a household already has', () => {
  it('offers everything to a household with nothing', () => {
    const plan = planStarter([]);
    const total = STARTER_TEMPLATE.flatMap((t) => t.groups).reduce((s, g) => s + (g.flat ? 0 : 1) + g.children.length, 0);
    expect(missingKeys(plan)).toHaveLength(total);
  });

  it('recognises groups and categories under the household’s own names', () => {
    const plan = planStarter(handBuilt());
    expect(group(plan, 'Housing').existing?.name).toBe('Housing');
    expect(child(plan, 'Housing', 'Rent or mortgage').existing?.name).toBe('Rent');
    expect(child(plan, 'Utilities', 'Electricity & water').existing?.name).toBe('DEWA');
    expect(child(plan, 'Utilities', 'Internet').existing?.name).toBe('Du Wifi');
    expect(child(plan, 'Food & Dining', 'Eating out').existing?.name).toBe('Weekend Outings');
    expect(child(plan, 'Transport', 'Car loan').existing?.name).toBe('Car EMI');
    expect(child(plan, 'Transport', 'Salik & parking').existing?.name).toBe('Salik / Parking / Misc');
  });

  it('finds a category filed under a different group', () => {
    // A mobile bill kept under Subscriptions is still the mobile bill.
    const plan = planStarter(handBuilt());
    expect(child(plan, 'Utilities', 'Mobile').existing?.name).toBe('Mobile Bill (A)');
    expect(child(plan, 'Subscriptions', 'Streaming').existing?.name).toBe('Netflix / Gdrive');
  });

  it('recognises ungrouped categories in a household that never made groups', () => {
    const plan = planStarter([cat('Rent'), cat('Dining out'), cat('Groceries')]);
    expect(child(plan, 'Housing', 'Rent or mortgage').existing?.name).toBe('Rent');
    expect(child(plan, 'Food & Dining', 'Eating out').existing?.name).toBe('Dining out');
  });

  it('does not count a group as one of its own categories', () => {
    // "Travel" is the Travel group, not a match for anything inside it.
    const plan = planStarter([cat('Travel'), cat('Gifts')]);
    expect(group(plan, 'Travel').existing?.name).toBe('Travel');
    expect(group(plan, 'Gifts & Giving').existing?.name).toBe('Gifts');
    expect(child(plan, 'Gifts & Giving', 'Gifts').existing).toBeNull();
  });

  it('matches on words, not fragments', () => {
    const plan = planStarter([cat('Travel'), cat('Car Rental', 'expense', 'x')]);
    expect(child(plan, 'Housing', 'Rent or mortgage').existing).toBeNull();
  });

  it('keeps income and expense apart, and income flat', () => {
    const plan = planStarter(handBuilt());
    expect(child(plan, 'Income', 'Salary').existing?.kind).toBe('income');
    expect(missingKeys(plan)).not.toContain('Income');
    const { groups, children } = starterInserts(plan, ['Income/Bonus'], HH);
    expect(groups).toEqual([]);
    expect(children(new Map())).toEqual([{ household_id: HH, name: 'Bonus', kind: 'income', parent_id: null }]);
  });

  it('looks inside the matching group before anywhere else', () => {
    const family = cat('Family Support');
    const utilities = cat('Utilities');
    const plan = planStarter([family, cat('Hometown Electricity', 'expense', family.id), utilities, cat('DEWA', 'expense', utilities.id)]);
    expect(child(plan, 'Utilities', 'Electricity & water').existing?.name).toBe('DEWA');
  });

  it('counts an archived category as present rather than adding it again', () => {
    const plan = planStarter([cat('Pets'), cat('Vet', 'expense', null, { archived: true })]);
    expect(child(plan, 'Health', 'Doctor & dentist').existing).toBeNull();
    const archivedTravel = planStarter([cat('Travel', 'expense', null, { archived: true })]);
    expect(group(archivedTravel, 'Travel').existing?.archived).toBe(true);
  });
});

describe('starterInserts: what gets written', () => {
  it('adds a missing category under the group the household already has', () => {
    const existing = handBuilt();
    const plan = planStarter(existing);
    const { groups, children } = starterInserts(plan, ['Housing/Maintenance & repairs'], HH);
    expect(groups).toEqual([]);
    const housing = existing.find((c) => c.name === 'Housing');
    expect(children(new Map())).toEqual([{ household_id: HH, name: 'Maintenance & repairs', kind: 'expense', parent_id: housing.id }]);
  });

  it('brings a missing group along with a category picked inside it', () => {
    const plan = planStarter(handBuilt());
    const { groups, children, count } = starterInserts(plan, ['Travel/Flights'], HH);
    expect(groups).toEqual([{ household_id: HH, name: 'Travel', kind: 'expense', parent_id: null }]);
    expect(children(new Map([['Travel', 'new-travel']]))).toEqual([{ household_id: HH, name: 'Flights', kind: 'expense', parent_id: 'new-travel' }]);
    expect(count).toBe(2);
  });

  it('never writes something the household already has, even if picked', () => {
    const plan = planStarter(handBuilt());
    const { groups, children, count } = starterInserts(plan, ['Housing', 'Housing/Rent or mortgage', 'Utilities/Internet'], HH);
    expect(groups).toEqual([]);
    expect(children(new Map())).toEqual([]);
    expect(count).toBe(0);
  });

  it('adds nothing called Savings: moving money into savings is not spending', () => {
    const names = STARTER_TEMPLATE.flatMap((t) => t.groups.flatMap((g) => [g.name, ...g.children.map((c) => c.name)]));
    expect(names.some((x) => /saving|invest/i.test(x))).toBe(false);
  });
});
