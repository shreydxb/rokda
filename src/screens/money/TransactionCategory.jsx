import { fileableCategories } from '../../lib/fileableCategories';
import { formatMoney } from '../../lib/money';
import { unallocated } from '../../lib/splits';

// Part of the transaction editor (TransactionEditor.jsx), split out with
// the round 2 cleanup (SHR-383).
//
// Where the money is filed: the purchase's categories for a linked refund,
// the lines of a split (lib/splits.js), or one category and subcategory, with
// what follows them (remembering the merchant) as children.
export default function TransactionCategory({ tx, form, set, categories, followsPurchase, split, setLines, amountAed, children }) {
  // A refund reverses an earlier expense, so it draws from the same category
  // list as an expense rather than having none at all.
  const categoryKind = form.type === 'refund' ? 'expense' : form.type;
  // Savings categories hold money set aside, not spent, so nothing new is
  // filed under them; a record already there keeps showing where it is.
  const kindCategories = categories.filter((c) => c.kind === categoryKind && ((!c.archived && !c.is_savings) || c.id === form.category_id));
  const mainCategories = kindCategories.filter((c) => !c.parent_id);
  const selectedCategory = kindCategories.find((c) => c.id === form.category_id);
  const selectedMainId = selectedCategory ? (selectedCategory.parent_id || selectedCategory.id) : '';
  const subcategories = kindCategories.filter((c) => c.parent_id === selectedMainId);
  return (
    <>
      {followsPurchase ? (
        <div className="te-fieldcell">
          <span className="te-fieldlabel">Category</span>
          <div className="te-fieldvalue">
            {tx?.is_split
              ? (tx.transaction_splits ?? []).map((l) => categories.find((c) => c.id === l.category_id)?.name ?? 'Unknown').join(' + ')
              : (categories.find((c) => c.id === tx?.category_id)?.name ?? 'Uncategorised')}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            Follows the purchase it refunds. Unlink it to file it elsewhere.
          </div>
        </div>
      ) : split ? (
        <div className="te-split" role="group" aria-label="Split across categories">
          <span className="te-fieldlabel">Split across categories · AED</span>
          {split.map((line, n) => (
            <div key={n} className="te-split-line">
              <select
                className="te-fieldvalue"
                aria-label={`Category ${n + 1}`}
                value={line.category_id}
                onChange={(e) => setLines(split.map((l, k) => (k === n ? { ...l, category_id: e.target.value } : l)))}
              >
                <option value="">Choose…</option>
                {fileableCategories(kindCategories, null, line.category_id || null).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                className="te-fieldvalue te-split-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                aria-label={`Amount ${n + 1}`}
                value={line.amount}
                onChange={(e) => setLines(split.map((l, k) => (k === n ? { ...l, amount: e.target.value } : l)))}
              />
              <button type="button" className="te-split-remove" aria-label={`Remove line ${n + 1}`} disabled={split.length <= 2} onClick={() => setLines(split.filter((_, k) => k !== n))}>
                ×
              </button>
            </div>
          ))}
          <div className="te-split-foot">
            <button type="button" className="te-split-link" onClick={() => setLines([...split, { category_id: '', amount: '' }])}>
              + Add a line
            </button>
            {/* What is still to place, so the lines visibly add up to the total. */}
            <span className={unallocated(split, amountAed ?? 0) === 0 ? 'ov-pos' : 'ov-warn'}>
              {unallocated(split, amountAed ?? 0) === 0
                ? 'Adds up'
                : unallocated(split, amountAed ?? 0) > 0
                  ? `${formatMoney(unallocated(split, amountAed ?? 0), { decimals: 2 })} left to allocate`
                  : `${formatMoney(unallocated(split, amountAed ?? 0), { decimals: 2 })} over the total`}
            </span>
          </div>
          <button type="button" className="te-split-link" onClick={() => setLines(null)}>
            One category instead
          </button>
        </div>
      ) : (
        <>
          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Category</span>
              <select aria-label="Category"
                className="te-fieldvalue"
                value={selectedMainId}
                onChange={(e) => set('category_id', e.target.value)}
              >
                <option value="">Uncategorised</option>
                {mainCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {subcategories.length > 0 && (
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Subcategory</span>
                <select aria-label="Subcategory"
                  className="te-fieldvalue"
                  value={selectedCategory?.parent_id ? form.category_id : ''}
                  onChange={(e) => set('category_id', e.target.value || selectedMainId)}
                >
                  {/* A group is not where a new record goes (lib/fileableCategories.js);
                      a record already filed under it keeps "General". */}
                  {tx?.category_id && tx.category_id === selectedMainId ? <option value="">General</option> : <option value="" disabled>Choose…</option>}
                  {subcategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {form.type !== 'transfer' && (
            <button
              type="button"
              className="te-split-link"
              onClick={() =>
                // Starts from the category already chosen, holding the
                // whole amount, and an empty second line to move some to.
                setLines([
                  { category_id: form.category_id || '', amount: form.amount },
                  { category_id: '', amount: '' },
                ])
              }
            >
              Split across categories
            </button>
          )}

          {children}
        </>
      )}
    </>
  );
}
