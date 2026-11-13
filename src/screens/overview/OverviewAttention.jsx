import { fileableCategories } from '../../lib/fileableCategories';
import { attentionHref, ATTENTION_PREVIEW_COUNT as ATTENTION_FOLD } from '../../lib/attention';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Needs attention: records to review or categorise, with quick actions.
export default function OverviewAttention({ attention, attentionShown, money, categorise, categories, markReviewed, navigate, now, attentionHidden, attentionExpanded, setAttentionExpanded }) {
  return (
    <div className="ov-attn-col">
      <div className="ov-section-head">
        <div className="ov-kicker">Needs attention</div>
        <div className="ov-muted">{attention.length ? `${attention.length} open` : 'All clear'}</div>
      </div>
      {attention.length === 0 ? (
        <div className="ov-allclear">
          <span className="ov-dot-pos" />
          <span>All clear — nothing needs a decision.</span>
        </div>
      ) : (
        <div className="ov-attn-list" id="ov-attn-list">
          {attentionShown.map((item) =>
            item.kind === 'review' ? (
              <div key={item.id} className="ov-attn-row">
                <div className="ov-attn-main">
                  <span>{item.tx.merchant ?? 'Transaction'}</span>
                  <span className="ov-muted">
                    {new Date(item.tx.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ·{' '}
                    {money.fmtBalance(item.tx.amount)}
                  </span>
                </div>
                {/* A split record's categories are its lines; it is categorised in its editor. */}
                {!item.tx.is_split && (
                  <select
                    className="ov-attn-select"
                    defaultValue=""
                    onChange={(e) => e.target.value && categorise(item.tx, e.target.value)}
                  >
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
                <button type="button" className="om-btn ov-attn-btn" onClick={() => markReviewed(item.tx)}>
                  Mark reviewed
                </button>
              </div>
            ) : (
              <div key={item.id} className="ov-attn-row">
                <div className="ov-attn-main">
                  <span>{item.title}</span>
                  <span className={item.severity === 'urgent' ? 'ov-warn' : 'ov-muted'}>{item.detail}</span>
                </div>
                <button
                  type="button"
                  className="om-btn ov-attn-btn"
                  onClick={() => navigate(attentionHref(item, now))}
                >
                  Open
                </button>
              </div>
            )
          )}
          {(attentionHidden > 0 || attentionExpanded) && attention.length > ATTENTION_FOLD && (
            <button
              type="button"
              className="ov-link ov-attn-more"
              aria-expanded={attentionExpanded}
              aria-controls="ov-attn-list"
              onClick={() => setAttentionExpanded((v) => !v)}
            >
              {attentionExpanded ? 'Show fewer' : `Show all ${attention.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
