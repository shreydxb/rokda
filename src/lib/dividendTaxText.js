// The Tax years section's sentences (dividend tax years, part 2; spec
// sections 4 and 6). Pure: each takes what src/lib/dividendTax.js worked out
// and a rupee formatter, and says it. A difference is described, never
// judged: causes begin "possibly", a missing statement is "not added", and
// what the return computes against the tax credit is a surplus or a
// shortfall, never a part of the refund.
import { taxYearLabel } from './dividendTax';
import { shortDate } from './dividends';

const paise = (n) => Math.round(Number(n) * 100);
const sum = (...values) => values.reduce((t, v) => t + paise(v ?? 0), 0) / 100;

const BASIS = { domestic: 'the domestic rate', treaty: 'the treaty rate' };

export function basisWords(claimBasis, ratePct) {
  const rate = `${Number(ratePct)}%`;
  return BASIS[claimBasis] ? `${BASIS[claimBasis]} of ${rate}` : `a rate of ${rate}`;
}

export function revisionLabel(n) {
  if (n <= 0) return 'Not filed';
  if (n === 1) return 'Original return';
  if (n === 2) return 'Revised return';
  return `Revised return ${n - 1}`;
}

const DIFFERENCES = new Set(['differs', 'unexplained', 'only_in_statement', 'only_in_rokda']);

// How the year's shares stand against the statements, as a count of
// differences; rounding is not a difference.
export function checkWords(year) {
  const { ais, f26as } = year.statements;
  if (!ais && !f26as) return 'AIS and 26AS not added';
  const count = year.shares.reduce((n, s) => n + (ais && DIFFERENCES.has(s.income.label) ? 1 : 0) + (f26as && DIFFERENCES.has(s.tax.label) ? 1 : 0), 0);
  const missing = !ais ? 'AIS' : !f26as ? '26AS' : null;
  if (count === 0) {
    if (!missing) return 'agrees with AIS and 26AS';
    return `agrees with ${ais ? 'AIS' : '26AS'}; ${missing} not added`;
  }
  const words = count === 1 ? '1 difference' : `${count} differences`;
  return missing ? `${words}; ${missing} not added` : words;
}

function surplusWords(surplus) {
  if (surplus.amount == null) return surplus.missing.includes('26as') ? 'surplus needs 26AS' : "surplus needs the return's dividend tax";
  if (surplus.amount > 0) return `dividend tax surplus ${surplus.fmt(surplus.amount)}`;
  if (surplus.amount < 0) return `dividend tax shortfall ${surplus.fmt(-surplus.amount)}`;
  return 'no dividend tax surplus';
}

function refundWords(refund, fmt) {
  switch (refund.stage) {
    case 'filed':
      return 'not processed yet';
    case 'demand':
      return `demand ${fmt(-refund.determined)}`;
    case 'no_refund':
      return 'no refund';
    case 'refund_due':
      return `refund ${fmt(sum(refund.determined, refund.interest))} due`;
    case 'partly_settled':
      return `refund ${fmt(sum(refund.determined, refund.interest))}, ${fmt(refund.unexplained)} unexplained`;
    default: {
      if (!refund.credited) return `refund ${fmt(refund.offset)} set against a demand`;
      let words = `refund ${fmt(refund.credited)} credited ${shortDate(refund.lastCreditedOn)}`;
      if (refund.offset) words += `, ${fmt(refund.offset)} set against a demand`;
      if (refund.unexplained < 0) words += `, ${fmt(-refund.unexplained)} more than determined`;
      return words;
    }
  }
}

// Where a year stands: before filing, what could come back at this year's
// own basis; after, the surplus or shortfall and then the whole refund.
export function stageWords(year, fmt) {
  if (year.refund.stage === 'not_filed') {
    const e = year.estimate;
    if (e) {
      const words = `could come back: about ${fmt(e.amount)} at ${basisWords(e.claimBasis, e.ratePct)}`;
      return e.presumedPart ? `${words}, ${fmt(e.presumedPart)} of it on presumed dividends` : words;
    }
    const ref = year.basisReference;
    return ref ? `no claim basis set (last year: ${basisWords(ref.claimBasis, ref.ratePct)})` : 'no claim basis set';
  }
  return `${surplusWords({ ...year.surplus, fmt })}; ${refundWords(year.refund, fmt)}`;
}

const REASONS = {
  neighbouring_year: (r) => `possibly counted in ${taxYearLabel(r.year)}`,
  extra_deduction: () => "possibly an additional deduction or a correction: check the company's intimation or Form 16A",
  presumed: () => 'presumed, not confirmed',
};

// One figure of a share against one statement.
export function comparisonWords(cmp, source, fmt) {
  const d = cmp.difference;
  let words;
  switch (cmp.label) {
    case 'not_imported':
      return `${source} not added`;
    case 'neither':
      return `not in Rokda or ${source}`;
    case 'agrees':
      return `agrees with ${source}`;
    case 'within_rounding':
      return `within rounding of ${source} (${fmt(Math.abs(d))})`;
    case 'only_in_statement':
      words = `only in ${source} (${fmt(d)})`;
      break;
    case 'only_in_rokda':
      words = `not in ${source}`;
      break;
    default:
      words = `${source} ${fmt(Math.abs(d))} ${d > 0 ? 'more' : 'less'}${cmp.label === 'unexplained' ? ', unexplained' : ''}`;
  }
  return cmp.reasons.length ? `${words}: ${cmp.reasons.map((r) => REASONS[r.code](r)).join('; ')}` : words;
}

// A share's two lines: Rokda's income against the AIS, its tax against 26AS
// (the AIS's tax beside it), presumed parts named.
export function shareLines(check, fmt) {
  const { confirmed, presumed } = check.rokda;
  let income = `Income: Rokda ${fmt(sum(confirmed.gross, presumed.gross))}`;
  let tax = `Tax: Rokda ${fmt(sum(confirmed.tax, presumed.tax))}`;
  if (presumed.count) {
    income += ` (${fmt(presumed.gross)} presumed)`;
    tax += ` (${fmt(presumed.tax)} presumed)`;
  }
  if (check.ais) income += ` · AIS ${fmt(check.ais.gross)}`;
  if (check.f26as) tax += ` · 26AS ${fmt(check.f26as.tds)}`;
  if (check.ais?.tds != null) tax += ` · AIS ${fmt(check.ais.tds)}`;
  return { income: `${income} · ${comparisonWords(check.income, 'AIS', fmt)}`, tax: `${tax} · ${comparisonWords(check.tax, '26AS', fmt)}` };
}

const given = (value, fmt) => (value == null ? 'not given' : fmt(value));

export function returnLines(taxReturn, fmt) {
  const lines = [taxReturn?.claim_basis ? `Claim basis: ${basisWords(taxReturn.claim_basis, taxReturn.claim_rate_pct)}` : 'Claim basis: not set'];
  if (!taxReturn || taxReturn.revision < 1) return [...lines, 'Not filed'];
  return [
    ...lines,
    `${revisionLabel(taxReturn.revision)}, filed ${shortDate(taxReturn.filed_on)}`,
    `Dividend income ${given(taxReturn.dividend_income, fmt)}, dividend tax ${given(taxReturn.dividend_tax, fmt)}`,
    `Tax credit claimed: ${given(taxReturn.dividend_tds_claimed, fmt)} on dividends, ${given(taxReturn.tds_claimed_total, fmt)} in all`,
  ];
}

export function eventLine(event, taxReturn, fmt) {
  let words;
  switch (event.kind) {
    case 'processed': {
      const d = Number(event.refund_determined);
      words = d < 0 ? `Processed: demand ${fmt(-d)}` : `Processed: refund ${fmt(d)}`;
      if (Number(event.refund_interest) > 0) words += `, interest ${fmt(event.refund_interest)}`;
      break;
    }
    case 'refund_credited':
      words = `Refund credited ${fmt(event.amount)}`;
      break;
    case 'offset_against_demand':
      words = `${fmt(event.amount)} set against a demand`;
      break;
    default:
      words = event.amount == null ? 'Refund failed' : `Refund failed (${fmt(event.amount)})`;
  }
  const line = `${shortDate(event.happened_on)} · ${words}`;
  return taxReturn?.revision > 1 ? `${line} · ${revisionLabel(event.revision).toLowerCase()}` : line;
}

const listed = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// Shared holdings' dividends are in no one's year, since a return is one
// person's.
export function unassignedWords(unassigned) {
  if (!unassigned?.length) return null;
  const names = listed(unassigned.map((u) => u.name));
  return unassigned.length === 1
    ? `${names} is shared, so its dividends aren't in anyone's tax year. Give it an owner under Investments to count them.`
    : `${names} are shared, so their dividends aren't in anyone's tax year. Give them owners under Investments to count them.`;
}
