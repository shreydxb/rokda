// A starter set of categories, grouped the way a household budget sheet is,
// for a household starting out -- or one filling gaps in the set it built by
// hand. Written for a UAE household paying in AED: DEWA, Salik, visas.
//
// Deliberately no "Savings" group. Money moved into savings or investments is
// not spending, and a category of kind 'expense' would count it as spending
// everywhere a total is taken: net saved, the savings rate, the budget and
// the independence target would all read low.
//
// Each group and category carries match words. Whatever the household already
// has that matches is shown as already there and never added again, so the
// set can be offered to a household that already has one.
export const STARTER_TEMPLATE = [
  {
    kind: 'income',
    groups: [
      {
        // Income stays flat: a handful of sources needs no grouping, and a
        // household with "Salary" at the top level should not be handed an
        // "Income" group to file it under.
        name: 'Income',
        flat: true,
        match: [],
        children: [
          { name: 'Salary', match: ['salary', 'payroll', 'wages'] },
          { name: 'Bonus', match: ['bonus'] },
          { name: 'Interest & dividends', match: ['interest', 'dividend'] },
          { name: 'Rental income', match: ['rental', 'rent received'] },
          { name: 'Other income', match: ['other income'] },
        ],
      },
    ],
  },
  {
    kind: 'expense',
    groups: [
      {
        name: 'Housing',
        match: ['housing', 'home', 'house'],
        children: [
          { name: 'Rent or mortgage', match: ['rent', 'mortgage'] },
          { name: 'Maintenance & repairs', match: ['maintenance', 'repair'] },
          { name: 'Furnishings', match: ['furnishing', 'furnishings', 'furniture'] },
          { name: 'Household help', match: ['maid', 'household help', 'nanny', 'cleaning'] },
        ],
      },
      {
        name: 'Utilities',
        match: ['utilities', 'bills'],
        children: [
          { name: 'Electricity & water', match: ['dewa', 'electricity', 'water', 'sewa', 'addc', 'fewa'] },
          { name: 'Internet', match: ['internet', 'wifi', 'broadband'] },
          { name: 'Mobile', match: ['mobile', 'phone bill', 'recharge'] },
          { name: 'Cooling & gas', match: ['cooling', 'chiller', 'empower', 'gas'] },
        ],
      },
      {
        name: 'Food & Dining',
        match: ['food', 'dining', 'food & dining'],
        children: [
          { name: 'Groceries', match: ['grocery', 'groceries', 'supermarket'] },
          { name: 'Eating out', match: ['eating out', 'restaurant', 'dining out', 'outing'] },
          { name: 'Food delivery', match: ['delivery', 'talabat', 'deliveroo'] },
          { name: 'Coffee', match: ['coffee', 'cafe'] },
        ],
      },
      {
        name: 'Transport',
        match: ['transport', 'transportation', 'car'],
        children: [
          { name: 'Fuel', match: ['fuel', 'petrol'] },
          { name: 'Salik & parking', match: ['salik', 'parking', 'toll'] },
          { name: 'Taxi & metro', match: ['taxi', 'metro', 'careem', 'uber', 'bus'] },
          { name: 'Car service', match: ['car service', 'car wash', 'service'] },
          { name: 'Car loan', match: ['car emi', 'car loan', 'car downpayment'] },
          { name: 'Registration', match: ['registration', 'mulkiya', 'rta'] },
        ],
      },
      {
        name: 'Health',
        match: ['health', 'medical'],
        children: [
          { name: 'Doctor & dentist', match: ['doctor', 'dentist', 'clinic', 'hospital'] },
          { name: 'Pharmacy', match: ['pharmacy', 'medicine'] },
          { name: 'Fitness', match: ['fitness', 'gym'] },
        ],
      },
      {
        name: 'Insurance',
        match: ['insurance'],
        children: [
          { name: 'Health insurance', match: ['health insurance', 'medical insurance'] },
          { name: 'Life insurance', match: ['life insurance', 'term insurance', 'term'] },
          { name: 'Car insurance', match: ['car insurance', 'motor insurance'] },
          { name: 'Home insurance', match: ['home insurance', 'contents insurance'] },
        ],
      },
      {
        name: 'Children',
        match: ['children', 'kids', 'child'],
        children: [
          { name: 'School fees', match: ['school', 'tuition'] },
          { name: 'Childcare', match: ['childcare', 'nursery', 'babysitting', 'babysitter'] },
          { name: 'Activities', match: ['activities', 'classes'] },
        ],
      },
      {
        name: 'Personal Care',
        match: ['personal care', 'personal'],
        children: [
          { name: 'Grooming', match: ['grooming', 'salon', 'barber'] },
          { name: 'Laundry & ironing', match: ['laundry', 'iron', 'ironing', 'dry cleaning'] },
        ],
      },
      {
        name: 'Shopping',
        match: ['shopping'],
        children: [
          { name: 'Clothing', match: ['clothing', 'clothes'] },
          { name: 'Electronics', match: ['electronics', 'gadget'] },
          { name: 'Household items', match: ['household items', 'home supplies'] },
        ],
      },
      {
        name: 'Subscriptions',
        match: ['subscriptions', 'subscription'],
        children: [
          { name: 'Streaming', match: ['netflix', 'streaming', 'spotify', 'osn', 'shahid'] },
          { name: 'Software & cloud', match: ['software', 'cloud', 'gdrive', 'icloud'] },
          { name: 'Memberships', match: ['membership', 'club'] },
        ],
      },
      {
        name: 'Entertainment',
        match: ['entertainment', 'leisure', 'fun'],
        children: [
          { name: 'Outings', match: ['outing', 'cinema', 'movies'] },
          { name: 'Hobbies', match: ['hobby', 'hobbies'] },
        ],
      },
      {
        name: 'Travel',
        match: ['travel', 'vacation', 'holiday', 'holidays'],
        children: [
          { name: 'Flights', match: ['flight', 'airline'] },
          { name: 'Hotels', match: ['hotel', 'lodging'] },
          { name: 'Holiday spending', match: ['holiday spending', 'trip'] },
        ],
      },
      {
        name: 'Family Support',
        match: ['family support', 'family'],
        children: [
          { name: 'Remittances', match: ['remittance', 'transfer home'] },
          { name: 'Family bills', match: ['family bills', 'misc bills'] },
        ],
      },
      {
        name: 'Gifts & Giving',
        match: ['gifts', 'giving', 'charity', 'gifts & giving'],
        children: [
          { name: 'Gifts', match: ['gift'] },
          { name: 'Charity & zakat', match: ['charity', 'zakat', 'donation', 'sadaqah'] },
        ],
      },
      {
        name: 'Fees & Charges',
        match: ['fees', 'charges', 'fees & charges'],
        children: [
          { name: 'Bank & card fees', match: ['bank fee', 'card fee', 'annual fee'] },
          { name: 'Visas & government fees', match: ['visa', 'emirates id', 'government'] },
        ],
      },
    ],
  },
];

const norm = (s) => String(s ?? '').trim().toLowerCase();

// Whole words, plural allowed: 'rent' finds "Rent" and not "Car Rental",
// 'term' finds "Term Insurance" and not "Determined", 'outing' finds
// "Weekend Outings".
function matches(name, words) {
  const n = norm(name);
  return words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(e?s)?($|[^a-z])`).test(n));
}

// Lays the template against what the household has. A group is matched to an
// existing top-level category of the same kind by exact name or match word;
// a category is matched to ANY existing category of the same kind, wherever
// it sits, since households file things differently ("Mobile Bill" under
// Subscriptions is still a mobile bill). Archived categories count as present:
// adding a second "Rent" beside an archived one would be a duplicate the
// household deliberately retired.
export function planStarter(existing = [], template = STARTER_TEMPLATE) {
  return template.flatMap(({ kind, groups }) => {
    const sameKind = existing.filter((c) => c.kind === kind);
    const topLevel = sameKind.filter((c) => !c.parent_id);
    const groupOf = (g) =>
      g.flat
        ? null
        : (topLevel.find((c) => norm(c.name) === norm(g.name)) ?? topLevel.find((c) => g.match.some((w) => norm(c.name) === norm(w))) ?? null);
    const matchedGroups = groups.map(groupOf);
    // A category standing in for a whole group is not also one of the
    // categories inside it -- but an ungrouped "Rent" in a household that
    // never made groups is exactly the rent category.
    const groupIds = new Set(matchedGroups.filter(Boolean).map((c) => c.id));
    const candidates = sameKind.filter((c) => !groupIds.has(c.id));
    return groups.map((g, i) => {
      const group = matchedGroups[i];
      // Inside the matching group first, so DEWA under Utilities is found
      // before an electricity bill someone pays under Family Support.
      const inGroup = group ? candidates.filter((c) => c.parent_id === group.id) : [];
      const children = g.children.map((child) => {
        const found =
          candidates.find((c) => norm(c.name) === norm(child.name)) ??
          inGroup.find((c) => matches(c.name, child.match)) ??
          candidates.find((c) => matches(c.name, child.match)) ??
          null;
        return { name: child.name, existing: found };
      });
      return { kind, name: g.name, flat: !!g.flat, existing: group, children };
    });
  });
}

// Everything the plan would add, as keys a picker can hold: `group` for a
// missing group, `group/child` for a missing category.
export function missingKeys(plan) {
  const keys = [];
  for (const g of plan) {
    if (!g.flat && !g.existing && g.children.some((c) => !c.existing)) keys.push(g.name);
    for (const c of g.children) if (!c.existing) keys.push(`${g.name}/${c.name}`);
  }
  return keys;
}

// The rows to insert for a selection, in two steps because a new category
// needs its new group's id: `groups` first, then `children(idByGroupName)`.
// A category picked without its missing group brings the group along --
// otherwise it would land at the top level, beside the groups.
export function starterInserts(plan, selected, householdId) {
  const picked = new Set(selected);
  const groups = [];
  const childRows = [];
  for (const g of plan) {
    const kids = g.children.filter((c) => !c.existing && picked.has(`${g.name}/${c.name}`));
    const wantGroup = !g.flat && !g.existing && (picked.has(g.name) || kids.length > 0);
    if (wantGroup) groups.push({ household_id: householdId, name: g.name, kind: g.kind, parent_id: null });
    for (const c of kids) childRows.push({ group: g.flat ? null : g.name, existingParentId: g.existing?.id ?? null, row: { household_id: householdId, name: c.name, kind: g.kind } });
  }
  return {
    groups,
    children: (idByGroupName) =>
      childRows.map(({ group, existingParentId, row }) => ({ ...row, parent_id: existingParentId ?? (group ? idByGroupName.get(group) : null) ?? null })),
    count: groups.length + childRows.length,
  };
}
