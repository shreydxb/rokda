import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { ilikePattern } from '../../lib/rules';
import { householdYearMonth } from '../../lib/day';
import { categoryTable } from '../../lib/categoryTable';
import { Avatar, Card, Chip, EmptyState, Fold, InfoButton } from '../../design-system/kit';
import { Tools } from '../PageTools';
import CategoryEditor from './CategoryEditor';
import RuleEditor from './RuleEditor';
import StarterCategories from './StarterCategories';
import './SettingsTabs.css';

// Settings -> Categories & rules, like the prototype (the revamp, phase 7b;
// review S-categories): the categories as one table, grouped, with whose cost
// each is, this month's budget and its chips, beside the merchant rules as a
// table with Apply. A category and a rule each open in the kit's drawer.

const MATCH = { contains: 'contains', starts_with: 'starts with' };
const amount = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function CategoriesRules({ household, members = [], data, loading }) {
  const { categories = [], categoryRules = [], budgets = [], reload } = data;
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [applying, setApplying] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [starter, setStarter] = useState(false);
  // `rule=<id>` opens that rule's drawer, so a link from a transaction's
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

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const table = categoryTable(categories, budgets, householdYearMonth());
  const nameOf = (id) => categories.find((c) => c.id === id)?.name ?? 'Unknown category';
  const activeRules = categoryRules.filter((r) => !r.archived).length;

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
      setApplyResult({ text: error.message, isError: true });
      return;
    }
    setApplyResult({ text: `Applied to ${updated.length} uncategorised transaction${updated.length === 1 ? '' : 's'}.` });
    await reload();
  }

  const whose = (c) => {
    const at = members.findIndex((m) => m.id === c.owner_member_id);
    if (at < 0) return <span className="ds-muted">Shared</span>;
    const m = members[at];
    return (
      <span className="st-who">
        <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={at === 0 ? 'a' : 'b'} />
        {m.display_name}
      </span>
    );
  };
  const chips = (c) => (
    <span className="st-chips">
      {c.is_savings && <Chip tone="accent">Savings</Chip>}
      {c.stops_after_work && <Chip>Stops with work</Chip>}
    </span>
  );
  const nameButton = (c) => (
    <button type="button" className="st-name" onClick={() => setEditingCategory(c)}>
      {c.name}
    </button>
  );

  return (
    <div className="st-grid st-grid-7-5">
      <Tools>
        <button type="button" className="ds-btn" onClick={() => setEditingRule('new')} disabled={categories.length === 0}>
          + Rule
        </button>
        <button type="button" className="ds-btn ds-btn-primary" onClick={() => setEditingCategory('new')}>
          + Category
        </button>
      </Tools>

      <Card title="Categories" right={categories.length ? <span>{`${table.count} in ${table.groupCount} ${table.groupCount === 1 ? 'group' : 'groups'}`}</span> : null} flush>
        {categories.length === 0 ? (
          <EmptyState title="No categories yet" body="Start from a common set, and change it from there." />
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table st-cats">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Whose cost</th>
                  <th scope="col" className="ds-num">
                    Budget a month
                  </th>
                  <th scope="col">
                    <span className="st-sr">Kind</span>
                  </th>
                </tr>
              </thead>
              {table.groups.map((g) => (
                <tbody key={g.group?.id ?? g.title}>
                  <tr className="st-group">
                    <th scope="colgroup" colSpan={4}>
                      {g.group ? nameButton(g.group) : g.title}
                    </th>
                  </tr>
                  {g.rows.map(({ category: c, budget }) => (
                    <tr key={c.id} data-open="" onClick={(e) => !e.target.closest('button') && setEditingCategory(c)}>
                      <td>{nameButton(c)}</td>
                      <td>{whose(c)}</td>
                      <td className="ds-num">{budget == null ? '—' : amount(budget)}</td>
                      <td>{chips(c)}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}
        <div className="st-card-foot">
          {table.archived.length > 0 && (
            <Fold label="Archived" count={table.archived.length}>
              <ul className="st-archived">
                {table.archived.map((c) => (
                  <li key={c.id}>{nameButton(c)}</li>
                ))}
              </ul>
            </Fold>
          )}
          <button type="button" className="ds-btn ds-btn-sm st-starter" onClick={() => setStarter(true)}>
            Starter set
          </button>
        </div>
      </Card>

      <Card
        title="Merchant rules"
        info={<InfoButton about="Merchant rules">A rule files new entries from the bot and the Inbox under its category. Apply files past uncategorised transactions.</InfoButton>}
        right={categoryRules.length ? <span>{`${activeRules} active`}</span> : null}
        flush
      >
        {categoryRules.length === 0 ? (
          <EmptyState title="No rules yet" body="A rule files a merchant under a category." />
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table st-rules">
              <thead>
                <tr>
                  <th scope="col">When the merchant</th>
                  <th scope="col">File under</th>
                  <th scope="col">
                    <span className="st-sr">Apply</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {categoryRules.map((r) => (
                  <tr key={r.id} data-open="" onClick={(e) => !e.target.closest('button') && setEditingRule(r)}>
                    <td>
                      <button type="button" className="st-name st-rule" onClick={() => setEditingRule(r)}>
                        <span className="ds-muted">{MATCH[r.match_type] ?? r.match_type}</span> <span className="st-mono st-pattern">{r.pattern}</span>
                      </button>
                      {r.archived && <Chip>Off</Chip>}
                    </td>
                    <td>{nameOf(r.category_id)}</td>
                    <td className="st-act">
                      {!r.archived && (
                        <button
                          type="button"
                          className="st-link-btn"
                          aria-label={`Apply ${MATCH[r.match_type] ?? r.match_type} ${r.pattern}`}
                          onClick={() => applyRule(r)}
                          disabled={applying === r.id}
                        >
                          {applying === r.id ? 'Applying…' : 'Apply'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {applyResult && (
          <p className={`st-foot ${applyResult.isError ? 'ds-warn-ink' : 'ds-muted'}`} role={applyResult.isError ? 'alert' : 'status'}>
            {applyResult.text}
          </p>
        )}
      </Card>

      {editingCategory && (
        <CategoryEditor
          category={editingCategory === 'new' ? null : editingCategory}
          categories={categories}
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
