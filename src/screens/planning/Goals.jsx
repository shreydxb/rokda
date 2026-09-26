import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney } from '../../lib/money';
import { lastContributionLabel, scopedGoalRows } from '../../lib/goals';
import GoalEditor from './GoalEditor';

const STATUS_CHIP = { funded: 'ov-chip-ok', track: 'ov-chip-ok', ahead: 'ov-chip-ok', behind: 'ov-chip-warn' };

export default function Goals({ household, members, me, accounts, holdings, data, loading }) {
  const { goals, goalContributions, goalAllocations, reload } = data;
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const [editing, setEditing] = useState(null);
  const now = useMemo(() => new Date(), []);

  // The same derivation the Plan summary uses (lib/goals), so the two tabs
  // agree on what is saved and which goals are behind.
  const rows = useMemo(
    () =>
      scopedGoalRows({
        goals,
        contributions: goalContributions,
        allocations: goalAllocations ?? [],
        accounts: accounts ?? [],
        holdings: holdings ?? [],
        scopeMemberId,
        now,
      }),
    [goals, goalContributions, goalAllocations, accounts, holdings, scopeMemberId, now]
  );

  const totalSaved = rows.reduce((s, r) => s + r.progress.saved, 0);
  const totalTarget = rows.reduce((s, r) => s + r.progress.target, 0);
  // Only goals with a date still ahead have a monthly figure to add up; one
  // already past its date needs its whole remainder now, which is a lump sum,
  // not a rate.
  const dated = rows.filter((r) => r.need && !r.need.due);
  const combinedNeed = dated.reduce((s, r) => s + r.need.perMonth, 0);
  const combinedPace = dated.reduce((s, r) => s + (r.progress.monthlyRate ?? 0), 0);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <div className="mn-filters">
        <span className="ov-muted" style={{ marginRight: 'auto' }}>
          {rows.length > 0 ? `${formatMoney(totalSaved)} of ${formatMoney(totalTarget)}` : ''}
        </span>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Goal
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No goals</div>
          <div className="ov-empty-body">Add a goal to start tracking progress toward it.</div>
        </div>
      ) : (
        <>
          <section className="gl-summary">
            <div className="bud-bar bud-bar-lg">
              <span className="bud-bar-spent" style={{ width: `${totalTarget > 0 ? Math.min(100, (totalSaved / totalTarget) * 100) : 0}%` }} />
            </div>
            <div className="gl-summary-row">
              <span>
                <b className="fig">{totalTarget > 0 ? Math.round(Math.min(1, totalSaved / totalTarget) * 100) : 0}%</b> of all goal targets saved
              </span>
              {dated.length > 0 && (
                <span>
                  {dated.length === 1 ? 'The dated goal needs' : `${dated.length} dated goals need`}{' '}
                  <b className="fig">{formatMoney(combinedNeed)}</b> a month · recent pace <b className="fig">{formatMoney(combinedPace)}</b>
                </span>
              )}
            </div>
          </section>
          <section style={{ marginTop: 22 }}>
            <div className="mn-list">
              {rows.map(({ goal, progress, need }) => (
                <button key={goal.id} type="button" className="mn-row" onClick={() => setEditing(goal)} style={{ alignItems: 'flex-start' }}>
                  <div className="mn-row-main">
                    <div>{goal.name}</div>
                    {goal.note && <div className="ov-muted" style={{ marginTop: 4 }}>{goal.note}</div>}
                    {goal.funding_source && <div className="ov-muted" style={{ marginTop: 4 }}>From {goal.funding_source}</div>}
                    <div style={{ marginTop: 10, maxWidth: 260 }}>
                      <div className="bud-bar">
                        <span className="bud-bar-spent" style={{ width: `${progress.pct * 100}%` }} />
                      </div>
                      <div className="ov-muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                        {Math.round(progress.pct * 100)}% funded · last paid in {lastContributionLabel(progress.lastContribution)}
                      </div>
                    </div>
                    {need && <GoalNeed need={need} behind={progress.status === 'behind'} />}
                  </div>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div className="fig mn-row-amt">{formatMoney(progress.saved)}</div>
                    <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4 }}>of {formatMoney(progress.target)}</div>
                    <div style={{ marginTop: 8 }}>
                      <span className={STATUS_CHIP[progress.status]}>{progress.statusLabel}</span>
                    </div>
                    <div className="ov-muted" style={{ fontSize: 12, marginTop: 8, maxWidth: 160, lineHeight: 1.5 }}>
                      {progress.eta}
                      <div style={{ fontSize: 11.5, marginTop: 4 }}>{progress.etaWhy}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
          <div className="ov-muted" style={{ marginTop: 14, fontSize: 11.5, lineHeight: 1.65, maxWidth: '80ch' }}>
            Target dates project the recent contribution rate forward. They come from what has actually been transferred, not from a
            commitment, and they move whenever a contribution is missed. The monthly figure works the other way: what is left, spread
            over the whole months to the target date, with no investment growth assumed.
          </div>
        </>
      )}

      {editing && (
        <GoalEditor
          goal={editing === 'new' ? null : editing.goal ?? editing}
          contributions={editing === 'new' ? [] : goalContributions.filter((c) => c.goal_id === (editing.goal ?? editing).id)}
          allocations={editing === 'new' ? [] : (goalAllocations ?? []).filter((a) => a.goal_id === (editing.goal ?? editing).id)}
          accounts={accounts ?? []}
          holdings={holdings ?? []}
          householdId={household?.id}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// The target date's side of the question: what it needs each month from now.
// Coloured only when the status chip already says Behind, so the two never
// contradict each other near the edge of the on-track tolerance.
function GoalNeed({ need, behind }) {
  if (need.due) {
    return (
      <div className="gl-need" data-behind={need.remaining > 0}>
        <b className="fig">{formatMoney(need.remaining)}</b> still needed · the target date of {need.byLabel} has arrived
      </div>
    );
  }
  return (
    <div className="gl-need" data-behind={behind}>
      Needs <b className="fig">{formatMoney(need.perMonth)}</b> a month to reach it by {need.byLabel}
      <span className="ov-muted">
        {' '}
        · {need.monthsLeft} month{need.monthsLeft === 1 ? '' : 's'} left
      </span>
    </div>
  );
}
