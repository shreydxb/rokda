import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fileableCategories } from '../../lib/fileableCategories';
import { TODO_GROUPS } from '../../lib/todo';
import { Card, EmptyState } from '../../design-system/kit';

const SHOWN = 6;

// To do, the one list of everything waiting on someone (the revamp, phase
// 3; review S-overview-1, N13), from lib/todo.js. Each row is a name, a short
// status and one button named for the job. A record to review keeps its
// quick actions here: categorise it, or mark it reviewed.
export default function OverviewTodo({ rows, money, categories, categorise, markReviewed, onMarkPaid }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <Card title="To do" className="ov-todo" flush right={rows.length ? `${rows.length} open` : null}>
      {rows.length === 0 ? (
        <EmptyState title="All clear" body="Nothing needs a decision." />
      ) : (
        <div id="ov-todo-list">
          {TODO_GROUPS.map((group) => {
            const inGroup = shown.filter((r) => r.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group} className="ov-todo-group">
                <h3 className="ov-todo-head">{group}</h3>
                <ul className="ov-todo-rows">
                  {inGroup.map((row) => (
                    <TodoRow key={row.id} row={row} money={money} categories={categories} categorise={categorise} markReviewed={markReviewed} onMarkPaid={onMarkPaid} />
                  ))}
                </ul>
              </div>
            );
          })}
          {rows.length > SHOWN && (
            <button type="button" className="ov-todo-more" aria-expanded={all} aria-controls="ov-todo-list" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function TodoRow({ row, money, categories, categorise, markReviewed, onMarkPaid }) {
  const { action } = row;
  const tx = action.kind === 'review' ? action.tx : null;
  const status = tx ? `${row.status} · ${new Date(tx.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${money.fmtBalance(tx.amount)}` : row.status;
  return (
    <li className="ov-todo-row">
      <span className={`ov-todo-dot ov-todo-${row.tone}`} aria-hidden="true" />
      <span className="ov-todo-text">
        <span className="ov-todo-title">{row.title}</span>
        <span className="ov-todo-status"> · {status}</span>
      </span>
      {tx ? (
        <span className="ov-todo-actions">
          {/* A split record's categories are its lines; it is categorised in its editor. */}
          {!tx.is_split && (
            <select className="ds-select ov-attn-select" aria-label={`Category for ${row.title}`} defaultValue="" onChange={(e) => e.target.value && categorise(tx, e.target.value)}>
              <option value="" disabled>
                Categorise…
              </option>
              {fileableCategories(categories).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="ds-btn ds-btn-sm" onClick={() => markReviewed(tx)}>
            Mark reviewed
          </button>
        </span>
      ) : action.kind === 'mark-paid' ? (
        <button type="button" className="ds-btn ds-btn-sm" onClick={() => onMarkPaid(action.recurringId, action.dueOn)}>
          {action.label}
        </button>
      ) : (
        <Link className="ds-btn ds-btn-sm" to={action.href}>
          {action.label}
        </Link>
      )}
    </li>
  );
}
