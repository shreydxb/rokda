import { ruleLabel } from '../../lib/rules';

// Where Settings opens one rule's editor (CategoriesRules reads `rule=`). A new
// tab, so the record being corrected stays open as it was typed.
const settingsRuleHref = (ruleId) => `${import.meta.env.BASE_URL}settings?tab=categories&rule=${encodeURIComponent(ruleId)}`;

// The rule a corrected record would add, laid out for review before saving:
// the pattern (the whole merchant name to begin with), how it matches, the
// category it files under, and what an active rule already says about this
// merchant (lib/rules.js, rememberMerchantCheck).
export default function RememberMerchant({ merchant, categoryName, categories, pattern, matchType, check, disabled = false, onPattern, onMatchType }) {
  const nameOf = (id) => categories.find((c) => c.id === id)?.name ?? 'a category that no longer exists';
  const verb = matchType === 'starts_with' ? 'starts with' : 'contains';
  const shown = pattern.trim() || '…';
  return (
    <div className="te-rule" role="group" aria-label="Merchant rule">
      <div className="te-fieldgrid">
        <label className="te-fieldcell te-span2">
          <span className="te-fieldlabel">Merchant pattern</span>
          <input
            className="te-fieldvalue"
            type="text"
            value={pattern}
            disabled={disabled}
            onChange={(e) => onPattern(e.target.value)}
            aria-invalid={check?.status === 'invalid'}
          />
        </label>
      </div>
      <div className="te-rule-row">
        <div>
          <span className="te-fieldlabel">Match type</span>
          <div className="te-chips">
            {[
              ['contains', 'Contains'],
              ['starts_with', 'Starts with'],
            ].map(([k, label]) => (
              <button key={k} type="button" className="om-seg" data-active={matchType === k} aria-pressed={matchType === k} disabled={disabled} onClick={() => onMatchType(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="te-fieldlabel">Category</span>
          <div className="te-rule-category">{categoryName}</div>
        </div>
      </div>
      {/* What the rule would do, only while it would be added: with a rule
          already deciding this merchant, nothing new goes anywhere. */}
      {(check?.status === 'new' || check?.status === 'invalid') && (
      <p className="te-rule-note">
        Future entries whose merchant {verb} “{shown}” go to {categoryName}, whatever the letter case. The rule is the household’s: it covers
        both of you, the bot and the Inbox. Records already saved stay as they are; Settings can apply it to uncategorised ones.
      </p>
      )}
      {check?.status === 'invalid' && (
        <p className="te-rule-status ov-warn" role="alert">
          {check.reason}
        </p>
      )}
      {check?.status === 'duplicate' && (
        <p className="te-rule-status">
          Already remembered: {ruleLabel(check.rule)} files “{merchant}” under {nameOf(check.rule.category_id)}. No new rule is added.
        </p>
      )}
      {check?.status === 'conflict' && (
        <div className="te-rule-status te-rule-conflict" role="status">
          <div>
            {ruleLabel(check.rule)} already files “{merchant}” under {nameOf(check.rule.category_id)}. The earliest matching rule decides, so a new one
            wouldn’t change where it goes. Saving keeps this correction without adding a rule.
          </div>
          <a href={settingsRuleHref(check.rule.id)} target="_blank" rel="noreferrer">
            Open that rule in Settings
          </a>
        </div>
      )}
    </div>
  );
}
