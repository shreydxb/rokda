import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney } from '../../lib/money';
import { goalProgress, lastContributionLabel } from '../../lib/goals';
import GoalEditor from './GoalEditor';

const STATUS_CHIP = { funded: 'ov-chip-ok', track: 'ov-chip-ok', ahead: 'ov-chip-ok', behind: 'ov-chip-warn' };

export default function Goals({ household, members, me, data, loading }) {
  const { goals, goalContributions, reload } = data;
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const [editing, setEditing] = useState(null);
  const now = useMemo(() => new Date(), []);

  // A shared goal counts half toward each individual scope, same as every
  // other joint figure in the app, so "Me" plus "Aparna" reconciles to "Both".
  const rows = useMemo(
    () =>
      goals
        .filter((g) => scopeMemberId === null || g.is_shared || g.owner_member_id === scopeMemberId)
        .map((g) => {
          const factor = scopeMemberId === null || !g.is_shared ? 1 : 0.5;
          const scopedGoal = { ...g, target_amount: Number(g.target_amount) * factor };
          const contributions = goalContributions
            .filter((c) => c.goal_id === g.id)
            .map((c) => ({ ...c, amount: Number(c.amount) * factor }));
          return { goal: g, contributions, progress: goalProgress(scopedGoal, contributions, now) };
        }),
    [goals, goalContributions, scopeMemberId, now]
  );

  const totalSaved = rows.reduce((s, r) => s + r.progress.saved, 0);
  const totalTarget = rows.reduce((s, r) => s + r.progress.target, 0);

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
          <section style={{ marginTop: 22 }}>
            <div className="mn-list">
              {rows.map(({ goal, progress }) => (
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
            commitment, and they move whenever a contribution is missed.
          </div>
        </>
      )}

      {editing && (
        <GoalEditor
          goal={editing === 'new' ? null : editing.goal ?? editing}
          contributions={editing === 'new' ? [] : goalContributions.filter((c) => c.goal_id === (editing.goal ?? editing).id)}
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
