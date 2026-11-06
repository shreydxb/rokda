// Dividend tax years (SHR-366; docs/superpowers/specs/2026-11-04-dividend-tax-years-design.md,
// section 4). Each member's Indian dividends by tax year and share, checked
// against the department's statements: the AIS for income, Form 26AS for tax
// credit. Pure: the screen reads the rows and lays this out.
//
// Every sum and difference is worked in whole paise, so a statement that
// agrees to the paisa reads "agrees", never a floating-point residue.

const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => (p === 0 ? 0 : p / 100);
const ROUNDING_PAISE_PER_DIVIDEND = 100;

// A tax year is named by the year it starts in: 2025 is FY 2025-26, from
// 1 April 2025 to 31 March 2026.
export function financialYearOf(day) {
  const year = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) < 4 ? year - 1 : year;
}

const twoDigits = (year) => String(year % 100).padStart(2, '0');

// Years under the Income-tax Act 1961 carry their assessment year; from 2026
// the 2025 Act names the tax year itself.
export function taxYearLabel(year) {
  if (year >= 2026) return `tax year ${year}-${twoDigits(year + 1)}`;
  return `FY ${year}-${twoDigits(year + 1)} (AY ${year + 1}-${twoDigits(year + 2)})`;
}

// A dividend's own tax year when one was set (a final dividend declared in
// March and paid in April), else its credit date's, provisional while that
// date is an estimate.
export function dividendTaxYear(dividend) {
  if (dividend.tax_financial_year != null) {
    return { year: dividend.tax_financial_year, provisional: false, basis: dividend.tax_year_basis };
  }
  if (!dividend.credited_on) return { year: null, provisional: false, basis: 'credit' };
  return { year: financialYearOf(dividend.credited_on), provisional: Boolean(dividend.credited_on_estimated), basis: 'credit' };
}

// Statements report by company, so holdings of one share are one share.
export function shareKey(holding) {
  return holding.price_symbol ?? `holding:${holding.id}`;
}

// A statement line's share, or for a payer Rokda doesn't hold, its name.
export function lineKey(line) {
  return line.symbol ?? `payer:${line.payer.trim().toLowerCase()}`;
}

const isIndian = (holding) => holding?.asset_class === 'india_equity';
const emptyFigures = () => ({ count: 0, gross: 0, tax: 0 });
const figuresInRupees = (f) => ({ count: f.count, gross: rupees(f.gross), tax: rupees(f.tax) });

// Rokda's side: each member's Indian dividends counted as received, by tax
// year and share, confirmed (received) and presumed apart. A return is one
// person's, so a shared holding's dividends are listed apart, asking whose
// they are. A holding's owner is today's: its past dividends move with it.
export function rokdaShareYears(holdings, dividends) {
  const byId = new Map((holdings ?? []).map((h) => [h.id, h]));
  const groups = new Map();
  const unassigned = new Map();
  for (const d of dividends ?? []) {
    const holding = byId.get(d.holding_id);
    if (!isIndian(holding) || (d.status !== 'received' && d.status !== 'presumed')) continue;
    if (holding.is_shared || !holding.owner_member_id) {
      const u = unassigned.get(holding.id) ?? { holdingId: holding.id, name: holding.name, count: 0 };
      u.count += 1;
      unassigned.set(holding.id, u);
      continue;
    }
    const { year, provisional } = dividendTaxYear(d);
    if (year == null) continue;
    const key = shareKey(holding);
    const id = `${holding.owner_member_id}|${year}|${key}`;
    const g = groups.get(id) ?? {
      memberId: holding.owner_member_id, year, key, names: new Set(), provisional: false, confirmed: emptyFigures(), presumed: emptyFigures(),
    };
    g.names.add(holding.name);
    g.provisional ||= provisional;
    const into = d.status === 'received' ? g.confirmed : g.presumed;
    into.count += 1;
    into.gross += paise(d.status === 'received' ? d.received_gross : d.expected_gross);
    into.tax += paise(d.status === 'received' ? d.received_tax : d.expected_tax);
    groups.set(id, g);
  }
  const rows = [...groups.values()].map((g) => ({
    memberId: g.memberId, year: g.year, key: g.key, name: [...g.names].sort()[0], provisional: g.provisional,
    confirmed: figuresInRupees(g.confirmed), presumed: figuresInRupees(g.presumed),
  }));
  return { rows, unassigned: [...unassigned.values()] };
}

// The dividends a share-year's sums count, oldest credit first: received and
// presumed dividends of the member's own Indian holdings of that share.
export function dividendsInYear({ holdings, dividends, memberId, year, key }) {
  const byId = new Map((holdings ?? []).map((h) => [h.id, h]));
  return (dividends ?? [])
    .filter((d) => {
      const h = byId.get(d.holding_id);
      return isIndian(h) && !h.is_shared && h.owner_member_id === memberId && shareKey(h) === key
        && (d.status === 'received' || d.status === 'presumed') && dividendTaxYear(d).year === year;
    })
    .sort((a, b) => (a.credited_on < b.credited_on ? -1 : a.credited_on > b.credited_on ? 1 : 0));
}

const SETTLED_LABELS = new Set(['agrees', 'within_rounding', 'not_imported', 'neither']);

// One figure of a share against one statement, in paise, before reasons.
function compare({ imported, statementPaise, rokdaPaise, count }) {
  if (!imported) return { difference: null, label: 'not_imported', reasons: [] };
  // Nothing on either side: there is nothing to agree about.
  if (count === 0 && statementPaise == null) return { difference: null, label: 'neither', reasons: [] };
  const difference = (statementPaise ?? 0) - rokdaPaise;
  let label;
  if (count === 0 && statementPaise != null) label = 'only_in_statement';
  else if (count > 0 && statementPaise == null) label = 'only_in_rokda';
  else if (difference === 0) label = 'agrees';
  else if (Math.abs(difference) <= ROUNDING_PAISE_PER_DIVIDEND * count) label = 'within_rounding';
  else label = 'pending';
  return { difference, label, reasons: [] };
}

// The statement check: per member, tax year and share, Rokda's gross against
// the AIS and Rokda's tax against 26AS, each difference exact. The AIS's tax
// and 26AS's gross are carried to show beside them, never added in. A
// difference is offered possible explanations; it decides nothing.
export function statementCheck({ shareYears, statements, lines }) {
  const statementOf = new Map((statements ?? []).map((s) => [`${s.member_id}|${s.financial_year}|${s.source}`, s]));
  const linesOf = new Map();
  for (const l of lines ?? []) linesOf.set(l.statement_id, [...(linesOf.get(l.statement_id) ?? []), l]);
  // A share can appear under two payer names in one statement (a company
  // renamed in the year): its lines are added together.
  const lineIn = (statement, key) => {
    const own = statement ? (linesOf.get(statement.id) ?? []).filter((l) => lineKey(l) === key) : [];
    if (!own.length) return null;
    const tdsKnown = own.some((l) => l.tds != null);
    return {
      payer: own[0].payer,
      gross: rupees(own.reduce((t, l) => t + paise(l.gross), 0)),
      tds: tdsKnown ? rupees(own.reduce((t, l) => t + paise(l.tds ?? 0), 0)) : null,
    };
  };

  const entries = new Map();
  for (const row of shareYears ?? []) entries.set(`${row.memberId}|${row.year}|${row.key}`, { memberId: row.memberId, year: row.year, key: row.key, row });
  for (const s of statements ?? []) {
    for (const l of linesOf.get(s.id) ?? []) {
      const id = `${s.member_id}|${s.financial_year}|${lineKey(l)}`;
      if (!entries.has(id)) entries.set(id, { memberId: s.member_id, year: s.financial_year, key: lineKey(l), row: null });
    }
  }

  const checks = [...entries.values()].map(({ memberId, year, key, row }) => {
    const ais = statementOf.get(`${memberId}|${year}|ais`);
    const f26 = statementOf.get(`${memberId}|${year}|26as`);
    const aisLine = lineIn(ais, key);
    const f26Line = lineIn(f26, key);
    const confirmed = row?.confirmed ?? emptyFigures();
    const presumed = row?.presumed ?? emptyFigures();
    const count = confirmed.count + presumed.count;
    const gross = paise(confirmed.gross) + paise(presumed.gross);
    const tax = paise(confirmed.tax) + paise(presumed.tax);
    return {
      memberId, year, key, name: row?.name ?? (aisLine ?? f26Line).payer,
      rokda: { confirmed, presumed, count },
      ais: aisLine ? { gross: Number(aisLine.gross), tds: aisLine.tds == null ? null : Number(aisLine.tds) } : null,
      f26as: f26Line ? { gross: Number(f26Line.gross), tds: Number(f26Line.tds) } : null,
      income: compare({ imported: Boolean(ais), statementPaise: aisLine ? paise(aisLine.gross) : null, rokdaPaise: gross, count }),
      tax: compare({ imported: Boolean(f26), statementPaise: f26Line ? paise(f26Line.tds) : null, rokdaPaise: tax, count }),
      gross,
    };
  });

  const byShare = new Map(checks.map((c) => [`${c.memberId}|${c.year}|${c.key}`, c]));
  for (const c of checks) {
    for (const figure of ['income', 'tax']) {
      const cmp = c[figure];
      if (SETTLED_LABELS.has(cmp.label)) continue;
      for (const year of [c.year - 1, c.year + 1]) {
        const other = byShare.get(`${c.memberId}|${year}|${c.key}`)?.[figure];
        const otherCount = byShare.get(`${c.memberId}|${year}|${c.key}`)?.rokda.count ?? 0;
        if (other?.difference && Math.abs(cmp.difference + other.difference) <= ROUNDING_PAISE_PER_DIVIDEND * (c.rokda.count + otherCount)) {
          cmp.reasons.push({ code: 'neighbouring_year', year });
        }
      }
      if (figure === 'tax' && cmp.difference > 0 && c.f26as && c.rokda.count > 0
          && Math.abs(paise(c.f26as.gross) - c.gross) <= ROUNDING_PAISE_PER_DIVIDEND * c.rokda.count) {
        cmp.reasons.push({ code: 'extra_deduction' });
      }
      if (c.rokda.presumed.count > 0) cmp.reasons.push({ code: 'presumed' });
    }
  }
  for (const c of checks) {
    for (const figure of ['income', 'tax']) {
      const cmp = c[figure];
      if (cmp.label === 'pending') cmp.label = cmp.reasons.length ? 'differs' : 'unexplained';
      if (cmp.difference != null) cmp.difference = rupees(cmp.difference);
    }
    delete c.gross;
  }
  return checks.sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : a.year - b.year || a.name.localeCompare(b.name)));
}

const isFiled = (taxReturn) => Boolean(taxReturn && taxReturn.revision >= 1);

// The dividend tax surplus (or, negative, shortfall): the tax credit on the
// year's dividends in 26AS less the tax the return computes on them. It is
// not a part of the refund: other income can absorb or add to that.
export function dividendTaxSurplus({ taxReturn, f26asTds }) {
  const missing = [];
  if (!isFiled(taxReturn) || taxReturn.dividend_tax == null) missing.push('return');
  if (f26asTds == null) missing.push('26as');
  if (missing.length) return { amount: null, missing };
  return { amount: rupees(paise(f26asTds) - paise(taxReturn.dividend_tax)), missing };
}

const latestFirst = (a, b) =>
  b.revision - a.revision || (a.happened_on < b.happened_on ? 1 : a.happened_on > b.happened_on ? -1 : 0)
  || (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);

// What became of a return's refund. The latest processing records the
// return's totals to date; credits and offsets are money that moved, under
// any revision; a failed refund moved nothing. "Unexplained" is what was
// determined, with interest, that neither arrived nor was set off.
export function refundState(taxReturn, events) {
  const mine = taxReturn ? (events ?? []).filter((e) => e.return_id === taxReturn.id) : [];
  const sum = (kind) => mine.filter((e) => e.kind === kind).reduce((total, e) => total + paise(e.amount), 0);
  const credited = sum('refund_credited');
  const offset = sum('offset_against_demand');
  const lastCreditedOn = mine.filter((e) => e.kind === 'refund_credited').map((e) => e.happened_on).sort().at(-1) ?? null;
  const state = (stage, determined = null, interest = null, unexplained = null) =>
    ({ stage, determined: determined == null ? null : rupees(determined), interest: interest == null ? null : rupees(interest),
      credited: rupees(credited), offset: rupees(offset), unexplained: unexplained == null ? null : rupees(unexplained), lastCreditedOn });
  if (!isFiled(taxReturn)) return state('not_filed');
  const processing = mine.filter((e) => e.kind === 'processed').sort(latestFirst)[0];
  if (!processing) return state('filed');
  const determined = paise(processing.refund_determined);
  const interest = paise(processing.refund_interest ?? 0);
  if (determined < 0) return state('demand', determined, interest);
  const due = determined + interest;
  if (due === 0) return state('no_refund', determined, interest);
  const settled = credited + offset;
  const stage = settled === 0 ? 'refund_due' : settled < due ? 'partly_settled' : 'settled';
  return state(stage, determined, interest, due - settled);
}

// What could come back on this year's dividends before filing, at the
// basis set for this year (never another year's): tax withheld less the
// rate on gross. From 26AS once imported, else from Rokda, whose presumed
// part is shown apart.
export function refundEstimate({ taxReturn, f26as, rokda }) {
  if (!taxReturn?.claim_basis || taxReturn.claim_rate_pct == null || isFiled(taxReturn)) return null;
  const ratePct = Number(taxReturn.claim_rate_pct);
  const owed = (grossPaise) => Math.round((grossPaise * ratePct) / 100);
  const basis = { claimBasis: taxReturn.claim_basis, ratePct };
  if (f26as) return { amount: rupees(paise(f26as.tds) - owed(paise(f26as.gross))), presumedPart: null, ...basis, from: '26as' };
  const gross = paise(rokda.confirmed.gross) + paise(rokda.presumed.gross);
  const tax = paise(rokda.confirmed.tax) + paise(rokda.presumed.tax);
  return {
    amount: rupees(tax - owed(gross)), presumedPart: rupees(paise(rokda.presumed.tax) - owed(paise(rokda.presumed.gross))), ...basis, from: 'rokda',
  };
}

const REFUSALS = {
  not_member: "This isn't someone in your household.",
  bad_input: "Something in this form isn't a valid year, date, choice or number.",
  bad_figures: 'An amount is below zero, has more than two decimals, or is more than its total.',
  stale: 'This changed since you opened it. Check it again.',
  basis_needs_rate: 'Give the rate with the basis, or clear both.',
  filed_on_needed: 'A filed return needs the date it was filed.',
  not_filed: 'Mark the return filed before adding its figures or what happened to it.',
  filed_before_year_end: 'A return can only be filed after its tax year has ended.',
  in_future: 'That date is after today.',
  identifier_in_text: 'Leave out PAN, account and acknowledgement numbers.',
  events_on_later_revision: 'Something is recorded against a later revision. Remove it first.',
  event_not_found: 'This is no longer there.',
  dividend_not_found: 'This dividend is no longer there.',
  not_indian: 'Only Indian dividends have a tax year here.',
  year_too_far: 'A dividend can only move to the year next to the one it was credited in.',
  unknown_share: "That share isn't one of the household's Indian holdings.",
  duplicate_payer: 'The same company is listed twice.',
  older_than_held: 'A newer statement is already saved.',
};

// One sentence for a refusal from the tax functions, keeping what was typed.
export function taxRefusalMessage(code) {
  return REFUSALS[code] ?? 'That could not be saved. Nothing was changed.';
}

function statementInfo(statement, lines) {
  if (!statement) return null;
  const own = (lines ?? []).filter((l) => l.statement_id === statement.id);
  return {
    revision: statement.revision, asOf: statement.as_of, importedAt: statement.imported_at, lineCount: own.length,
    gross: rupees(own.reduce((t, l) => t + paise(l.gross), 0)), tds: rupees(own.reduce((t, l) => t + paise(l.tds ?? 0), 0)),
  };
}

// Each member's tax years, newest first: every year with Indian dividends, a
// statement or a return, held or not. Shared holdings' dividends are apart.
export function taxYears({ holdings, dividends, statements, lines, returns, events }) {
  const { rows, unassigned } = rokdaShareYears(holdings, dividends);
  const checks = statementCheck({ shareYears: rows, statements, lines });
  const keys = new Map();
  const add = (memberId, year) => keys.set(`${memberId}|${year}`, { memberId, year });
  rows.forEach((r) => add(r.memberId, r.year));
  (statements ?? []).forEach((s) => add(s.member_id, s.financial_year));
  (returns ?? []).forEach((r) => add(r.member_id, r.financial_year));
  const returnOf = (memberId, year) => (returns ?? []).find((r) => r.member_id === memberId && r.financial_year === year) ?? null;
  const statementOf = (memberId, year, source) =>
    (statements ?? []).find((s) => s.member_id === memberId && s.financial_year === year && s.source === source);

  const years = [...keys.values()].map(({ memberId, year }) => {
    const own = rows.filter((r) => r.memberId === memberId && r.year === year);
    const total = (part) => figuresInRupees(own.reduce((t, r) => ({
      count: t.count + r[part].count, gross: t.gross + paise(r[part].gross), tax: t.tax + paise(r[part].tax),
    }), emptyFigures()));
    const rokda = { confirmed: total('confirmed'), presumed: total('presumed') };
    const f26as = statementInfo(statementOf(memberId, year, '26as'), lines);
    const taxReturn = returnOf(memberId, year);
    const previous = taxReturn?.claim_basis ? null : returnOf(memberId, year - 1);
    return {
      memberId, year, label: taxYearLabel(year), provisional: own.some((r) => r.provisional), rokda,
      statements: { ais: statementInfo(statementOf(memberId, year, 'ais'), lines), f26as },
      shares: checks.filter((c) => c.memberId === memberId && c.year === year).sort((a, b) => a.name.localeCompare(b.name)),
      taxReturn,
      surplus: dividendTaxSurplus({ taxReturn, f26asTds: f26as?.tds ?? null }),
      refund: refundState(taxReturn, (events ?? []).filter((e) => e.return_id === taxReturn?.id)),
      estimate: refundEstimate({ taxReturn, f26as: f26as ? { gross: f26as.gross, tds: f26as.tds } : null, rokda }),
      basisReference: previous?.claim_basis
        ? { year: year - 1, claimBasis: previous.claim_basis, ratePct: Number(previous.claim_rate_pct) } : null,
    };
  });
  years.sort((a, b) => b.year - a.year || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  return { years, unassigned };
}
