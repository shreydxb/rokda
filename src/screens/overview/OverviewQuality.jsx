import QualityItem from './QualityItem';
import { formatPct } from '../../lib/money';
import { Card } from '../../design-system/kit';

// Data quality, as one chip beside the date (the revamp, phase 3; review
// S-overview-9): "Data: 2 to check", opening the same four checks in place.
export function QualityChip({ issues, open, onToggle }) {
  return (
    <button type="button" className={`ds-chip ${issues > 0 ? 'ds-chip-warn' : 'ds-chip-pos'} ov-quality-chip`} aria-expanded={open} aria-controls={open ? 'ov-quality-panel' : undefined} onClick={onToggle}>
      {issues > 0 ? `Data: ${issues} to check` : 'Data: all clear'}
    </button>
  );
}

export function QualityPanel({ qualityOk, quality, accounts }) {
  return (
    <div id="ov-quality-panel">
      <Card title="Data quality" className="ov-quality">
        <div className="ov-quality-grid">
          <QualityItem
            name="Transactions"
            ok={qualityOk.transactions}
            label={quality.daysSinceLastTx === null ? 'None yet' : quality.daysSinceLastTx === 0 ? 'Today' : `${quality.daysSinceLastTx}d ago`}
            note={
              (quality.lastTxDate ? `Most recent posted record ${quality.lastTxDate.toLocaleDateString('en-GB')}.` : 'Nothing posted yet.') +
              (quality.plannedTx > 0 ? ` ${quality.plannedTx} future-dated record(s) are planned, not counted in spend.` : '')
            }
          />
          <QualityItem
            name="Categorisation"
            ok={qualityOk.categorisation}
            label={quality.categorisedPct !== null ? formatPct(quality.categorisedPct) : '—'}
            note={`${quality.totalTx} record(s) total, ${quality.openReview} flagged for review.`}
          />
          <QualityItem name="Review queue" ok={qualityOk.review} label={quality.openReview === 0 ? 'Clear' : `${quality.openReview} open`} note="Flagged on add or import; resolved in To do." />
          <QualityItem
            name="Accounts"
            ok={qualityOk.accounts}
            label={accounts.length ? `${accounts.length} tracked` : 'None yet'}
            note={quality.lastAccountUpdate ? `Balances entered manually, last touched ${quality.lastAccountUpdate.toLocaleDateString('en-GB')}.` : 'Add an account in Wealth.'}
          />
        </div>
      </Card>
    </div>
  );
}
