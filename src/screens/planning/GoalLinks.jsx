import { accountCanBackGoal } from '../../lib/goals';
import { linkCountsAsNothing } from '../../lib/goalForm';

// Part of the goal editor (GoalEditor.jsx), split out with the round 2
// cleanup (SHR-383).
//
// The accounts and holdings a share of which counts as saved towards a goal:
// a form to link one, and each link with its share, which can be changed, and
// the editor's Remove controls. A link to what can no longer back a goal (a
// loan, a card, a closed account) says it counts for nothing.
export default function GoalLinks({
  labelledBy,
  heading,
  messages,
  ids,
  linkableAccounts,
  linkableHoldings,
  allocSource,
  onSource,
  allocSharePct,
  onShare,
  onAdd,
  saving,
  linked,
  allocationLabel,
  findAccount,
  shareEdits,
  onShareEdit,
  onShareChange,
  shareRef,
  removeControls,
}) {
  return (
    <section className="te-section" aria-labelledby={labelledBy}>
      {heading}
      <div className="ov-muted" style={{ fontSize: 11.5, marginBottom: 12, lineHeight: 1.5 }}>
        Earmark a share of a real account or holding toward this goal: its current value (interest or growth included) is
        what counts as saved, in place of logged contributions. One account/holding can be split across several goals as long as its shares
        never add up past 100%. Loans and cards can&rsquo;t be linked: what they hold is owed.
      </div>
      {linkableAccounts.length + linkableHoldings.length > 0 && (
        <form onSubmit={onAdd} noValidate>
          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <label className="te-fieldlabel" htmlFor={ids.source}>
                Account / holding
              </label>
              <select id={ids.source} className="te-fieldvalue" value={allocSource} onChange={(e) => onSource(e.target.value)}>
                {linkableAccounts.length > 0 && (
                  <optgroup label="Accounts">
                    {linkableAccounts.map((a) => (
                      <option key={a.id} value={`account:${a.id}`}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {linkableHoldings.length > 0 && (
                  <optgroup label="Holdings">
                    {linkableHoldings.map((h) => (
                      <option key={h.id} value={`holding:${h.id}`}>
                        {h.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={ids.share}>
                Share %
              </label>
              <input
                id={ids.share}
                className="te-fieldvalue"
                type="number"
                step="any"
                value={allocSharePct}
                onChange={(e) => onShare(e.target.value)}
              />
            </div>
          </div>
          <div className="te-subactions">
            <button type="submit" className="om-btn" aria-disabled={saving}>
              Link
            </button>
          </div>
        </form>
      )}
      {messages}

      {linked.length === 0 ? (
        <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
          Nothing linked yet — this goal's progress is only from logged contributions.
        </div>
      ) : (
        <div className="mn-list">
          {linked.map((a) => {
            const label = allocationLabel(a);
            const account = a.account_id ? findAccount(a.account_id) : null;
            const nothing = a.account_id && !accountCanBackGoal(account) ? linkCountsAsNothing(account) : null;
            const stored = String(Number(a.share_pct));
            const shown = shareEdits[a.id] ?? stored;
            return (
              <form key={a.id} className="mn-row te-linkrow" style={{ cursor: 'default' }} onSubmit={(e) => onShareChange(e, a)} noValidate>
                <div className="mn-row-main">
                  {label}
                  {nothing && <div className="ov-muted te-rownote">Counts as nothing: {nothing}.</div>}
                </div>
                <div className="te-rowcontrols">
                  {!nothing && (
                    <>
                      <input
                        ref={shareRef(a.id)}
                        className="te-fieldvalue te-shareinput"
                        type="number"
                        step="any"
                        value={shown}
                        onChange={(e) => onShareEdit(a.id, e.target.value)}
                        aria-label={`Share of ${label}, percent`}
                      />
                      <span className="fig">%</span>
                      {shown !== stored && (
                        <button type="submit" className="om-btn" aria-disabled={saving}>
                          Update
                        </button>
                      )}
                    </>
                  )}
                  {removeControls('allocation', a.id, `the link to ${label}`)}
                </div>
              </form>
            );
          })}
        </div>
      )}
    </section>
  );
}
