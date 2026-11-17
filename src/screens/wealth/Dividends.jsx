import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { HOUSEHOLD_TIME_ZONE, householdToday } from '../../lib/day';
import { formatMoney, formatPct } from '../../lib/money';
import { SECTOR_LABELS } from '../../lib/holdings';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { dividendRefusalMessage, formatPerShare, monthLabel, shortDate } from '../../lib/dividends';
import { buildDividendInput, comingUp, dividendHeadline, dividendsByMarket, dividendsByMonth, feedStamp, needsYou, spendingEquivalent } from '../../lib/dividendSummary';
import { MonthBars } from '../../design-system/charts';
import { Card, Chip, EmptyState, Fold, InfoButton, KpiStrip, Popover, Segmented, WarningRow } from '../../design-system/kit';
import { Tools } from '../PageTools';
import DividendForm from './DividendForm';
import TaxYears from './TaxYears';
import './HoldingTrades.css';
import './Dividends.css';

// Wealth -> Dividends as the prototype lays it out (the revamp, phase 5c;
// design/prototype needsCard, divKpis, byMonthCard, comingCard, byHoldingCard,
// taxView): dividends as passive income, in the screen's scope, with the tax
// years a view away. Earned, Expected and Received are kept apart; what is to
// come is a projection and says so. The figures come from
// src/lib/dividendSummary.js; a holding opens in its drawer, on its dividends,
// through the address (HoldingDrawer.jsx).

// What the tab reads; one that never loaded is said, never shown as none.
const SOURCES = ['holdings', 'holdingDividends', 'holdingTrades', 'dividendEvents', 'dividendSplits', 'dividendSpecialParts', 'dividendFeedStatus', 'accounts'];
const MARKET_NAMES = { IN: 'India', US: 'US' };
const MARKET_ADJECTIVES = { IN: 'Indian', US: 'US' };
const A_MARKET_HOLDING = { IN: 'an Indian holding', US: 'a US holding' };
const VIEWS = [
  { id: 'income', label: 'Income' },
  { id: 'tax', label: 'Tax years' },
];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// What the figures leave out (they were "How fresh this is").
const CAVEATS = [
  "Dividends from before a holding's opening entry aren't counted: the units held then are unknown.",
  "Expected figures are a projection at today's units and exchange rates.",
  "Dividends earned but not yet received aren't in net worth.",
  'The plan already counts dividends in its return, so this tab is cash flow, not a second return.',
];

const native = (amount, currency) => `${currency} ${formatMoney(amount, { decimals: 2 })}`;
const aed = (money, value) => `${money.code} ${money.fmt(value)}`;
const signedPct = (f) => `${f >= 0 ? '+' : '−'}${formatPct(Math.abs(f), { decimals: Math.abs(f) < 0.1 ? 1 : 0 })}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A check's day and time in the household's time zone, months as the app
// writes them ("Sep").
const checkedAt = (ts) =>
  `${shortDate(householdToday(new Date(ts)))}, ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: HOUSEHOLD_TIME_ZONE }).format(new Date(ts))}`;

export default function Dividends({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const today = householdToday();
  const input = useMemo(() => buildDividendInput({ data, household, scopeMemberId, today }), [data, household, scopeMemberId, today]);
  const [view, setView] = useState('income');
  const [, setParams] = useSearchParams();
  // A holding opens over the page, on the tab asked for; closing it goes back.
  const openHolding = (id, tab = 'dividends') =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('holding', id);
        p.set('view', tab);
        return p;
      },
      { state: { drawer: true } },
    );

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  // A source Income needs that never loaded is said there, and Tax years,
  // which needs none of them, stays a view away (the fresh review of 5c).
  const missing = neverLoaded(data, SOURCES);
  const tools = (
    <Tools>
      <Segmented label="Show" options={VIEWS} value={view} onChange={setView} />
      {!missing.length && input.holdings.length > 0 && <FeedChip stamp={feedStamp(input)} />}
    </Tools>
  );
  // Tax history outlives the holdings it came from.
  if (view === 'tax') {
    return (
      <div className="dv">
        {tools}
        <TaxYears members={members} scopeMemberId={scopeMemberId} data={data} />
      </div>
    );
  }
  if (missing.length) {
    return (
      <div className="dv">
        {tools}
        <p className="ov-warn dv-gap" role="alert">
          {couldntLoad(missing)} Refresh the page to try again.
        </p>
      </div>
    );
  }
  if (input.holdings.length === 0) {
    return (
      <div className="dv">
        {tools}
        <Card>
          <EmptyState title="No holdings that pay dividends" body="US-listed and Indian shares appear here once they're added under Investments." />
        </Card>
      </div>
    );
  }
  return (
    <div className="dv">
      {tools}
      <NeedsYou input={input} data={data} openHolding={openHolding} />
      <Strip input={input} money={money} transactions={data.transactions} />
      <div className="dv-top">
        <ByMonth input={input} money={money} today={today} />
        <ComingUp input={input} data={data} money={money} />
      </div>
      <ByHolding input={input} money={money} openHolding={openHolding} />
    </div>
  );
}

// When the feed last checked, amber naming a share while its check fails;
// behind it each market's last check and how far back its history goes.
function FeedChip({ stamp }) {
  const label = stamp.failing.length
    ? `Feed: ${stamp.failing[0].symbol} failing`
    : stamp.checkedAt
      ? `Feed: checked ${shortDate(householdToday(new Date(stamp.checkedAt)))}`
      : 'Feed: not checked yet';
  return (
    <Popover label={label} className={`ds-chip dv-feed${stamp.failing.length ? ' ds-chip-warn' : ''}`} chevron={false}>
      <div className="dv-pop">
        {stamp.markets.map((m) => (
          <p key={m.market}>{`${MARKET_NAMES[m.market]}: ${m.checkedAt ? `checked ${checkedAt(m.checkedAt)}` : 'not checked yet'}${m.coveredFrom ? ` · history from ${shortDate(m.coveredFrom)}` : ''}`}</p>
        ))}
        {stamp.failing.map((f) => (
          <p key={`${f.market}-${f.symbol}`} className="dv-warn">
            {`Checks failing for ${f.symbol} since ${f.since ? shortDate(householdToday(new Date(f.since))) : 'it was added'}`}
          </p>
        ))}
        <p className="dv-ink3">{stamp.neverRun ? "The dividend feed hasn't run yet. It checks each night." : 'It checks each night.'}</p>
      </div>
    </Popover>
  );
}

// The four figures (design/prototype divKpis): received over the last twelve
// months (or since the record starts) with its presumed part, expected over
// the next twelve against the last, about so much a month, and against
// recorded spending.
function Strip({ input, money, transactions }) {
  const h = dividendHeadline(input);
  const spending = spendingEquivalent(input, { transactions: transactions ?? [], now: new Date() });
  // Where each market's record starts, when they differ or one has none.
  const untracked = h.markets.filter((m) => !m.start);
  const india = h.markets.find((m) => m.market === 'IN');
  const us = h.markets.find((m) => m.market === 'US');
  const coverage = untracked.length
    ? untracked.map((m) => `${MARKET_ADJECTIVES[m.market]} dividends aren't recorded until ${A_MARKET_HOLDING[m.market]} has an opening entry.`).join(' ')
    : h.coverageDiffers && india?.start && us?.start
      ? `${MARKET_ADJECTIVES.IN} dividends are counted from ${shortDate(india.start)}, ${MARKET_ADJECTIVES.US} from ${shortDate(us.start)}.`
      : null;
  // While one market's record is shorter, where it starts, in view (the fresh
  // review of 5c); the (i) says both.
  const later = h.coverageDiffers && !untracked.length ? [...h.markets].filter((m) => m.start).sort((a, b) => (a.start < b.start ? 1 : -1))[0] : null;
  const expectedSub = [
    h.expected.changeOnLast12 !== null ? `${signedPct(h.expected.changeOnLast12)} on the last 12` : null,
    h.expected.notCounted > 0 ? `${h.expected.notCounted} not counted: no exchange rate` : null,
    h.expected.notProjected > 0 ? `${plural(h.expected.notProjected, 'holding')} not projected` : null,
  ].filter(Boolean);
  return (
    <Card flush>
      <KpiStrip
        items={[
          {
            label: h.received.since ? `Received since ${shortDate(h.received.since)}` : 'Received · 12 months',
            hero: true,
            info: (
              <InfoButton about="Received">
                {[...CAVEATS, coverage].filter(Boolean).join(' ')}
              </InfoButton>
            ),
            value: (
              <>
                <span className="ds-code">{money.code}</span>
                {money.fmt(h.received.aed)}
              </>
            ),
            sub:
              h.received.presumedAed > 0 || h.received.notCounted > 0 || later ? (
                <span className="dv-subrow">
                  {later && <span>{`${MARKET_NAMES[later.market]} counted from ${shortDate(later.start)}`}</span>}
                  {h.received.presumedAed > 0 && (
                    <Chip title="Paid into a bank account and presumed received 30 days after the ex-date; not checked against a statement.">{`${aed(money, h.received.presumedAed)} presumed`}</Chip>
                  )}
                  {h.received.notCounted > 0 && <span className="dv-warn">{`${h.received.notCounted} not counted: no exchange rate`}</span>}
                </span>
              ) : null,
          },
          { label: 'Expected · 12 months', value: aed(money, h.expected.aed), sub: expectedSub.length ? expectedSub.join(' · ') : null },
          {
            label: 'A month',
            value: (
              <>
                <span className="dv-about">about </span>
                {aed(money, h.expected.monthlyAed)}
              </>
            ),
          },
          {
            label: 'Of spending',
            value: spending ? `${spending.pct}%` : '—',
            sub: spending ? (spending.basis === 'received' ? 'of recorded spending' : 'expected, of recorded spending') : 'needs three months of spending',
          },
        ]}
      />
    </Card>
  );
}

// What needs a member (design/prototype needsCard): the one boxed card, only
// while something waits, each with its answer or the way to it.
function NeedsYou({ input, data, openHolding }) {
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const items = needsYou(input);
  if (items.length === 0) return null;
  const holdings = new Map(input.holdings.map((h) => [h.id, h]));

  async function answer(item, special) {
    setBusy(item.eventId);
    setRefusal(null);
    const { data: result, error } = await supabase.rpc('set_special_part', { p_event_id: item.eventId, p_special_per_share: special });
    setBusy(null);
    if (error || !result?.ok) {
      setRefusal({ eventId: item.eventId, message: error ? `Couldn't save that: ${error.message}. Nothing was changed.` : dividendRefusalMessage(result?.error) });
      return;
    }
    await data.reload();
  }

  return (
    <Card title="Needs you" right={String(items.length)} action flush>
      <ul className="dv-rows">
        {items.map((item, i) => {
          const h = holdings.get(item.holdingId);
          return (
            <li key={`${item.kind}-${item.dividendId ?? item.eventId ?? i}`} className="dv-row">
              <div className="dv-row-main">
                {/* A question that names the holding needs no name above it. */}
                {!item.text.startsWith(h.name) && <span className="dv-name">{h.name}</span>}
                <span className="dv-ink2">{item.text}</span>
                {refusal && refusal.eventId === item.eventId && (
                  <span className="dv-warn" role="alert">
                    {refusal.message}
                  </span>
                )}
              </div>
              <div className="dv-actions">
                {item.kind === 'one_off' ? (
                  <>
                    <button type="button" className="ds-btn ds-btn-sm" disabled={!!busy} onClick={() => answer(item, item.special)}>
                      Yes, part was a one-off
                    </button>
                    <button type="button" className="ds-btn ds-btn-sm" disabled={!!busy} onClick={() => answer(item, 0)}>
                      No, all ordinary
                    </button>
                  </>
                ) : item.kind === 'split_not_traded' ? (
                  // Its dividends can't settle it: the split goes in the holding's trades.
                  <button type="button" className="ds-btn ds-btn-sm" onClick={() => openHolding(h.id, 'trades')}>
                    Record the split
                  </button>
                ) : (
                  <button type="button" className="ds-btn ds-btn-sm" onClick={() => openHolding(h.id)}>
                    {item.kind === 'add_by_hand' ? 'Add it' : 'Review'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// A bar a month over the last twelve and the next twelve (decision 2):
// received solid, presumed paler, expected outlined, today marked; Earned
// puts each in its ex-date's month. The readout gives a month picked, else
// this year so far and next year's expected within the twelve ahead.
function ByMonth({ input, money, today }) {
  const [view, setView] = useState('received');
  const [pick, setPick] = useState(null);
  const { months, thisYear, ahead, leftOut } = dividendsByMonth(input, view);
  const current = today.slice(0, 7);
  const label = (month, i) => {
    const [y, m] = month.split('-');
    if (m === '01') return y;
    return i % 3 === 0 ? SHORT[Number(m) - 1] : '';
  };
  const picked = pick !== null ? months[pick] : null;
  const said = view === 'received' ? 'received' : 'earned';
  const pickedWords = (m) => {
    const parts = [];
    if (m.actualAed > 0) parts.push(`${aed(money, m.actualAed)} ${said}`);
    if (m.presumedAed > 0) parts.push(`${aed(money, m.presumedAed)} presumed`);
    if (m.expectedAed > 0) parts.push(`${aed(money, m.expectedAed)} expected`);
    return `${monthLabel(m.month)}: ${parts.length ? parts.join(', ') : 'nothing'}`;
  };
  // The months of that year the twelve ahead hold, unless all of them.
  const mon = (month) => SHORT[Number(month.slice(5)) - 1];
  const span = !ahead || (ahead.from.slice(5) === '01' && ahead.to.slice(5) === '12') ? '' : ahead.from === ahead.to ? ` (${mon(ahead.from)})` : ` (${mon(ahead.from)}–${mon(ahead.to)})`;
  return (
    <Card
      title="By month"
      className="dv-months"
      right={
        <Segmented
          label="Show"
          options={[
            { id: 'received', label: 'Received' },
            { id: 'earned', label: 'Earned' },
          ]}
          value={view}
          onChange={(v) => {
            setView(v);
            setPick(null);
          }}
        />
      }
    >
      <div className="dv-chart">
        <MonthBars
          months={months.map((m, i) => ({ key: m.month, label: label(m.month, i), solid: m.actualAed, pale: m.presumedAed, outline: m.expectedAed, today: m.month === current }))}
          height={168}
          formatTick={(v) => money.fmtCompact(v)}
          activeIndex={pick}
          onActiveChange={setPick}
          ariaLabel={`Dividends ${said} by month, the last twelve months and the next twelve expected. Use the arrow keys to move between months.`}
        />
        <div className="dv-readout" aria-live="polite">
          {picked ? (
            pickedWords(picked)
          ) : (
            <>
              <span className="dv-key">
                <i className="dv-sw dv-sw-solid" />
                {view === 'received' ? 'Received' : 'Earned'}
              </span>
              <span className="dv-key">
                <i className="dv-sw dv-sw-pale" />
                Presumed
              </span>
              <span className="dv-key">
                <i className="dv-sw dv-sw-outline" />
                Expected
              </span>
              <span>{`${thisYear.year} so far `}<b>{aed(money, thisYear.aed)}</b></span>
              {ahead && <span>{`${ahead.year} ${ahead.part === 'rest' ? 'still expected' : 'expected'}${span} `}<b>{aed(money, ahead.aed)}</b></span>}
            </>
          )}
        </div>
        {view === 'earned' && leftOut > 0 && <p className="dv-note">{leftOut === 1 ? "1 receipt with no ex-date isn't shown." : `${leftOut} receipts with no ex-date aren't shown.`}</p>}
      </div>
    </Card>
  );
}

// Earned and declared dividends still to come in, soonest first
// (design/prototype comingCard): an earned one into a broker's fund can be
// recorded here, and its other actions sit under "⋯".
function ComingUp({ input, data, money }) {
  const [form, setForm] = useState(null);
  const items = comingUp(input);
  const holdings = new Map(input.holdings.map((h) => [h.id, h]));
  const accounts = new Map((input.accounts ?? []).map((a) => [a.id, a]));
  return (
    <Card title="Coming up" className="dv-coming" flush>
      {items.length === 0 ? (
        <EmptyState title="Nothing declared or owed" />
      ) : (
        <ul className="dv-rows">
          {items.map((x) => {
            const h = holdings.get(x.holdingId);
            const into = accounts.get(x.destinationAccountId)?.name;
            const dividend = x.dividendId ? input.dividends.find((d) => d.id === x.dividendId) : null;
            const open = form && form.id === x.dividendId && dividend;
            return (
              <li key={x.dividendId ?? x.eventId} className="dv-row">
                {/* A day in another year keeps its year (the fresh review of
                    5c): last December's, not yet recorded, isn't months away. */}
                <span className="dv-date">{x.day ? shortDate(x.day) : x.month ? monthLabel(x.month) : '—'}</span>
                {/* The card is narrow: the name and its line take the room, the
                    actions sit under them, the amount at the right. */}
                <div className="dv-row-main">
                  <span className="dv-name dv-clip" title={h.name}>
                    {h.name}
                  </span>
                  <span className="dv-ink3">{`${x.kind === 'earned' ? 'Earned' : 'Declared'} · ${native(x.net, x.currency)}${into ? ` · into ${into}` : ''}`}</span>
                  {!open && (x.canRecord || (x.kind === 'earned' && dividend)) && (
                    <div className="dv-actions dv-actions-under">
                      {x.canRecord && (
                        <button type="button" className="ds-btn ds-btn-sm" onClick={() => setForm({ id: x.dividendId, action: 'record' })}>
                          Record
                        </button>
                      )}
                      {x.kind === 'earned' && dividend && (
                        <Popover label="⋯" name={`More for ${h.name}`} chevron={false} className="ds-btn ds-btn-sm">
                          <div className="dv-menu">
                            <button type="button" className="ds-link" onClick={() => setForm({ id: x.dividendId, action: 'fix' })}>
                              Fix
                            </button>
                            <button type="button" className="ds-link" onClick={() => setForm({ id: x.dividendId, action: 'skip' })}>
                              Skip
                            </button>
                          </div>
                        </Popover>
                      )}
                    </div>
                  )}
                </div>
                <span className="dv-amount">{x.netAed !== null ? money.fmt(x.netAed) : '—'}</span>
                {open && (
                  <div className="dv-form">
                    <DividendForm
                      holding={h}
                      dividend={dividend}
                      action={form.action}
                      accounts={input.accounts}
                      onCancel={() => setForm(null)}
                      onSaved={async () => {
                        await data.reload();
                        setForm(null);
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const FREQUENCY = {
  monthly: 'Monthly', quarterly: 'Quarterly', 'half-yearly': 'Half-yearly', yearly: 'Yearly', irregular: 'Irregular', too_new: 'Too new to say',
  none: 'No payments in two years',
};
const STATUS = { may_have_stopped: 'may have stopped paying', not_enough_history: 'not enough history', not_held: 'sold' };

// Each holding with dividends found, grouped by market (design/prototype
// byHoldingCard), the group row giving what is withheld there and the
// market's received and expected; a row opens the holding on its dividends.
// The rest are folded with why they have none to show.
function ByHolding({ input, money, openHolding }) {
  const { groups, none, failing, notChecked } = dividendsByMarket(input);
  const rest = [
    ...none.holdings.map((h) => ({ h, why: none.since ? `No dividends found since ${shortDate(none.since)}` : 'No dividends found' })),
    ...failing.map((h) => ({ h, why: 'Checks failing' })),
    ...notChecked.map((h) => ({ h, why: 'Not checked yet' })),
  ];
  return (
    <Card title="By holding" flush>
      {groups.length === 0 ? (
        <EmptyState title="No dividends found yet" body="The feed checks each night; a holding appears here once it has paid." />
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table dv-table">
            <thead>
              <tr>
                <th scope="col">Holding</th>
                <th scope="col">Sector</th>
                <th scope="col">Rhythm</th>
                <th scope="col" className="ds-num">
                  Last
                </th>
                <th scope="col" className="ds-num">
                  Received
                </th>
                <th scope="col" className="ds-num">
                  Expected
                </th>
                <th scope="col" className="ds-num">
                  <span className="dv-th">
                    Yield
                    <InfoButton about="Yield">{"Expected over the next 12 months, as a share of today's value."}</InfoButton>
                  </span>
                </th>
                <th scope="col" className="ds-num">
                  On cost
                </th>
                <th scope="col" className="ds-num">
                  Next
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <MarketRows key={g.market} group={g} money={money} openHolding={openHolding} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rest.length > 0 && (
        <Fold label="Not paying or not checked" count={rest.length}>
          <ul className="dv-rows">
            {rest.map(({ h, why }) => (
              <li key={h.id}>
                <button type="button" className="dv-row dv-restbutton" onClick={() => openHolding(h.id)}>
                  <span className="dv-name">{h.name}</span>
                  <span className="dv-ink3">{why}</span>
                </button>
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </Card>
  );
}

function MarketRows({ group, money, openHolding }) {
  return (
    <>
      <tr className="dv-group">
        <td colSpan={4}>{`${MARKET_NAMES[group.market]}${group.withholdingPct !== null ? ` · ${group.withholdingPct}% withheld` : ''}`}</td>
        <td className="ds-num">{aed(money, group.receivedAed)}</td>
        <td className="ds-num">{aed(money, group.expectedAed)}</td>
        <td colSpan={3} />
      </tr>
      {/* Nothing is earned before a holding's opening entry, which only the
          household's history can give it. */}
      {group.noOpening && (
        <tr className="dv-warnrow">
          <td colSpan={9}>
            <WarningRow>{`${MARKET_ADJECTIVES[group.market]} dividends aren't recorded until ${A_MARKET_HOLDING[group.market]} has an opening entry.`}</WarningRow>
          </td>
        </tr>
      )}
      {group.rows.map((r) => {
        const h = r.holding;
        const next = r.next?.day ? shortDate(r.next.day) : r.next?.month ? monthLabel(r.next.month) : '—';
        const rhythm = [FREQUENCY[r.frequency?.kind] ?? null, STATUS[r.status] ?? null].filter(Boolean).join(', ') || '—';
        // Not projected (too new, stopped, sold) is said by its rhythm, not as a zero.
        const expected = r.projected || r.expectedAed > 0;
        return (
          <tr key={h.id} className="dv-holdrow" data-open onClick={(e) => !e.target.closest('button') && openHolding(h.id)}>
            <td>
              <button type="button" className="dv-holdname" onClick={() => openHolding(h.id)}>
                {h.name}
              </button>
              {r.noOpening && <div className="dv-ink3 dv-small">no opening entry, so its dividends aren&rsquo;t recorded</div>}
            </td>
            <td className="dv-ink2">{h.sector ? (SECTOR_LABELS[h.sector] ?? h.sector) : '—'}</td>
            <td className="dv-ink2">{rhythm}</td>
            <td className="ds-num">{r.lastOrdinaryPerShare !== null ? `${h.currency} ${formatPerShare(r.lastOrdinaryPerShare)}` : '—'}</td>
            <td className="ds-num">{money.fmt(r.receivedAed)}</td>
            <td className="ds-num">{expected ? money.fmt(r.expectedAed) : '—'}</td>
            <td className="ds-num">{r.yields.onValue !== null ? formatPct(r.yields.onValue, { decimals: 1 }) : '—'}</td>
            <td className="ds-num">{r.yields.onCost !== null ? formatPct(r.yields.onCost, { decimals: 1 }) : '—'}</td>
            <td className="ds-num dv-next">{next}</td>
          </tr>
        );
      })}
    </>
  );
}
