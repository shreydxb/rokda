import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatBalance, formatCompact, formatMoney } from '../../lib/money';
import { budgetGroupSpend, monthIncome, monthPace } from '../../lib/budget';
import { ChartLegend, ColumnChart, LineChart } from '../../charts/Charts';
import BudgetEditor from './BudgetEditor';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Budget({ household, me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, categories, budgets, reload } = data;

  const [view, setView] = useState('month'); // 'month' | 'year'
  const now = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [yearCursor, setYearCursor] = useState(now.getFullYear());
  const [editing, setEditing] = useState(null); // null | 'new' | a budget row

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const catById = new Map(categories.map((c) => [c.id, c]));

  return (
    <div>
      <div className="mn-filters">
        <div className="mn-viewtoggle" style={{ marginLeft: 0 }}>
          <button type="button" className="om-seg" data-active={view === 'month'} onClick={() => setView('month')}>
            Month
          </button>
          <button type="button" className="om-seg" data-active={view === 'year'} onClick={() => setView('year')}>
            Year
          </button>
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Set budget
        </button>
      </div>

      {view === 'month' ? (
        <MonthView
          cursor={cursor}
          setCursor={setCursor}
          budgets={budgets}
          transactions={transactions}
          catById={catById}
          scopeMemberId={scopeMemberId}
          now={now}
          onEdit={setEditing}
        />
      ) : (
        <YearView
          year={yearCursor}
          setYear={setYearCursor}
          budgets={budgets}
          transactions={transactions}
          categories={categories}
          scopeMemberId={scopeMemberId}
          now={now}
        />
      )}

      {editing && (
        <BudgetEditor
          item={editing === 'new' ? null : editing}
          householdId={household?.id}
          categories={categories}
          year={view === 'year' ? yearCursor : cursor.getFullYear()}
          month={cursor.getMonth() + 1}
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

function MonthView({ cursor, setCursor, budgets, transactions, catById, scopeMemberId, now, onEdit }) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth() + 1;
  const rows = budgets.filter((b) => b.year === year && b.month === month);
  const pace = monthPace(year, month, now);

  // What was actually spent, budgeted or not (QA-09), split by the same
  // groups the rows below show -- so the hero, the rows and the footer are
  // one set of figures that adds up, and the year view reads the same month
  // identically.
  const spend = budgetGroupSpend(transactions, rows.map((r) => r.category_id), catById, year, month, scopeMemberId, now);
  const actuals = spend.byCategory;
  const totalBudget = rows.reduce((s, r) => s + Number(r.amount), 0);
  const totalActual = spend.inBudgetedGroups;
  const outsideBudget = spend.outside;

  // Budgets are almost always set at subcategory level, but a household
  // categorises inconsistently -- the same kind of purchase sometimes gets
  // the specific subcategory, sometimes just the broad parent -- so a
  // subcategory's own budget could read "not started" next to real matching
  // spend sitting one level up. Grouping by main category and rolling actuals
  // up to match (rollupActualsByGroup) fixes that at the level someone
  // actually glances at first; the per-subcategory breakdown is still there,
  // one click away.
  const rolledActuals = spend.groups;
  const groups = new Map();
  for (const r of rows) {
    const groupId = catById.get(r.category_id)?.parent_id ?? r.category_id;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(r);
  }

  const usedPct = totalBudget > 0 ? totalActual / totalBudget : 0;

  return (
    <div>
      <div className="cal-nav" style={{ marginTop: 22 }}>
        <button type="button" className="om-btn" onClick={() => setCursor(new Date(year, month - 2, 1))}>
          ← Prev
        </button>
        <div className="fig">
          {MONTH_LABELS[month - 1]} {year}
        </div>
        <button type="button" className="om-btn" onClick={() => setCursor(new Date(year, month, 1))}>
          Next →
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No budget set</div>
          <div className="ov-empty-body">Nothing budgeted for {MONTH_LABELS[month - 1]} {year} yet.</div>
        </div>
      ) : (
        <>
          <section className="bud-hero">
            <div>
              <div className="ov-kicker">Spent of budget</div>
              <div className="ov-hero fig">
                {formatMoney(totalActual)} <span className="bud-hero-of">of {formatMoney(totalBudget)}</span>
              </div>
            </div>
            <div className="bud-hero-bar-wrap">
              <div className="bud-bar bud-bar-lg">
                <span className={`bud-bar-spent ${usedPct > 1 ? 'bud-bar-over' : ''}`} style={{ width: `${Math.min(100, usedPct * 100)}%` }} />
                <span className="bud-bar-marker" style={{ left: `${Math.min(100, pace.elapsedFraction * 100)}%` }} />
              </div>
              <div className="bud-hero-labels">
                <span>{Math.round(usedPct * 100)}% used</span>
                <span>{pace.isPast ? 'Month complete' : `Pace marker · ${Math.round(pace.elapsedFraction * 100)}% of month elapsed`}</span>
              </div>
              <div className={`bud-tracknote ${usedPct > 1 ? 'ov-warn' : ''}`}>
                {pace.isPast
                  ? `Month closed at ${formatMoney(totalActual)} of ${formatMoney(totalBudget)} budgeted.`
                  : usedPct > 1
                    ? `Already ${formatMoney(totalActual - totalBudget)} over budget.`
                    : `${Math.round(pace.elapsedFraction * 100)}% of the month gone, ${Math.round(usedPct * 100)}% of budget spent.`}
              </div>
            </div>
          </section>

          <div className="bud-table-head">
            <div>Category</div>
            <div className="bud-col-num">Spent</div>
            <div className="bud-col-num">Limit</div>
            <div>Pace</div>
          </div>
          <div className="mn-list">
            {[...groups.entries()].map(([groupId, groupRows]) => (
              <BudgetGroup
                key={groupId}
                groupId={groupId}
                groupCategory={catById.get(groupId)}
                rows={groupRows}
                actuals={actuals}
                groupActual={rolledActuals.get(groupId) ?? 0}
                catById={catById}
                pace={pace}
                onEdit={onEdit}
              />
            ))}
          </div>

          <div className="bud-footer">
            <div className="bud-footer-row">
              <span>Budgeted subtotal</span>
              <span>
                Budget <span className="fig">{formatMoney(totalBudget)}</span> · Spent <span className="fig">{formatMoney(totalActual)}</span>
                {pace.isPast && ' · final'}
              </span>
            </div>
            <div className="bud-footer-row">
              <span>All spending</span>
              <span>
                Total <span className="fig">{formatMoney(spend.total)}</span>
                {outsideBudget > 0 && (
                  <>
                    {' · outside budget '}
                    <span className="fig">{formatMoney(outsideBudget)}</span>
                    {spend.uncategorised > 0 && ` (${formatMoney(spend.uncategorised)} uncategorised)`}
                  </>
                )}
              </span>
            </div>
            {scopeMemberId !== null && (
              <div className="ov-muted" style={{ marginTop: 4 }}>
                Actuals are this person’s share; budgets are the whole household’s, so the two are not like for like.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BudgetGroup({ groupId, groupCategory, rows, actuals, groupActual, catById, pace, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const groupBudget = rows.reduce((s, r) => s + Number(r.amount), 0);
  // A category budgeted directly, with no subcategory also budgeted this
  // month -- nothing to expand into, so it behaves like a flat row.
  const isSingle = rows.length === 1 && rows[0].category_id === groupId;
  // Exactly one budgeted subcategory under this parent: there's no other
  // subcategory a parent-level transaction could belong to instead, so the
  // subrow can safely show the same rolled total the group row does rather
  // than its own (possibly zero) raw actual -- a household categorising
  // inconsistently shouldn't see this one subcategory read "not started"
  // right below a group row showing real spend.
  const onlyBudgetedSubcategory = rows.length === 1;

  if (isSingle) {
    return (
      <BudgetRow
        name={groupCategory?.name ?? 'Unknown'}
        budget={Number(rows[0].amount)}
        actual={groupActual}
        pace={pace}
        onClick={() => onEdit({ ...rows[0], spentSoFar: groupActual })}
      />
    );
  }

  return (
    <div className="bud-group">
      <BudgetRow
        name={groupCategory?.name ?? 'Unknown'}
        budget={groupBudget}
        actual={groupActual}
        pace={pace}
        onClick={() => setExpanded((v) => !v)}
        expandable
        expanded={expanded}
      />
      {expanded && (
        <div className="bud-subrows">
          {rows.map((r) => {
            const subActual = onlyBudgetedSubcategory ? groupActual : (actuals.get(r.category_id) ?? 0);
            return (
              <BudgetRow
                key={r.id}
                name={catById.get(r.category_id)?.name ?? 'Unknown'}
                budget={Number(r.amount)}
                actual={subActual}
                pace={pace}
                onClick={() => onEdit({ ...r, spentSoFar: subActual })}
                sub
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function BudgetRow({ name, budget, actual, pace, onClick, expandable, expanded, sub }) {
  const overNow = actual > budget;
  return (
    <button type="button" className={`bud-tr ${sub ? 'bud-tr-sub' : ''}`} onClick={onClick}>
      <div className="bud-tr-name">
        {expandable && <span className="bud-chevron">{expanded ? '▾' : '▸'}</span>}
        {name}
      </div>
      <div className="bud-col-num fig">{formatMoney(actual)}</div>
      <div className="bud-col-num"><span className="bud-limit-chip">{formatMoney(budget)}</span></div>
      <div className="bud-tr-pace">
        <div className="bud-bar">
          <span className={`bud-bar-spent ${overNow ? 'bud-bar-over' : ''}`} style={{ width: `${Math.min(100, (actual / (budget || 1)) * 100)}%` }} />
        </div>
        <div className={`bud-pacetext ${overNow ? 'ov-warn' : ''}`}>
          {overNow ? `over by ${formatMoney(actual - budget)}` : pace.isPast ? 'final' : actual > 0 ? 'tracking' : 'not started'}
        </div>
      </div>
    </button>
  );
}

const sum = (values) => values.reduce((s, v) => s + (v ?? 0), 0);

// The year at a glance, laid out like a family budget sheet: one row per
// budgeted group (subcategories beneath it when there are several), each
// month's actuals to date and budgets for the months ahead, then a year
// total, a monthly average and each group's share of what was spent. Every
// actual comes from budgetGroupSpend, the same figures the month view shows,
// so a month reads identically in either view and every column adds up.
function YearView({ year, setYear, budgets, transactions, categories, scopeMemberId, now }) {
  const [activeMonth, setActiveMonth] = useState(null);
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

  const active = activeMonth ?? (year === currentYear ? currentMonth - 1 : anyActual ? 11 : null);
  const activeCol = (i) => (i === active ? 'bud-col-active' : undefined);

  return (
    <div>
      <div className="cal-nav" style={{ marginTop: 22 }}>
        <button type="button" className="om-btn" onClick={() => setYear(year - 1)}>
          ← {year - 1}
        </button>
        <div className="fig">{year}</div>
        <button type="button" className="om-btn" onClick={() => setYear(year + 1)}>
          {year + 1} →
        </button>
      </div>

      {anyActual && (
        <section style={{ marginTop: 22 }}>
          <div className="ch-pair">
            <div>
              <div className="ov-kicker">Net saved each month</div>
              <ColumnChart
                columns={MONTHS.map((m, i) => ({ key: m, label: MONTH_LABELS[i], values: [netSaved[i] ?? 0], muted: netSaved[i] === null }))}
                series={[{ key: 'net', label: 'Net saved', color: (v) => (v < 0 ? 'var(--neg)' : 'var(--pos)') }]}
                height={150}
                formatTick={formatCompact}
                labelEvery={2}
                activeIndex={active}
                onActiveChange={setActiveMonth}
                ariaLabel={`Net saved each month of ${year}: income minus all spending. Use the arrow keys to move between months.`}
              />
            </div>
            <div>
              <div className="ov-kicker">Saved so far in {year}</div>
              <LineChart
                points={MONTHS.map((m, i) => ({ key: m, label: MONTH_LABELS[i], value: savedSoFar[i] }))}
                color="var(--accent)"
                height={150}
                formatTick={formatCompact}
                labelEvery={2}
                activeIndex={active}
                onActiveChange={setActiveMonth}
                ariaLabel={`Running total of net saved through ${year}. Use the arrow keys to move between months.`}
              />
            </div>
          </div>
          {active !== null && (
            <div className="ov-chart-readout">
              <span className="fig">
                {MONTH_LABELS[active]} {year}
              </span>
              {netSaved[active] === null ? (
                <span>Not reached yet · budgeted {formatMoney(budgetedCells[active])}</span>
              ) : (
                <>
                  <span>
                    Income <b className="fig">{formatMoney(income[active])}</b>
                  </span>
                  <span>
                    Spending <b className="fig">{formatMoney(allSpending[active])}</b>
                  </span>
                  <span>
                    Net saved <b className={`fig ${netSaved[active] < 0 ? 'ov-neg' : ''}`}>{formatBalance(netSaved[active])}</b>
                  </span>
                  <span>
                    So far this year <b className="fig">{formatBalance(savedSoFar[active])}</b>
                  </span>
                  {year === currentYear && active === currentMonth - 1 && <span className="ov-muted">month still open</span>}
                </>
              )}
            </div>
          )}
          <ChartLegend
            items={[
              { label: 'Saved', color: 'var(--pos)' },
              { label: 'Overspent', color: 'var(--neg)' },
              { label: 'Running total', color: 'var(--accent)', kind: 'line' },
            ]}
          />
        </section>
      )}

      {catIds.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No budget set</div>
          <div className="ov-empty-body">Nothing budgeted for {year} yet.</div>
        </div>
      ) : (
        <div className="bud-yearwrap">
          <table className="bud-year">
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
          <div className="ov-muted" style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.6 }}>
            Months to date show what was spent; months ahead show the budget, in italics. Total adds the two. Each group counts
            everything spent in it, subcategories included, the same as the month view. Net saved is income minus <em>all</em>{' '}
            spending, including categories with no budget and records with no category.
            {scopeMemberId !== null && ' Actuals are this person’s share; budgets are the whole household’s.'}
          </div>
        </div>
      )}
    </div>
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
