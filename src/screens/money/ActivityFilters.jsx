import { DATE_BASES } from '../../lib/activity';
import { dateRangeLabel, UNCATEGORISED } from '../../lib/activityLink';
import { Popover, Segmented, Switch } from '../../design-system/kit';
import Icon from '../../design-system/Icon';

// Activity's filters in one row, as in the prototype (the revamp, phase 4;
// review S-activity-2): search, the dates, the category and the account, with
// the rest folded behind More. Each filter that narrows the list is named
// under the row as a chip that takes it off again.
const KIND_OPTIONS = [
  { id: 'all', label: 'All types' },
  { id: 'expense', label: 'Expenses' },
  { id: 'income', label: 'Income' },
  { id: 'refund', label: 'Refunds' },
  { id: 'transfer', label: 'Transfers' },
];
const BASIS_CHIP = { scheduled: 'Scheduled only', all: 'Posted and scheduled' };

export default function ActivityFilters({ filters, period, customDates, monthLabel, categories, accounts, anyEstimated, setFilter, chooseDates, setRange, clearOne, clearAll }) {
  const { search, categoryId, accountId, kind, dateBasis, needsReview, estimated } = filters;
  const dateValue = customDates ? 'custom' : period.mode === 'custom' ? 'range' : period.mode;
  const rangeLabel = dateRangeLabel(period.from, period.to);
  const moreCount = (kind !== 'all' ? 1 : 0) + (dateBasis !== 'posted' ? 1 : 0) + (needsReview ? 1 : 0) + (estimated ? 1 : 0);
  const catLabel = (id) => (id === UNCATEGORISED ? 'Uncategorised' : (categories.find((c) => c.id === id)?.name ?? 'Category'));
  const chips = [
    search && { key: 'search', label: `Search: ${search}` },
    period.mode === 'all' && { key: 'range', label: 'All dates' },
    period.mode === 'custom' && { key: 'range', label: rangeLabel },
    categoryId !== 'all' && { key: 'categoryId', label: catLabel(categoryId) },
    accountId !== 'all' && { key: 'accountId', label: accounts.find((a) => a.id === accountId)?.name ?? 'Account' },
    kind !== 'all' && { key: 'kind', label: KIND_OPTIONS.find((k) => k.id === kind)?.label },
    dateBasis !== 'posted' && { key: 'dateBasis', label: BASIS_CHIP[dateBasis] },
    needsReview && { key: 'needsReview', label: 'Needs review' },
    estimated && { key: 'estimated', label: 'AED estimated' },
  ].filter(Boolean);

  return (
    <div className="mn-filterbar">
      <div className="mn-act-filters">
        <span className="mn-search">
          <Icon name="search" />
          <input aria-label="Search" placeholder="Search merchant, note or amount" value={search} onChange={(e) => setFilter('search', e.target.value)} />
        </span>
        <select className="ds-select" aria-label="Dates" value={dateValue} onChange={(e) => chooseDates(e.target.value)}>
          <option value="month">{monthLabel}</option>
          <option value="all">All dates</option>
          {period.mode === 'custom' && !customDates && <option value="range">{rangeLabel}</option>}
          <option value="custom">Custom…</option>
        </select>
        {(customDates || period.mode === 'custom') && (
          <span className="mn-custom-dates">
            <input type="date" className="ds-select" aria-label="From" value={period.from ?? ''} max={period.to ?? undefined} onChange={(e) => setRange('from', e.target.value || null)} />
            <span className="ds-muted">to</span>
            <input type="date" className="ds-select" aria-label="To" value={period.to ?? ''} min={period.from ?? undefined} onChange={(e) => setRange('to', e.target.value || null)} />
          </span>
        )}
        <select className="ds-select" aria-label="Category" value={categoryId} onChange={(e) => setFilter('categoryId', e.target.value)}>
          <option value="all">All categories</option>
          <option value={UNCATEGORISED}>Uncategorised</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parent_id ? `– ${c.name}` : c.name}
            </option>
          ))}
        </select>
        <select className="ds-select" aria-label="Account" value={accountId} onChange={(e) => setFilter('accountId', e.target.value)}>
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.archived_at ? ' (closed)' : ''}
            </option>
          ))}
        </select>
        <Popover label="More" count={moreCount}>
          <label className="mn-pop-field">
            <span>Type</span>
            <select className="ds-select" aria-label="Type" value={kind} onChange={(e) => setFilter('kind', e.target.value)}>
              {KIND_OPTIONS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <div className="mn-pop-field">
            <span>Which dates count</span>
            <Segmented label="Which dates" options={DATE_BASES} value={dateBasis} onChange={(v) => setFilter('dateBasis', v)} full />
          </div>
          <div className="mn-pop-switch">
            <span>Needs review only</span>
            <Switch label="Needs review only" checked={needsReview} onChange={(v) => setFilter('needsReview', v)} />
          </div>
          {anyEstimated && (
            <div className="mn-pop-switch">
              <span>AED estimated only</span>
              <Switch label="AED estimated only" checked={estimated} onChange={(v) => setFilter('estimated', v)} />
            </div>
          )}
        </Popover>
      </div>
      {chips.length > 0 && (
        <ul className="mn-chips" aria-label="Filters">
          {chips.map((c) => (
            <li key={c.key}>
              <button type="button" className="ds-chip ds-chip-neutral mn-chip" aria-label={`Remove ${c.label}`} onClick={() => clearOne(c.key)}>
                {c.label} ×
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="ds-link mn-clear" onClick={clearAll}>
              Clear
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
