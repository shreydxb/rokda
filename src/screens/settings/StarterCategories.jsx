import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { missingKeys, planStarter, starterInserts } from '../../lib/starterCategories';
import '../money/TransactionEditor.css';

// Picks from the starter set. Everything the household already has -- under
// its own name, wherever it is filed -- is shown as already there and cannot
// be ticked, so nothing is ever added twice. What is missing starts ticked
// only for a household with no categories at all; one that built its own set
// chooses what to fill in.
export default function StarterCategories({ householdId, categories, onClose, onSaved }) {
  const plan = useMemo(() => planStarter(categories), [categories]);
  const missing = useMemo(() => missingKeys(plan), [plan]);
  const [selected, setSelected] = useState(() => new Set(categories.length === 0 ? missing : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const { count } = starterInserts(plan, [...selected], householdId);

  function toggle(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroup(g) {
    const keys = [...(g.existing || g.flat ? [] : [g.name]), ...g.children.filter((c) => !c.existing).map((c) => `${g.name}/${c.name}`)];
    const allOn = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  async function handleAdd() {
    const { groups, children } = starterInserts(plan, [...selected], householdId);
    if (groups.length + children(new Map()).length === 0) return;
    setSaving(true);
    setError('');
    // Groups first: a new category needs its new group's id.
    const idByGroupName = new Map();
    if (groups.length) {
      const { data, error: groupError } = await supabase.from('categories').insert(groups).select('id, name');
      if (groupError) {
        setSaving(false);
        setError(groupError.message);
        return;
      }
      for (const row of data ?? []) idByGroupName.set(row.name, row.id);
    }
    const rows = children(idByGroupName);
    if (rows.length) {
      const { error: childError } = await supabase.from('categories').insert(rows);
      if (childError) {
        setSaving(false);
        // The groups are in; say so rather than leave the household guessing
        // why half the set appeared.
        setError(`${groups.length ? `${groups.length} group${groups.length === 1 ? ' was' : 's were'} added, but their categories were not: ` : ''}${childError.message}`);
        await onSaved({ keepOpen: true });
        return;
      }
    }
    setSaving(false);
    await onSaved();
  }

  const byKind = [
    ['expense', 'Spending'],
    ['income', 'Income'],
  ];

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label="Starter categories">
        <div className="te-head">
          <div>
            <span className="ov-kicker">Starter categories</span>
            <div className="te-title">{missing.length ? 'Fill in what is missing' : 'Nothing missing'}</div>
          </div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="te-form">
          <div className="ov-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            A common set for a UAE household, grouped like a budget sheet. Anything you already have, under any name or group, is
            marked and will not be added again. There is no Savings category on purpose: moving money into savings is not spending,
            and filing it as spending would make every savings figure read low.
          </div>

          {byKind.map(([kind, title]) => (
            <div key={kind}>
              <div className="te-fieldlabel" style={{ marginBottom: 8 }}>
                {title}
              </div>
              {plan
                .filter((g) => g.kind === kind)
                .map((g) => {
                  const open = g.children.filter((c) => !c.existing);
                  return (
                    <div key={g.name} className="sc-group">
                      <div className="sc-grouphead">
                        {g.flat ? null : (
                          <label className="sc-check">
                            <input
                              type="checkbox"
                              checked={g.existing ? true : open.length > 0 && selected.has(g.name)}
                              disabled={!!g.existing || open.length === 0}
                              onChange={() => toggleGroup(g)}
                            />
                            <span>{g.name}</span>
                          </label>
                        )}
                        {g.existing && g.existing.name !== g.name && <span className="ov-muted"> · you have “{g.existing.name}”</span>}
                        {g.existing && g.existing.name === g.name && <span className="ov-muted"> · already there</span>}
                      </div>
                      <div className={g.flat ? 'sc-children sc-flat' : 'sc-children'}>
                        {g.children.map((c) => {
                          const key = `${g.name}/${c.name}`;
                          return (
                            <label key={key} className="sc-check" data-have={!!c.existing}>
                              <input type="checkbox" checked={c.existing ? true : selected.has(key)} disabled={!!c.existing} onChange={() => toggle(key)} />
                              <span>
                                {c.name}
                                {c.existing && <span className="ov-muted">{c.existing.name === c.name ? ' · already there' : ` · as “${c.existing.name}”`}</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              <button type="button" className="om-btn" onClick={() => setSelected(new Set(selected.size ? [] : missing))} disabled={!missing.length}>
                {selected.size ? 'Clear' : 'Tick everything missing'}
              </button>
              <div className="te-actions-right">
                <button type="button" className="om-btn" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="om-btn ov-btn-primary" onClick={handleAdd} disabled={saving || count === 0}>
                  {saving ? 'Adding…' : count === 0 ? 'Add' : `Add ${count} categor${count === 1 ? 'y' : 'ies'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
