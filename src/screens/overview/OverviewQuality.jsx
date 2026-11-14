import QualityItem from './QualityItem';
import { formatPct } from '../../lib/money';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Data quality: what the figures above rest on, and what is missing.
export default function OverviewQuality({ qualityIssues, qualityOk, quality, accounts }) {
  return (
    <section className="ov-quality-section">
      {/* One line, with the detail a tap away: it took a screen's
          height for what is usually "all fine". */}
      <details className="ov-quality-details">
        <summary>
          <span className="ov-kicker">Data quality</span>{' '}
          <span className={qualityIssues > 0 ? 'ov-warn' : 'ov-muted'}>
            {qualityIssues === 0 ? 'All four checks fine' : `${qualityIssues} of 4 checks need a look`}
          </span>
        </summary>
      <div className="ov-quality-grid">
        <QualityItem
          name="Transactions"
          ok={qualityOk.transactions}
          label={quality.daysSinceLastTx === null ? 'None yet' : quality.daysSinceLastTx === 0 ? 'Today' : `${quality.daysSinceLastTx}d ago`}
          note={
            (quality.lastTxDate
              ? `Most recent posted record ${quality.lastTxDate.toLocaleDateString('en-GB')}.`
              : 'Nothing posted yet.') +
            (quality.plannedTx > 0
              ? ` ${quality.plannedTx} future-dated record(s) are planned, not counted in spend.`
              : '')
          }
        />
        <QualityItem
          name="Categorisation"
          ok={qualityOk.categorisation}
          label={quality.categorisedPct !== null ? formatPct(quality.categorisedPct) : '—'}
          note={`${quality.totalTx} record(s) total, ${quality.openReview} flagged for review.`}
        />
        <QualityItem
          name="Review queue"
          ok={qualityOk.review}
          label={quality.openReview === 0 ? 'Clear' : `${quality.openReview} open`}
          note="Flagged on add or import; resolved above."
        />
        <QualityItem
          name="Accounts"
          ok={qualityOk.accounts}
          label={accounts.length ? `${accounts.length} tracked` : 'None yet'}
          note={quality.lastAccountUpdate ? `Balances entered manually, last touched ${quality.lastAccountUpdate.toLocaleDateString('en-GB')}.` : 'Add an account in Wealth.'}
        />
      </div>
      </details>
    </section>
  );
}
