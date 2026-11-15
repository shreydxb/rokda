import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CHART_TITLES, isRunningBucket } from '../overviewMath';
import { Card } from '../../design-system/kit';
import { PairedColumns } from '../../design-system/charts';
import { ChartLegend } from '../../charts/Charts';

// Income and spending over the last six months, quarters or years (the
// revamp, phase 3; review S-overview-5): income and what was spent as
// columns, what was saved as a line, with an axis. A month with no records
// says so instead of drawing zeros. Hover, touch or the arrow keys pick a
// column; the readout under the chart says its figures, so none is only on
// hover.
export default function OverviewFlow({ period, columns, money, now }) {
  const [pick, setPick] = useState(null);
  const shown = columns[pick ?? columns.length - 1];
  const running = shown ? isRunningBucket(shown, now) : false;
  return (
    <Card
      title={CHART_TITLES[period]}
      className="ov-flow"
      right={
        <Link className="ov-link" to="/money">
          Activity →
        </Link>
      }
    >
      <PairedColumns
        ariaLabel={CHART_TITLES[period]}
        formatTick={(v) => money.fmtCompact(v)}
        activeIndex={pick}
        onActiveChange={setPick}
        groups={columns.map((c) => ({ key: c.key, label: `${c.label}${isRunningBucket(c, now) ? ' · so far' : ''}`, a: c.income, b: c.spend, line: c.saved, empty: !c.hasData, current: isRunningBucket(c, now) }))}
      />
      <div className="ov-readout ov-chart-readout" aria-live="polite">
        {shown && (shown.hasData ? `${shown.label}${running ? ' so far' : ''} · Income ${money.fmt(shown.income)} · Spent ${money.fmt(shown.spend)} · Saved ${money.fmtSigned(shown.saved)}` : `${shown.label} · no transactions`)}
      </div>
      <ChartLegend
        items={[
          { label: 'Income', color: 'var(--series-3)' },
          { label: 'Spent', color: 'var(--accent)' },
          { label: 'Saved', color: 'var(--pos)', kind: 'line' },
        ]}
      />
    </Card>
  );
}
