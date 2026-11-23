import { useId, useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import { supabase } from '../../lib/supabaseClient';
import { Drawer, InfoButton, Segmented, Switch } from '../../design-system/kit';
import DiscardPrompt from '../DiscardPrompt';
import '../money/TransactionEditor.css';
import './SettingsTabs.css';

// A merchant rule, in the kit's drawer (the revamp, phase 7b; design/prototype
// set-rule-open): how it matches, the merchant pattern, the category it files
// under and whether it is active, saved together.
const MATCH = { contains: 'Contains', starts_with: 'Starts with' };

export default function RuleEditor({ rule, householdId, categories, onClose, onSaved }) {
  const uid = useId();
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [matchType, setMatchType] = useState(rule?.match_type ?? 'contains');
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? categories[0]?.id ?? '');
  const [active, setActive] = useState(!rule?.archived);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = pattern !== (rule?.pattern ?? '') || matchType !== (rule?.match_type ?? 'contains') || categoryId !== (rule?.category_id ?? categories[0]?.id ?? '') || active !== !rule?.archived;
  // Escape steps back out of a delete waiting to be confirmed before it
  // closes anything.
  const { confirmingClose, requestClose, keepEditing, escapeKey } = useCloseGuard({
    dirty,
    onClose,
    listen: false,
    onEscape: () => {
      if (confirmingDelete) setConfirmingDelete(false);
      else requestClose();
    },
  });
  // A rule filing under a category no longer offered (archived, or savings)
  // keeps it, rather than the first one shown taking its place.
  const options = rule && !categories.some((c) => c.id === rule.category_id) ? [{ id: rule.category_id, name: 'Its category (not offered now)' }, ...categories] : categories;

  async function handleSave(e) {
    e.preventDefault();
    if (!pattern.trim() || !categoryId) {
      setError(pattern.trim() ? 'Choose a category.' : 'Enter a merchant pattern.');
      return;
    }
    setSaving(true);
    setError('');
    const payload = { pattern: pattern.trim(), match_type: matchType, category_id: categoryId, archived: !active };
    const { error: saveError } = rule
      ? await supabase.from('category_rules').update(payload).eq('id', rule.id)
      : await supabase.from('category_rules').insert({ ...payload, household_id: householdId });
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('category_rules').delete().eq('id', rule.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
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
        {rule && (
          <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
            {confirmingDelete ? 'Confirm delete?' : 'Delete'}
          </button>
        )}
        <div className="te-actions-right">
          {confirmingClose ? (
            <DiscardPrompt onDiscard={onClose} onKeepEditing={keepEditing} />
          ) : (
            <>
              <button type="button" className="om-btn" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" form={formId} className="om-btn ov-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : rule ? 'Save' : 'Add rule'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <Drawer kicker={rule ? 'Rule' : 'New rule'} title={rule ? `${MATCH[rule.match_type] ?? 'Contains'} “${rule.pattern}”` : 'Add a rule'} dirty={dirty} onClose={requestClose} onEscape={escapeKey} footer={footer}>
      <form id={formId} className="te-form" onSubmit={handleSave} noValidate>
        <div className="st-field">
          <div className="st-label">
            <span>Match</span>
            <InfoButton about="Match">Matching ignores letter case. A rule files new entries from the bot and the Inbox; Apply files past uncategorised transactions.</InfoButton>
          </div>
          <Segmented
            label="Match"
            options={[
              { id: 'contains', label: 'Contains' },
              { id: 'starts_with', label: 'Starts with' },
            ]}
            value={matchType}
            onChange={setMatchType}
          />
        </div>
        <div className="st-field">
          <label className="st-label" htmlFor={`${uid}-pattern`}>
            Merchant pattern
          </label>
          <input id={`${uid}-pattern`} className="ds-select st-input" type="text" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. greenleaf" />
        </div>
        <div className="st-field">
          <label className="st-label" htmlFor={`${uid}-category`}>
            Category
          </label>
          <select id={`${uid}-category`} className="ds-select st-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="st-switch">
          <div>
            <div className="st-switch-label">Active</div>
            <div className="ds-muted st-hint">An inactive rule stops filing</div>
          </div>
          <Switch label="Active" checked={active} onChange={setActive} />
        </div>
      </form>
    </Drawer>
  );
}
