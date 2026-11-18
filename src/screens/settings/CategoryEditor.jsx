import { useId, useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import { supabase } from '../../lib/supabaseClient';
import { groupChoices } from '../../lib/categoryTable';
import { Drawer, InfoButton, Segmented, Switch } from '../../design-system/kit';
import DiscardPrompt from '../DiscardPrompt';
import '../money/TransactionEditor.css';
import './SettingsTabs.css';

// A category, in the kit's drawer (the revamp, phase 7b; design/prototype
// set-cat-open): name, kind, group, whose cost, and switches for savings,
// stopping with work and archived, all saved together. The longer notes sit
// behind an (i) (review S-categories-5).
export default function CategoryEditor({ category, categories = [], householdId, members = [], onClose, onSaved }) {
  const uid = useId();
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState(category?.kind ?? 'expense');
  const [parent, setParent] = useState(category?.parent_id ?? '');
  const [isSavings, setIsSavings] = useState(!!category?.is_savings);
  const [owner, setOwner] = useState(category?.owner_member_id ?? '');
  const [stops, setStops] = useState(!!category?.stops_after_work);
  const [archived, setArchived] = useState(!!category?.archived);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const expense = kind === 'expense';
  const dirty =
    name !== (category?.name ?? '') ||
    kind !== (category?.kind ?? 'expense') ||
    parent !== (category?.parent_id ?? '') ||
    isSavings !== !!category?.is_savings ||
    owner !== (category?.owner_member_id ?? '') ||
    stops !== !!category?.stops_after_work ||
    archived !== !!category?.archived;
  const { confirmingClose, requestClose, keepEditing, escapeKey } = useCloseGuard({ dirty, onClose, listen: false });

  // The groups it may sit in: those that already are groups, of its kind
  // and its savings-or-not (lib/categoryTable.js). The one it is in stays
  // offered whatever is switched: it never leaves its group unasked (the
  // fresh review of 7b).
  const choices = groupChoices(categories, { id: category?.id, kind, is_savings: expense && isSavings });
  // A group (a category with a subcategory in use) keeps its kind and its
  // savings: changing them on the group alone left it, and everything in
  // it, out of the table (the fresh review of 7b).
  const isGroup = Boolean(category?.id && categories.some((c) => c.parent_id === category.id && !c.archived));

  async function handleSave(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name it.');
      return;
    }
    setSaving(true);
    setError('');
    // Only an expense category can be savings (the database refuses the
    // rest); an owner only means something for costs, and only a cost stops
    // when work does. Switching to income clears them rather than failing.
    const payload = {
      name: name.trim(),
      kind,
      parent_id: parent || null,
      is_savings: expense && isSavings,
      owner_member_id: expense && owner ? owner : null,
      stops_after_work: expense && stops,
      ...(category ? { archived } : {}),
    };
    const { error: saveError } = category
      ? await supabase.from('categories').update(payload).eq('id', category.id)
      : await supabase.from('categories').insert({ ...payload, household_id: householdId });
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  const formId = `${uid}-form`;
  const footer = (
    <div className="st-dfoot">
      {error && (
        <p className="ds-warn-ink st-derror" role="alert">
          {error}
        </p>
      )}
      <div className="te-actions st-dfoot-row">
        <div className="te-actions-right">
          {confirmingClose ? (
            <DiscardPrompt onDiscard={onClose} onKeepEditing={keepEditing} />
          ) : (
            <>
              <button type="button" className="om-btn" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" form={formId} className="om-btn ov-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : category ? 'Save' : 'Add category'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const switchRow = (label, hint, checked, onChange, disabled = false) => (
    <div className="st-switch">
      <div>
        <div className="st-switch-label">{label}</div>
        <div className="ds-muted st-hint">{hint}</div>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );

  return (
    <Drawer kicker={category ? 'Category' : 'New category'} title={category ? category.name : 'Add a category'} dirty={dirty} onClose={requestClose} onEscape={escapeKey} footer={footer}>
      <form id={formId} className="te-form" onSubmit={handleSave} noValidate>
        <div className="st-field">
          <label className="st-label" htmlFor={`${uid}-name`}>
            Name
          </label>
          <input id={`${uid}-name`} className="ds-select st-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pets" />
        </div>
        <div className="st-field">
          <span className="st-label">Kind</span>
          <Segmented
            label="Kind"
            options={[
              { id: 'expense', label: 'Expense', disabled: isGroup },
              { id: 'income', label: 'Income', disabled: isGroup },
            ]}
            value={kind}
            onChange={setKind}
          />
          {isGroup && <p className="ds-muted st-hint">A group keeps its kind and savings; its subcategories follow it.</p>}
        </div>
        <div className="st-field-row">
          {!isGroup && (choices.length > 0 || parent) && (
            <div className="st-field">
              <label className="st-label" htmlFor={`${uid}-group`}>
                Group
              </label>
              <select id={`${uid}-group`} className="ds-select st-input" value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">None</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {parent && !choices.some((c) => c.id === parent) && <option value={parent}>{categories.find((c) => c.id === parent)?.name ?? 'Its group'}</option>}
              </select>
            </div>
          )}
          {expense && members.length > 1 && (
            <div className="st-field">
              <div className="st-label">
                <label htmlFor={`${uid}-owner`}>Whose cost</label>
                <InfoButton about="Whose cost">Shared costs are split between you by income; one person's own costs are theirs alone. A subcategory left shared follows its group when the group is someone's.</InfoButton>
              </div>
              <select id={`${uid}-owner`} className="ds-select st-input" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Shared</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {expense && switchRow('Savings, not spending', 'Its budget becomes a savings target', isSavings, setIsSavings, isGroup)}
        {expense && switchRow('Stops when work stops', 'Left out of spending after work', stops, setStops)}
        {category && switchRow('Archived', 'Kept on past transactions only', archived, setArchived)}
      </form>
    </Drawer>
  );
}
