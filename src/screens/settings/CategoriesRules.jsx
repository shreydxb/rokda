import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { ilikePattern } from '../../lib/rules';
import CategoryEditor from './CategoryEditor';
import RuleEditor from './RuleEditor';

export default function CategoriesRules({ household, data, loading }) {
  const { categories, categoryRules, reload } = data;
  const [showArchived, setShowArchived] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [applying, setApplying] = useState(null);
  const [applyResult, setApplyResult] = useState(null);

  const visibleCategories = useMemo(
    () => categories.filter((c) => showArchived || !c.archived),
    [categories, showArchived]
  );
  const income = visibleCategories.filter((c) => c.kind === 'income');
  const expense = visibleCategories.filter((c) => c.kind === 'expense');
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  async function applyRule(rule) {
    setApplying(rule.id);
    setApplyResult(null);
    const { data: updated, error } = await supabase
      .from('transactions')
      .update({ category_id: rule.category_id })
      .eq('household_id', household.id)
      .is('category_id', null)
      .ilike('merchant', ilikePattern(rule))
      .select('id');
    setApplying(null);
    if (error) {
      setApplyResult({ ruleId: rule.id, text: error.message, isError: true });
      return;
    }
    setApplyResult({ ruleId: rule.id, text: `Applied to ${updated.length} uncategorised transaction${updated.length === 1 ? '' : 's'}.` });
    await reload();
  }

  return (
    <div>
      <section style={{ marginTop: 26 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="ov-kicker">Categories</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="om-seg" data-active={showArchived} onClick={() => setShowArchived((s) => !s)}>
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
            <button type="button" className="om-btn mn-add" onClick={() => setEditingCategory('new')}>
              + Category
            </button>
          </div>
        </div>

        {categories.length === 0 ? (
          <div className="ov-empty">
            <div className="ov-empty-kicker">No categories</div>
            <div className="ov-empty-body">Add a category to start tagging transactions.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 44 }}>
            <CategoryList title="Income" rows={income} onEdit={setEditingCategory} />
            <CategoryList title="Expense" rows={expense} onEdit={setEditingCategory} />
          </div>
        )}
      </section>

      <section style={{ marginTop: 44, paddingBottom: 40 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="ov-kicker">Rules</div>
          <button type="button" className="om-btn mn-add" onClick={() => setEditingRule('new')} disabled={categories.length === 0}>
            + Rule
          </button>
        </div>

        {categoryRules.length === 0 ? (
          <div className="ov-empty">
            <div className="ov-empty-kicker">No rules</div>
            <div className="ov-empty-body">
              A rule matches a merchant pattern to a category — suggested while reviewing intake, and applicable on demand to
              existing uncategorised transactions.
            </div>
          </div>
        ) : (
          <div className="mn-list">
            {categoryRules.map((r) => (
              <div key={r.id} className="mn-row" style={{ cursor: 'default', opacity: r.archived ? 0.6 : 1 }}>
                <button type="button" className="mn-row-main" style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', padding: 0 }} onClick={() => setEditingRule(r)}>
                  <div>
                    {r.match_type === 'starts_with' ? 'Starts with' : 'Contains'} "{r.pattern}" → {categoryById.get(r.category_id)?.name ?? 'Unknown category'}
                  </div>
                  <div className="ov-muted" style={{ marginTop: 3 }}>
                    {r.archived ? 'Archived' : 'Active'}
                    {applyResult?.ruleId === r.id && ` · ${applyResult.text}`}
                  </div>
                </button>
                {!r.archived && (
                  <button type="button" className="om-btn" onClick={() => applyRule(r)} disabled={applying === r.id}>
                    {applying === r.id ? 'Applying…' : 'Apply now'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {editingCategory && (
        <CategoryEditor
          category={editingCategory === 'new' ? null : editingCategory}
          householdId={household?.id}
          onClose={() => setEditingCategory(null)}
          onSaved={async () => {
            setEditingCategory(null);
            await reload();
          }}
        />
      )}

      {editingRule && (
        <RuleEditor
          rule={editingRule === 'new' ? null : editingRule}
          householdId={household?.id}
          categories={categories.filter((c) => !c.archived)}
          onClose={() => setEditingRule(null)}
          onSaved={async () => {
            setEditingRule(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function CategoryList({ title, rows, onEdit }) {
  return (
    <div>
      <div className="ov-muted" style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 8 }}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="ov-muted" style={{ fontSize: 12.5 }}>None.</div>
      ) : (
        <div className="mn-list">
          {rows.map((c) => (
            <button key={c.id} type="button" className="mn-row" onClick={() => onEdit(c)} style={{ opacity: c.archived ? 0.6 : 1 }}>
              <div className="mn-row-main">{c.name}</div>
              {c.archived && <span className="ov-muted">Archived</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
