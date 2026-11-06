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

const SETTLED_LABELS = new Set(['agrees', 'within_rounding', 'not_imported']);

// One figure of a share against one statement, in paise, before reasons.
function compare({ imported, statementPaise, rokdaPaise, count }) {
  if (!imported) return { difference: null, label: 'not_imported', reasons: [] };
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
  const lineIn = (statement, key) => (statement ? (linesOf.get(statement.id) ?? []).find((l) => lineKey(l) === key) ?? null : null);

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
