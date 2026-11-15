import { useState } from 'react';
import { useNow } from '../../lib/useNow';
import { useMonthParam } from '../../lib/useMonthParam';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatBalance, formatMoney, formatSigned } from '../../lib/money';
import { budgetGroupSpend, monthIncome, monthPace } from '../../lib/budget';
import { budgetTable, lineRecords, paceVerdict } from '../../lib/budgetTable';
import { UNCATEGORISED } from '../../lib/activityLink';
import { rowDateLabel } from '../../lib/activity';
import { Avatar, Card, Chip, EmptyState, InfoButton, MonthStepper, ProgressBar, Segmented } from '../../design-system/kit';
import BudgetEditor from './BudgetEditor';
import { categoryOwner, householdShare } from '../../lib/share';
import { neverLoaded } from '../../lib/loadState';
import Withheld from '../planning/Withheld';
import { Tools } from './MoneyTools';
import { setBudgetLimit } from './setBudgetLimit';
import './Budget.css';

// Money -> Budget, built like the prototype (the revamp, phase 4b;
// design/prototype/js/screens-money.js budMonth): the month's spent of
// budget and its verdict, then each line against its limit, its usual month
// and the month's pace, then the savings target and the household's share.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const VIEWS = [
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];
const pctText = (v) => `${Math.round(v * 100)}%`;
// A limit as its box shows it: pence only when it has them.
const limitText = (v) => formatMoney(v, { decimals: Number.isInteger(Number(v)) ? 0 : 2 });

export default function Budget({ household, me, members, data, loading, onOpenRecords }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, categories, budgets, accounts = [], recurring = [], reload } = data;
  // A savings category's budget is a savings target, not money to spend: it
  // stays out of every spending total below and is shown against what the
  // month actually saved.
  const savingsIds = new Set(categories.filter((c) => c.is_savings).map((c) => c.id));
  const spendBudgets = budgets.filter((b) => !savingsIds.has(b.category_id));
  const savingsBudgets = budgets.filter((b) => savingsIds.has(b.category_id));

  const [view, setView] = useState('month'); // 'month' | 'year'
  const now = useNow(data?.loadedAt);
  // The month is in the address, shared with Activity (lib/useTab keep), so
  // Back from its records returns to it.
  const [cursor, setCursor] = useMonthParam(now);
  const [yearCursor, setYearCursor] = useState(now.getFullYear());
  // The editor's budget and the month it saves into, fixed when it opens. A
  // page with no month in its address follows today, so an editor left open
  // past midnight at a month's end saved into the next month (round 2 of the
  // outside review, E2-2).
  const [editing, setEditing] = useState(null); // null | { item, year, month }
  const openEditor = (item) => setEditing({ item, year: view === 'year' ? yearCursor : cursor.getFullYear(), month: cursor.getMonth() + 1 });

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  // Spending, budgets or categories that never loaded are not none: the month
  // read "0 spent" against every budget (round 2 of the outside review, E2-3).
  const missing = neverLoaded(data, ['transactions', 'budgets', 'categories']);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={reload}>
        Budgets aren&rsquo;t shown, rather than shown against spending of nothing.
      </Withheld>
    );
  }

  const catById = new Map(categories.map((c) => [c.id, c]));
  const year = cursor.getFullYear();
  const month = cursor.getMonth() + 1;

  return (
    <div className="bud">
      <Tools>
        <Segmented label="View" options={VIEWS} value={view} onChange={setView} />
        {view === 'month' ? (
          <MonthStepper label={`${MONTH_LABELS[month - 1]} ${year}`} onPrev={() => setCursor(new Date(year, month - 2, 1))} onNext={() => setCursor(new Date(year, month, 1))} />
        ) : (
          <MonthStepper unit="year" label={String(yearCursor)} onPrev={() => setYearCursor(yearCursor - 1)} onNext={() => setYearCursor(yearCursor + 1)} />
        )}
        <button type="button" className="ds-btn ds-btn-primary" onClick={() => openEditor(null)}>
          + Budget
        </button>
      </Tools>

      {view === 'month' ? (
        <MonthView
          year={year}
          month={month}
          budgets={spendBudgets}
          savingsBudgets={savingsBudgets}
          transactions={transactions}
          categories={categories}
          catById={catById}
          scopeMemberId={scopeMemberId}
          now={now}
          onEdit={openEditor}
          onOpenRecords={onOpenRecords}
          reload={reload}
          share={{ members, categories, budgets, transactions, accounts, recurring }}
        />
      ) : (
        <YearView
          year={yearCursor}
          budgets={spendBudgets}
          savingsBudgets={savingsBudgets}
          transactions={transactions}
          categories={categories}
          scopeMemberId={scopeMemberId}
          now={now}
        />
      )}

      {editing && (
        <BudgetEditor
          item={editing.item}
          householdId={household?.id}
          categories={categories}
          year={editing.year}
          month={editing.month}
          onOpenRecords={onOpenRecords}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function MonthView({ year, month, budgets, savingsBudgets, transactions, categories, catById, scopeMemberId, now, onEdit, onOpenRecords, reload, share }) {
  const rows = budgets.filter((b) => b.year === year && b.month === month);
  const pace = monthPace(year, month, now);
  // What was actually spent, budgeted or not (QA-09), split by the same
  // groups the table shows, so the hero, the rows and the totals are one set
  // of figures that adds up, and the year view reads the same month alike.
  const spend = budgetGroupSpend(transactions, rows.map((r) => r.category_id), catById, year, month, scopeMemberId, now);
  const table = budgetTable({ budgets: rows, catById, spend, transactions, year, month, scopeMemberId });
  const members = share?.members ?? [];
  const monthLabel = `${MONTH_LABELS[month - 1]} ${year}`;
  const income = monthIncome(transactions, year, month, scopeMemberId, now);

  return (
    <>
      {rows.length === 0 ? (
        <Card>
          <EmptyState title="No budget set" body={`Nothing budgeted for ${monthLabel} yet.`} action={{ label: 'Set a budget', onClick: () => onEdit(null) }} />
        </Card>
      ) : (
        <>
          <Hero spent={table.budgeted.spent} limit={table.budgeted.limit} pace={pace} scoped={scopeMemberId !== null} />
          <BudgetLines
            table={table}
            members={members}
            catById={catById}
            categories={categories}
            transactions={transactions}
            year={year}
            month={month}
            pace={pace}
            scopeMemberId={scopeMemberId}
            now={now}
            onEdit={onEdit}
            onOpenRecords={onOpenRecords}
            reload={reload}
          />
        </>
      )}
      <div className="bud-cards">
        <SavingsTarget rows={savingsBudgets.filter((b) => b.year === year && b.month === month)} saved={income - spend.total} income={income} pace={pace} catById={catById} scoped={scopeMemberId !== null} onEdit={onEdit} />
        {members.length === 2 && <HouseholdShare {...share} year={year} month={month} pace={pace} now={now} />}
      </div>
    </>
  );
}

// The spent of budget, the month's tick and its verdict (design/prototype
// bud-hero).
function Hero({ spent, limit, pace, scoped }) {
  const verdict = paceVerdict(spent, limit, pace);
  const used = limit > 0 ? spent / limit : 0;
  return (
    <section className="ds-card bud-hero" aria-label="Spent of budget">
      <div className="bud-hero-fig">
        <div className="bud-label">Spent of budget</div>
        <div className="bud-big">
          {formatMoney(spent)} <span className="bud-of">of {formatMoney(limit)}</span>
        </div>
      </div>
      <div className="bud-hero-track">
        <div className="bud-hero-line">
          <span className="bud-ink2">
            {pctText(used)} spent · {pace.isPast ? 'month complete' : `${pctText(pace.elapsedFraction)} of month gone`}
          </span>
          <span className="bud-chips">
            {scoped && <Chip>Limits are the household’s</Chip>}
            {verdict && <Chip tone={verdict.tone}>{verdict.label}</Chip>}
          </span>
        </div>
        <ProgressBar label="Spent of budget" value={spent} max={limit} tick={pace.isPast ? null : pace.elapsedFraction * limit} tone={spent > limit ? 'neg' : 'accent'} format={formatMoney} />
      </div>
    </section>
  );
}

// The By category table (design/prototype budMonth): group rows with their
// subtotals, each line with what was spent, its limit typed in place, its
// usual month and its pace; a line opens its records beneath it. Then what
// was budgeted in all, and what was spent outside it.
function BudgetLines({ table, members, catById, categories, transactions, year, month, pace, scopeMemberId, now, onEdit, onOpenRecords, reload }) {
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);
  const tone = new Map(members.map((m, i) => [m.id, i === 0 ? 'a' : 'b']));
  const owner = (categoryId) => {
    const id = categoryId ? categoryOwner(categoryId, catById) : null;
    const m = id ? members.find((x) => x.id === id) : null;
    return m ? <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={tone.get(m.id)} /> : null;
  };
  const saveLimit = async (line, text, input) => {
    // Saved only when the text was changed, so passing through a limit with
    // pence never rounds it, and only as a plain amount: "1,200", "1200.50"
    // or "1200 AED". Anything else ("1e3", "-500", "lots") is left as it was
    // (the fresh review of 4b).
    const shown = limitText(line.limit);
    const plain = /^\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?\s*(aed)?\s*$/i.exec(String(text));
    const amount = plain ? Number(`${plain[1].replace(/,/g, '')}${plain[3] ?? ''}`) : NaN;
    if (String(text).trim() === shown || !Number.isFinite(amount) || Math.abs(amount - line.limit) < 0.005) {
      input.value = shown;
      return;
    }
    setError(null);
    const result = await setBudgetLimit(line.budget, amount);
    if (result.error) {
      setError(result.error);
      input.value = shown;
      return;
    }
    await reload();
  };
  const usualCell = (spent, usual) =>
    usual == null ? null : (
      <>
        {usual > 0 && spent >= usual * 1.1 - 0.005 && <span className="bud-warn">+{Math.round((spent / usual - 1) * 100)}%</span>}
        {usual > 0 && spent >= usual * 1.1 - 0.005 && ' '}
        <span className="bud-ink2">{formatMoney(usual)}</span>
      </>
    );
  const paceCell = (spent, limit) =>
    limit ? (
      <div className="bud-pace">
        <div className="bud-pace-bar">
          <ProgressBar label="Spent of limit" value={spent} max={limit} tick={pace.isPast ? null : pace.elapsedFraction * limit} tone={spent > limit ? 'neg' : 'accent'} format={formatMoney} />
        </div>
        {spent > limit + 0.005 && <Chip tone="neg">{`Over by ${formatMoney(spent - limit)}`}</Chip>}
      </div>
    ) : null;

  const lineRow = (line) => {
    const isOpen = open === line.id;
    const canOpen = line.recordsCategoryId != null;
    return [
      <tr key={line.id} className={`bud-line${isOpen ? ' bud-open' : ''}`} onClick={canOpen ? () => setOpen(isOpen ? null : line.id) : undefined}>
        <td>
          <span className="bud-name-cell">
            {canOpen && <span className="bud-caret" data-on={isOpen || undefined} aria-hidden="true" />}
            {canOpen ? (
              <button type="button" className="bud-name" aria-expanded={isOpen} onClick={(e) => (e.stopPropagation(), setOpen(isOpen ? null : line.id))}>
                {line.name}
              </button>
            ) : (
              <span className="bud-name">{line.name}</span>
            )}
            {owner(line.categoryId)}
          </span>
        </td>
        <td className="ds-num">{formatBalance(line.spent)}</td>
        <td className="ds-num" onClick={(e) => e.stopPropagation()}>
          {line.budget ? (
            <input
              className="ds-select ds-select-sm bud-lim"
              inputMode="decimal"
              aria-label={`${line.name} limit`}
              defaultValue={limitText(line.limit)}
              key={`${line.id}-${line.limit}`}
              onBlur={(e) => saveLimit(line, e.target.value, e.target)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          ) : (
            <span className="bud-ink2">—</span>
          )}
        </td>
        <td className="ds-num bud-usual">{usualCell(line.spent, line.usual)}</td>
        <td className="bud-pace-cell">{paceCell(line.spent, line.limit)}</td>
      </tr>,
      isOpen && (
        <tr key={`${line.id}-records`} className="bud-records-row">
          <td colSpan={5}>
            <LineRecords line={line} categories={categories} transactions={transactions} year={year} month={month} scopeMemberId={scopeMemberId} now={now} onOpenRecords={onOpenRecords} onEdit={onEdit} />
          </td>
        </tr>
      ),
    ];
  };

  return (
    <Card
      title="By category"
      flush
      info={<InfoButton about="the table">Usual is the average of up to six earlier months with records. The tick on each bar is how far through the month it is. Choose a line to see its transactions.</InfoButton>}
    >
      {error && (
        <div className="bud-error" role="alert">
          {error}
        </div>
      )}
      <div className="ds-table-wrap" tabIndex={0} role="region" aria-label="Budget lines">
        <table className="ds-table bud-table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className="ds-num bud-col-spent">
                Spent
              </th>
              <th scope="col" className="ds-num bud-col-limit">
                Limit
              </th>
              <th scope="col" className="ds-num bud-col-usual">
                Usual
              </th>
              <th scope="col" className="bud-col-pace">
                Pace
              </th>
            </tr>
          </thead>
          <tbody>
            {table.sections.flatMap((section) => [
              section.group && (
                <tr key={section.group.id} className="bud-group">
                  <td>
                    <span className="bud-name">{section.group.name}</span>
                  </td>
                  <td className="ds-num">{formatMoney(section.group.spent)}</td>
                  <td className="ds-num bud-lim-total">{formatMoney(section.group.limit)}</td>
                  <td className="ds-num bud-usual">{usualCell(section.group.spent, section.group.usual)}</td>
                  <td className="bud-pace-cell" />
                </tr>
              ),
              ...section.lines.flatMap(lineRow),
            ])}
            <tr className="bud-total">
              <td>
                <span className="bud-name">Budgeted</span>
              </td>
              <td className="ds-num">{formatMoney(table.budgeted.spent)}</td>
              <td className="ds-num bud-lim-total">{formatMoney(table.budgeted.limit)}</td>
              <td className="bud-usual" />
              <td className="bud-pace-cell">{paceCell(table.budgeted.spent, table.budgeted.limit)}</td>
            </tr>
            <tr className="bud-outside">
              <td>
                <span className="bud-name-cell">
                  <span className="bud-name">Outside budget</span>
                  {table.uncategorised > 0 && (
                    <button type="button" className="ds-chip ds-chip-warn" onClick={() => onOpenRecords({ categoryId: UNCATEGORISED, year, month })}>
                      {`${formatMoney(table.uncategorised)} uncategorised`}
                    </button>
                  )}
                </span>
              </td>
              <td className="ds-num">{formatMoney(table.outside)}</td>
              <td />
              <td className="bud-usual" />
              <td className="bud-pace-cell">
                <button type="button" className="ds-link" onClick={() => onOpenRecords({ year, month })}>
                  Activity →
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// A line's records for the month, beneath it, with the way to all of them in
// Activity and to the line's budget (design/prototype bud-exp).
function LineRecords({ line, categories, transactions, year, month, scopeMemberId, now, onOpenRecords, onEdit }) {
  const records = lineRecords(transactions, line.recordsCategoryId, categories, year, month, scopeMemberId, now, { ownOnly: line.ownOnly });
  return (
    <div className="bud-records" role="region" aria-label={`${line.name} this month`}>
      {records.length === 0 ? (
        <div className="bud-ink3">Nothing spent here this month.</div>
      ) : (
        <ul className="bud-record-list">
          {records.map(({ t, amount }) => (
            <li key={t.id}>
              <span className="bud-record-date">{rowDateLabel(t.occurred_at, now)}</span>
              <span className="bud-record-name">{t.merchant || 'Transaction'}</span>
              {t.kind === 'refund' && <Chip tone="pos">Refund</Chip>}
              <span className="ds-num">{formatSigned(amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="bud-record-actions">
        {/* Activity's category takes in its subcategories, so a general
            line's own records have no list there to open. */}
        {!line.ownOnly && (
          <button type="button" className="ds-link ds-link-accent" onClick={() => onOpenRecords({ categoryId: line.recordsCategoryId, year, month })}>
            All in Activity →
          </button>
        )}
        {line.budget && (
          <button type="button" className="ds-link" onClick={() => onEdit({ ...line.budget, spentSoFar: line.spent, recordsCategoryId: line.recordsCategoryId })}>
            Edit budget
          </button>
        )}
      </div>
    </div>
  );
}

// Who carries what this month. Each person's budget is their own lines plus
// their split of the shared ones; below it, what each has paid so far against
// their part of what was spent, and the one transfer that evens it up. The
// wording stays neutral: it is a balancing figure, not a debt.
// Household-wide whatever the scope: a split is between the two of you.
function HouseholdShare({ members, categories, budgets, transactions, accounts, recurring, year, month, pace, now }) {
  const share = householdShare({ members, categories, budgets, transactions, accounts, recurring, year, month, now });
  const planned = share.people.some((p) => p.planned > 0 || p.savingPlanned > 0);
  if (!planned && share.spent === 0) return null;
  const pctLabel = share.people.map((p) => `${p.member.display_name} ${Math.round(p.pct * 100)}%`).join(' · ');
  const tone = new Map(members.map((m, i) => [m.id, i === 0 ? 'a' : 'b']));
  const saving = share.people.some((p) => p.savingPlanned > 0);
  const settled = share.spent > 0 && !pace.isFuture;
  return (
    <Card
      title="Household share"
      className="bud-share"
      flush
      right={<span className="bud-ink3">Shared costs split {share.basis === 'income' ? `by income: ${pctLabel}` : 'evenly'}</span>}
      info={
        <InfoButton about="the household share">
          Each person’s part is their own costs plus their split of the shared ones. Paid is spending from each person’s own accounts and cards, a joint
          account’s split the same way; uncategorised spending counts as shared. Whose cost a category is is set in Settings → Categories.
          {share.basis === 'even' && ' Add each salary as an income reminder to split by income instead.'}
        </InfoButton>
      }
    >
      {settled && (
        <div className="bud-share-settle">
          <div className="bud-label">To even up {pace.isPast ? 'for the month' : 'so far'}</div>
          <div className="bud-fig">
            {share.settle ? (
              <>
                {formatMoney(share.settle.amount)}{' '}
                <span className="bud-of">
                  from {share.settle.from.display_name} to {share.settle.to.display_name}
                </span>
              </>
            ) : (
              'All even'
            )}
          </div>
        </div>
      )}
      {planned && (
        <div className="ds-table-wrap" tabIndex={0} role="region" aria-label="Planned and paid by person">
          <table className="ds-table bud-share-table">
            <thead>
              <tr>
                <th scope="col" aria-label="Person" />
                <th scope="col" className="ds-num">
                  Own
                </th>
                <th scope="col" className="ds-num">
                  Share of shared
                </th>
                <th scope="col" className="ds-num">
                  Planned
                </th>
                {saving && (
                  <th scope="col" className="ds-num">
                    Saving
                  </th>
                )}
                {settled && (
                  <th scope="col" className="ds-num">
                    Part so far
                  </th>
                )}
                {settled && (
                  <th scope="col" className="ds-num">
                    Paid so far
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {share.people.map((p) => (
                <tr key={p.member.id}>
                  <td>
                    <span className="bud-name-cell">
                      <Avatar name={p.member.display_name} initial={p.member.display_name.slice(0, 1).toUpperCase()} tone={tone.get(p.member.id)} />
                      <span className="bud-name">{p.member.display_name}</span>
                    </span>
                  </td>
                  <td className="ds-num">{formatMoney(p.ownPlanned)}</td>
                  <td className="ds-num">{formatMoney(p.sharedPlanned)}</td>
                  <td className="ds-num">{formatMoney(p.planned)}</td>
                  {saving && <td className="ds-num">{formatMoney(p.savingPlanned)}</td>}
                  {settled && <td className="ds-num">{formatMoney(p.responsible)}</td>}
                  {settled && <td className="ds-num">{formatMoney(p.paid)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// What the month set out to save against what it did: income less ALL
// spending, the same net saved the year view and Overview show. Saving is
// what is left over, so there is nothing to file under the savings category
// itself -- the target is met by spending less than was earned.
function SavingsTarget({ rows, saved, income, pace, catById, scoped, onEdit }) {
  if (rows.length === 0) return null;
  const target = rows.reduce((s, r) => s + Number(r.amount), 0);
  const names = rows.map((r) => catById.get(r.category_id)?.name ?? 'Savings').join(', ');
  const gap = target - saved;
  const chip = gap <= 0 ? <Chip tone="pos">Target met</Chip> : <Chip tone={pace.isPast ? 'neg' : 'neutral'}>{`${formatMoney(gap)} short${pace.isPast ? '' : ' so far'}`}</Chip>;
  return (
    <Card
      title="Savings target"
      className="bud-savings"
      right={chip}
      info={
        <InfoButton about="the savings target">
          Saved is income less all spending this month. The target is not part of the budget: money set aside is not money spent.
          {scoped && ' Saved is this person’s share; the target is the whole household’s.'}
        </InfoButton>
      }
    >
      <div className="bud-fig">
        <span data-negative={saved < 0 || undefined}>{formatBalance(saved)}</span> <span className="bud-of">of {formatMoney(target)}</span>
      </div>
      <ProgressBar label="Saved of target" value={Math.max(0, saved)} max={target} tone="pos" format={formatMoney} />
      <div className="bud-savings-foot">
        <span className="bud-ink3">{income > 0 ? `${Math.round((saved / income) * 100)}% of income saved` : 'No income recorded this month'}</span>
        <button type="button" className="ds-link" onClick={() => onEdit(rows[0])}>
          {names} · edit
        </button>
      </div>
    </Card>
  );
}

const sum = (values) => values.reduce((s, v) => s + (v ?? 0), 0);

// The year at a glance, laid out like a family budget sheet: one row per
// budgeted group (subcategories beneath it when there are several), each
// month's actuals to date and budgets for the months ahead, then a year
// total, a monthly average and each group's share of what was spent. Every
// actual comes from budgetGroupSpend, the same figures the month view shows,
// so a month reads identically in either view and every column adds up.
function YearView({ year, budgets, savingsBudgets = [], transactions, categories, scopeMemberId, now }) {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const yearBudgets = budgets.filter((b) => b.year === year);
  const catIds = [...new Set(yearBudgets.map((b) => b.category_id))];
  const groupOf = (id) => catById.get(id)?.parent_id ?? id;
  const nameOf = (id) => catById.get(id)?.name ?? 'Unknown';

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const isActual = (m) => year < currentYear || (year === currentYear && m <= currentMonth);
  // The current month is still open: it counts toward totals but not toward
  // an average, where a half-month would drag every category down.
  const isClosed = (m) => year < currentYear || (year === currentYear && m < currentMonth);
  const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

  const months = MONTHS.map((m) =>
    isActual(m)
      ? {
          m,
          actual: true,
          spend: budgetGroupSpend(transactions, catIds, catById, year, m, scopeMemberId, now),
          income: monthIncome(transactions, year, m, scopeMemberId, now),
        }
      : { m, actual: false },
  );
  const planned = (ids, m) => sum(yearBudgets.filter((b) => b.month === m && ids.includes(b.category_id)).map((b) => Number(b.amount)));

  // Groups in order of what they took this year, biggest first.
  const groupIds = [...new Set(catIds.map(groupOf))];
  const groups = groupIds.map((gid) => {
    const members = catIds.filter((id) => groupOf(id) === gid).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const cells = months.map((mo) => (mo.actual ? { value: mo.spend.groups.get(gid) ?? 0, kind: 'actual' } : { value: planned(members, mo.m), kind: 'planned' }));
    // One budgeted category in the group -- the group itself or its only
    // budgeted subcategory -- is one row, as in the month view. Several get a
    // row each, plus "other" for spend in the group that none of them holds
    // (posted to the parent, or to an unbudgeted sibling), so the rows add up
    // to the group.
    let children = [];
    if (members.length > 1) {
      children = members.map((cid) => ({
        key: cid,
        name: cid === gid ? `${nameOf(gid)} · general` : nameOf(cid),
        cells: months.map((mo) => (mo.actual ? { value: mo.spend.byCategory.get(cid) ?? 0, kind: 'actual' } : { value: planned([cid], mo.m), kind: 'planned' })),
      }));
      const other = months.map((mo, i) => (mo.actual ? { value: cells[i].value - sum(children.map((c) => c.cells[i].value)), kind: 'actual' } : { value: 0, kind: 'planned' }));
      if (other.some((c) => Math.abs(c.value) >= 0.005)) children.push({ key: `${gid}-other`, name: `Other ${nameOf(gid)}`, cells: other, other: true });
    }
    const subtitle = members.length === 1 && members[0] !== gid ? nameOf(members[0]) : null;
    return { gid, name: nameOf(gid), subtitle, cells, children, actualTotal: sum(cells.filter((c) => c.kind === 'actual').map((c) => c.value)) };
  });
  groups.sort((a, b) => b.actualTotal - a.actualTotal || a.name.localeCompare(b.name));

  const budgetedCells = MONTHS.map((_, i) => sum(groups.map((g) => g.cells[i].value)));
  const outside = months.map((mo) => (mo.actual ? mo.spend.outside : null));
  const allSpending = months.map((mo) => (mo.actual ? mo.spend.total : null));
  const income = months.map((mo) => (mo.actual ? mo.income : null));
  // Net saved is income minus ALL spending, not the budgeted subtotal
  // (QA-09).
  const netSaved = months.map((mo) => (mo.actual ? mo.income - mo.spend.total : null));
  // The savings target per month, when one is set: a line on the net-saved
  // chart and its own row, never part of the budgeted subtotal.
  const target = MONTHS.map((m) => sum(savingsBudgets.filter((b) => b.year === year && b.month === m).map((b) => Number(b.amount))));
  const hasTarget = target.some((t) => t > 0);
  let running = 0;
  const savedSoFar = netSaved.map((v) => (v === null ? null : (running += v)));

  const actualSpendTotal = sum(allSpending);
  const anyActual = months.some((mo) => mo.actual);
  const closedIdx = MONTHS.map((m, i) => (isClosed(m) ? i : null)).filter((i) => i !== null);
  // Average per month: over closed months when there are any; a year with
  // none yet (all ahead, or only the open month) averages what is shown.
  const averageOf = (cells) => {
    const idx = closedIdx.length ? closedIdx : MONTHS.map((_, i) => i).filter((i) => cells[i] !== null);
    return idx.length ? sum(idx.map((i) => cells[i])) / idx.length : null;
  };
  const values = (cells) => cells.map((c) => c.value);

  // The month now running is marked down the grid (design/prototype .cur).
  const activeCol = (i) => (year === currentYear && i === currentMonth - 1 ? 'bud-col-active' : undefined);

  return catIds.length === 0 ? (
    <Card>
      <EmptyState title="No budget set" body={`Nothing budgeted for ${year} yet.`} />
    </Card>
  ) : (
    <Card
      title={`${year} by month`}
      flush
      right={
        <span className="bud-ink3">
          <i>Italic</i> = budgeted, months ahead
        </span>
      }
      info={
        <InfoButton about="the year">
          Months to date show what was spent; months ahead show the budget, in italics. Total adds the two. Each group counts everything spent in it,
          subcategories included, the same as the month view. Net saved is income minus all spending, including categories with no budget and records
          with no category.
          {scopeMemberId !== null && ' Actuals are this person’s share; budgets are the whole household’s.'}
        </InfoButton>
      }
    >
        <div className="ds-table-wrap bud-yearwrap" tabIndex={0} role="region" aria-label={`${year}, month by month`}>
          <table className="ds-table bud-year">
            <thead>
              <tr>
                <th scope="col">Category</th>
                {MONTH_LABELS.map((m, i) => (
                  <th key={m} scope="col" className={activeCol(i)}>
                    {m}
                  </th>
                ))}
                <th scope="col" className="bud-col-sum">Total</th>
                <th scope="col" title="Per month, over the months already closed">
                  Avg / mo
                </th>
                <th scope="col" title="Share of everything actually spent this year">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <YearGroupRows key={g.gid} group={g} activeCol={activeCol} averageOf={averageOf} values={values} actualSpendTotal={actualSpendTotal} />
              ))}
              <tr className="bud-totalrow">
                <td>Budgeted subtotal</td>
                {budgetedCells.map((v, i) => (
                  <td key={i} className={activeCol(i)}>
                    {formatMoney(v)}
                  </td>
                ))}
                <td className="bud-col-sum">{formatMoney(sum(budgetedCells))}</td>
                <td>{formatMoney(averageOf(budgetedCells))}</td>
                <td>{anyActual && actualSpendTotal > 0 ? `${Math.round((sum(groups.map((g) => g.actualTotal)) / actualSpendTotal) * 100)}%` : '—'}</td>
              </tr>
              <SummaryRow label="Outside budget" cells={outside} activeCol={activeCol} average={averageOf(outside)} />
              <SummaryRow label="All spending" cells={allSpending} activeCol={activeCol} average={averageOf(allSpending)} total />
              <SummaryRow label="Income" cells={income} activeCol={activeCol} average={averageOf(income)} />
              <SummaryRow label="Net saved" cells={netSaved} activeCol={activeCol} average={averageOf(netSaved)} signed />
              {hasTarget && <SummaryRow label="Savings target" cells={target} activeCol={activeCol} average={averageOf(target)} />}
              <tr>
                <td>Saved so far</td>
                {savedSoFar.map((v, i) => (
                  <td key={i} className={[activeCol(i), v !== null && v < 0 ? 'ov-warn' : ''].filter(Boolean).join(' ') || undefined}>
                    {v === null ? '—' : formatBalance(v)}
                  </td>
                ))}
                <td className="bud-col-sum">—</td>
                <td>—</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </div>
    </Card>
  );
}

function YearGroupRows({ group, activeCol, averageOf, values, actualSpendTotal }) {
  const cells = values(group.cells);
  return (
    <>
      <tr className={group.children.length ? 'bud-grouprow' : undefined}>
        <td>
          {group.name}
          {group.subtitle && <span className="ov-muted"> · {group.subtitle}</span>}
        </td>
        {group.cells.map((c, i) => (
          <td key={i} className={[activeCol(i), c.kind === 'planned' ? 'bud-planned' : ''].filter(Boolean).join(' ') || undefined}>
            {formatMoney(c.value)}
          </td>
        ))}
        <td className="bud-col-sum">{formatMoney(sum(cells))}</td>
        <td>{formatMoney(averageOf(cells))}</td>
        <td>{actualSpendTotal > 0 ? `${Math.round((group.actualTotal / actualSpendTotal) * 100)}%` : '—'}</td>
      </tr>
      {group.children.map((child) => {
        const childCells = values(child.cells);
        return (
          <tr key={child.key} className="bud-subrow">
            <td className={child.other ? 'ov-muted' : undefined}>{child.name}</td>
            {child.cells.map((c, i) => (
              <td key={i} className={[activeCol(i), c.kind === 'planned' ? 'bud-planned' : ''].filter(Boolean).join(' ') || undefined}>
                {child.other && c.kind === 'planned' ? '—' : formatBalance(c.value)}
              </td>
            ))}
            <td className="bud-col-sum">{formatBalance(sum(childCells))}</td>
            <td>{formatBalance(averageOf(childCells))}</td>
            <td />
          </tr>
        );
      })}
    </>
  );
}

function SummaryRow({ label, cells, activeCol, average, total = false, signed = false }) {
  const fmt = signed ? formatBalance : formatMoney;
  const known = cells.filter((v) => v !== null);
  return (
    <tr className={total ? 'bud-totalrow' : undefined}>
      <td>{label}</td>
      {cells.map((v, i) => (
        <td key={i} className={[activeCol(i), signed && v !== null && v < 0 ? 'ov-warn' : ''].filter(Boolean).join(' ') || undefined}>
          {v === null ? '—' : fmt(v)}
        </td>
      ))}
      <td className="bud-col-sum">{known.length ? fmt(sum(known)) : '—'}</td>
      <td>{average === null ? '—' : fmt(average)}</td>
      <td />
    </tr>
  );
}
