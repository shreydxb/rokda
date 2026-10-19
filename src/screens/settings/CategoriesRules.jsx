import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { ilikePattern } from '../../lib/rules';
import CategoryEditor from './CategoryEditor';
import RuleEditor from './RuleEditor';
import StarterCategories from './StarterCategories';

export default function CategoriesRules({ household, members = [], data, loading }) {
  const { categories, categoryRules, reload } = data;
  const [showArchived, setShowArchived] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [applying, setApplying] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [starter, setStarter] = useState(false);
  // `rule=<id>` opens that rule's editor, so a link from a transaction's
  // editor ("Open that rule in Settings") or Activity lands on it. Closing it
  // takes the id out of the address, so it doesn't open again.
  const [params, setParams] = useSearchParams();
  const linkedRule = params.get('rule') ? (categoryRules.find((r) => r.id === params.get('rule')) ?? null) : null;
  const shownRule = editingRule ?? linkedRule;
  const closeRule = () => {
    setEditingRule(null);
    if (params.has('rule')) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('rule');
          return next;
        },
        { replace: true },
      );
    }
  };

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
      // A split record's categories are its lines, and a transfer has none:
      // neither is "uncategorised".
      .eq('is_split', false)
      .neq('kind', 'transfer')
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
            <button type="button" className="om-btn" onClick={() => setStarter(true)}>
              Starter set
            </button>
            <button type="button" className="om-btn mn-add" onClick={() => setEditingCategory('new')}>
              + Category
            </button>
          </div>
        </div>

        {categories.length === 0 ? (
          <div className="ov-empty">
            <div className="ov-empty-kicker">No categories</div>
            <div className="ov-empty-body">Add a category to start tagging transactions, or start from a common set and change it from there.</div>
            <div className="ov-empty-actions">
              <button type="button" className="om-btn ov-btn-primary" onClick={() => setStarter(true)}>
                Add starter categories
              </button>
            </div>
          </div>
        ) : (
          <div className="sc-lists">
            <CategoryList title="Income" rows={income} onEdit={setEditingCategory} />
            <CategoryList title="Expense" rows={expense} members={members} onEdit={setEditingCategory} />
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
          members={members}
          onClose={() => setEditingCategory(null)}
          onSaved={async () => {
            setEditingCategory(null);
            await reload();
          }}
        />
      )}

      {starter && (
        <StarterCategories
          householdId={household?.id}
          categories={categories}
          onClose={() => setStarter(false)}
          onSaved={async ({ keepOpen = false } = {}) => {
            if (!keepOpen) setStarter(false);
            await reload();
          }}
        />
      )}

      {shownRule && (
        <RuleEditor
          key={shownRule === 'new' ? 'new' : shownRule.id}
          rule={shownRule === 'new' ? null : shownRule}
          householdId={household?.id}
          categories={categories.filter((c) => !c.archived && !c.is_savings)}
          onClose={closeRule}
          onSaved={async () => {
            closeRule();
            await reload();
          }}
        />
      )}
    </div>
  );
}

// Groups with their subcategories beneath them, as the budget lays them out.
// A subcategory whose group is not in this list (archived and hidden, say)
// stays visible at the top level rather than disappearing with it.
function CategoryList({ title, rows, members = [], onEdit }) {
  const ids = new Set(rows.map((c) => c.id));
  const top = rows.filter((c) => !c.parent_id || !ids.has(c.parent_id));
  const childrenOf = (id) => rows.filter((c) => c.parent_id === id);
  const row = (c, sub) => (
    <button key={c.id} type="button" className={`mn-row ${sub ? 'sc-subrow' : ''}`} onClick={() => onEdit(c)} style={{ opacity: c.archived ? 0.6 : 1 }}>
      <div className="mn-row-main">{c.name}</div>
      {c.owner_member_id && <span className="ov-muted">{members.find((m) => m.id === c.owner_member_id)?.display_name}</span>}
      {c.is_savings && <span className="ov-chip-ok">Savings</span>}
      {c.archived && <span className="ov-muted">Archived</span>}
    </button>
  );
  return (
    <div>
      <div className="ov-muted" style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 8 }}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="ov-muted" style={{ fontSize: 12.5 }}>None.</div>
      ) : (
        <div className="mn-list">{top.flatMap((c) => [row(c, false), ...childrenOf(c.id).map((k) => row(k, true))])}</div>
      )}
    </div>
  );
}
