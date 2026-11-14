import { useState } from 'react';
import Freshness from '../screens/Freshness';
import { Card, KpiStrip, Chip, WarningRow, InfoButton, MonthStepper, Segmented, Switch, Fold, EmptyState, Banner, Drawer, ProgressBar, StackBar, BarList } from './kit';

// Every piece of the shared kit on one page, with made-up figures, to look at
// in both themes. Built only for development or a build with VITE_KIT=1, never
// for production (App.jsx).
export default function KitGallery() {
  const [period, setPeriod] = useState('month');
  const [on, setOn] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState('details');
  return (
    <div className="kit-gallery" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1160 }}>
      <Freshness title="Design kit" loadedAt={new Date()} onRefresh={() => {}} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented label="Period" options={[{ id: 'month', label: 'Month' }, { id: 'quarter', label: 'Quarter' }, { id: 'year', label: 'Year' }]} value={period} onChange={setPeriod} />
        <MonthStepper label="Nov 2026" onPrev={() => {}} onNext={() => {}} nextDisabled />
        <button type="button" className="ds-btn ds-btn-primary">+ Transaction</button>
        <button type="button" className="ds-btn" onClick={() => setDrawer(true)}>Open a drawer</button>
        <Switch label="Missed bills" checked={on} onChange={setOn} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 16 }}>
        <Card title="Net worth" right={<a href="#">Net worth →</a>}>
          <div className="ds-hero"><span className="ds-code">AED</span>300,000 <Chip tone="warn">Provisional</Chip></div>
          <div style={{ marginTop: 6, fontSize: 12.5 }}><span className="ds-pos">▲ 10,000</span> <span style={{ color: 'var(--ink3)' }}>this month</span></div>
        </Card>
        <Card title="This month" right={<a href="#">Budget →</a>} flush>
          <KpiStrip items={[{ label: 'Income', value: '20,000', sub: '+10,000 expected 28 Nov' }, { label: 'Spent', value: '15,000', info: <InfoButton about="Spent">Purchases less refunds, in AED.</InfoButton> }, { label: 'Saved', value: '5,000', sub: '25% of income' }]} />
          <div style={{ padding: '4px 18px 12px' }}>
            <ProgressBar label="Budget" value={12000} max={16000} tick={0.47} />
          </div>
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <Card title="To do" right="4 open" flush>
          <div style={{ padding: '0 18px' }}>
            <WarningRow action={{ label: 'Confirm balance', onClick: () => {} }}>Cash wallet · balance not confirmed</WarningRow>
            <WarningRow tone="neg" action={{ label: 'Mark paid', onClick: () => {} }}>Gym · late, was due 10 Nov</WarningRow>
          </div>
          <table className="ds-table">
            <thead>
              <tr><th>Name</th><th>Every</th><th>Status</th><th className="ds-num">Amount</th></tr>
            </thead>
            <tbody>
              <tr data-open><td>Rent</td><td>Month</td><td><Chip>Upcoming</Chip></td><td className="ds-num">−5,000</td></tr>
              <tr data-open><td>Streaming</td><td>Month</td><td><Chip tone="neg">Late</Chip></td><td className="ds-num">−50</td></tr>
              <tr data-open><td>Insurance</td><td>Year</td><td><Chip tone="pos">Paid</Chip></td><td className="ds-num">−2,000</td></tr>
            </tbody>
          </table>
          <div style={{ padding: '0 18px' }}>
            <Fold label="Ended" count={2}><p>Two bills that ended.</p></Fold>
          </div>
        </Card>
        <Card title="Where it went" info={<InfoButton about="Where it went">Before refunds; the tick is the usual month.</InfoButton>}>
          <BarList items={[{ id: 'r', label: 'Rent', value: 5000, display: '5,000', usual: 5000 }, { id: 'g', label: 'Groceries', value: 1500, display: '1,500', usual: 1200 }, { id: 'd', label: 'Dining out', value: 800, display: '800', usual: 900 }]} />
          <div style={{ marginTop: 18 }}>
            <StackBar label="Assets" parts={[{ label: 'Cash', value: 60 }, { label: 'Shares', value: 25 }, { label: 'Gold', value: 10 }, { label: 'Deposit', value: 5 }]} />
          </div>
        </Card>
      </div>
      <Banner onRetry={() => {}}>Couldn&apos;t load accounts. Net worth not shown.</Banner>
      <Card title="Goals" action>
        <EmptyState title="No goals yet" action={{ label: '+ Goal', onClick: () => {} }} />
      </Card>
      {drawer && (
        <Drawer kicker="Transaction" title="Coffee shop" dirty tabs={[{ id: 'details', label: 'Details' }, { id: 'more', label: 'More' }]} tab={tab} onTab={setTab} onClose={() => setDrawer(false)} footer={<><button type="button" className="ds-btn" style={{ color: 'var(--neg)', borderColor: 'transparent' }}>Delete</button><span style={{ flex: 1 }} /><button type="button" className="ds-btn" onClick={() => setDrawer(false)}>Cancel</button><button type="button" className="ds-btn ds-btn-primary">Save</button></>}>
          <p style={{ margin: 0 }}>Fields go here.</p>
        </Drawer>
      )}
    </div>
  );
}
