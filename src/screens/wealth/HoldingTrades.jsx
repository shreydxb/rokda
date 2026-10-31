import { tradeRow, tradesOfHolding } from '../../lib/trades';
import './HoldingTrades.css';

// A traded holding's trades, newest first, in its editor (SHR-371). This is
// where an older trade is fixed or deleted; Telegram is where most are
// recorded. Every action waits while the holding itself has unsaved changes:
// a trade reloads the holding, which would drop them (disabledReason).
export default function HoldingTrades({ holding, trades, disabledReason }) {
  const list = tradesOfHolding(trades, holding.id);
  const disabled = !!disabledReason;
  return (
    <section className="ht-section" aria-labelledby="ht-title">
      <div className="ht-head">
        <span className="te-fieldlabel" id="ht-title">
          Trades
        </span>
        <button type="button" className="om-btn" disabled={disabled}>
          Record a trade
        </button>
      </div>
      {disabledReason && (
        <div className="ov-muted" style={{ fontSize: 11.5 }}>
          {disabledReason}
        </div>
      )}
      <ul className="ht-list" aria-label="Trades">
        {list.map((t) => {
          const row = tradeRow(t, holding.currency);
          return (
            <li key={t.id} className="ht-row">
              <div className="mn-row-main">
                <div>{row.title}</div>
                <div className="ov-muted">{row.detail}</div>
              </div>
              <div className="ht-actions">
                <button type="button" className="om-btn" aria-label={`Fix ${row.title}`} disabled={disabled}>
                  Fix
                </button>
                {/* The opening entry is where the history starts: it can be
                    corrected, but removing it is undoing the fresh start,
                    which the app does not offer. */}
                {t.kind !== 'opening' && (
                  <button type="button" className="om-btn" aria-label={`Delete ${row.title}`} disabled={disabled}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
