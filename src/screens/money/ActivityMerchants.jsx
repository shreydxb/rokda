import { topMerchants, merchantSummary } from '../../lib/insights';
import { formatMoney } from '../../lib/money';
import { BarList, Card, EmptyState, InfoButton, KpiStrip } from '../../design-system/kit';

// Activity -> Merchants, from Insights (the revamp, phase 4; design/prototype
// actMerchants): the month's spending by merchant, the selected person's
// share and net of refunds as Insights worked it out (lib/insights.js), with
// how many were paid and how much went to the top three. A merchant opens
// its records in the list.
export default function ActivityMerchants({ transactions, scopeMemberId, month, monthLabel, now, onSelect }) {
  const list = topMerchants(transactions, scopeMemberId, { year: month.getFullYear(), month: month.getMonth() + 1, now, limit: Infinity });
  const summary = merchantSummary(list);
  return (
    <div className="mn-merchants">
      <Card
        title={`Merchants · ${monthLabel}`}
        info={<InfoButton about="merchants">Spending by merchant this month, net of refunds, posted records only. The number beside each is how many payments. Choose one to see its records.</InfoButton>}
      >
        {list.length === 0 ? (
          <EmptyState title="No spending this month" />
        ) : (
          <BarList
            items={list.map((m) => ({
              id: m.name,
              label: (
                <>
                  {m.name}
                  <span className="ds-muted"> · {m.count}</span>
                </>
              ),
              value: m.total,
              display: formatMoney(m.total),
              // No name to search Activity by.
              selectable: !m.unnamed,
            }))}
            onSelect={(item) => onSelect(item.id)}
          />
        )}
      </Card>
      <Card className="mn-merchant-figures" flush>
        <div role="region" aria-label="Merchants paid">
        <KpiStrip
          items={[
            { label: 'Merchants paid', value: String(summary.count) },
            {
              label: 'Top three',
              value: summary.topThreeShare == null ? '—' : `${Math.round(summary.topThreeShare * 100)}%`,
              sub: `of ${formatMoney(summary.total)} spent`,
            },
          ]}
        />
        </div>
      </Card>
    </div>
  );
}
