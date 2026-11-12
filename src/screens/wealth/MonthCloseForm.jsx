import { incompleteNote } from '../overviewMath';
import '../money/TransactionEditor.css';

// What a close would write, shown for review before anything is written, and
// its Confirm (lib/useMonthClose.js). Net worth and the monthly review both
// show it. `note` is the caller's own line above the figures: the review
// names the checks still open.
export default function MonthCloseForm({ close, note = null }) {
  const { pending, monthLabel, draft, setDraft, cancel, confirm, closing, error, valid, assetsError, liabilitiesError, gaps, gapNames } = close;
  return (
    <>
      {pending && draft && (
        <div className="ov-card" style={{ marginBottom: 16, padding: 14 }}>
          <div className="ov-muted" style={{ marginBottom: 10 }}>
            Confirm what {monthLabel} actually closed at.{' '}
            {incompleteNote(gaps)
              ? 'Stored values are always AED, regardless of the display currency above.'
              : "These start from today's live totals — edit them if they don't reflect that month's actual position. Stored values are always AED, regardless of the display currency above."}
          </div>
          {note && (
            <div className="ov-muted" style={{ marginBottom: 10 }}>
              {note}
            </div>
          )}
          {/* A month-end close is written down and compared against for
              years. Starting it from a total that silently omits an
              unconverted account bakes that omission into the history
              (QA #4), so the gap is named here rather than only on the
              hero above. */}
          {incompleteNote(gaps) && (
            <div className="ov-warn" style={{ marginBottom: 10, fontSize: 12 }} data-testid="close-gaps">
              Today&rsquo;s totals {incompleteNote(gaps, { capitalised: false })} so they are not filled in. Convert or value{' '}
              {gapNames} first, or enter what the month actually closed at.
            </div>
          )}
          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Assets (AED)</span>
              <input aria-label="Assets (AED)"
                className="te-fieldvalue"
                type="number"
                step="0.01"
                value={draft.assets}
                aria-invalid={!!assetsError}
                onChange={(e) => setDraft((d) => ({ ...d, assets: e.target.value }))}
              />
              {assetsError && (
                <span className="ov-warn" style={{ fontSize: 11.5 }}>
                  {assetsError}
                </span>
              )}
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Liabilities (AED)</span>
              <input aria-label="Liabilities (AED)"
                className="te-fieldvalue"
                type="number"
                step="0.01"
                value={draft.liabilities}
                aria-invalid={!!liabilitiesError}
                onChange={(e) => setDraft((d) => ({ ...d, liabilities: e.target.value }))}
              />
              {liabilitiesError && (
                <span className="ov-warn" style={{ fontSize: 11.5 }}>
                  {liabilitiesError}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="om-btn" disabled={closing} onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="om-btn ov-btn-primary" disabled={closing || !valid} onClick={confirm}>
              {closing ? 'Closing…' : 'Confirm & close'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="ov-error" role="alert" style={{ marginBottom: 12 }}>
          Couldn’t close the month: {error}
        </div>
      )}
    </>
  );
}
