import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNow } from '../../lib/useNow';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import {
  ASSET_CLASS_LABELS,
  GROUP_ORDER,
  RANGES,
  SECTOR_LABELS,
  allocationByClass,
  groupOf,
  hasSector,
  isClosedHolding,
  portfolioInvestedAndGain,
  portfolioSeries,
  portfolioValueChange,
  visibleHoldings,
} from '../../lib/holdings';
import { changeToday, holdingTableRows, priceFreshness, seriesInRange, seriesShortOf, stalePrice } from '../../lib/investmentsView';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { isAwaitingFirstValuation } from '../../lib/valuation';
import { salesProfit } from '../../lib/trades';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { householdToday } from '../../lib/day';
import { supabase } from '../../lib/supabaseClient';
import { TrendLine } from '../../design-system/charts';
import { Avatar, Banner, Card, Chip, EmptyState, Fold, InfoButton, KpiStrip, Popover, Segmented, StackBar } from '../../design-system/kit';
import { Tools } from '../PageTools';
import Withheld from '../planning/Withheld';
import Concentration from './Concentration';
import './Investments.css';

// Wealth -> Investments as the prototype lays it out (the revamp, phase 5b;
// design/prototype invKpis, invChart, allocationCard, holdingsCard): the five
// figures, how the value has moved beside what it is made of, and the
// holdings. A holding opens its drawer through the address (`?holding=`,
// HoldingDrawer.jsx), so any page can link to one.

// One empty list for a source a caller did not pass, so the figures worked
// from it are not worked out again on every render.
const NONE = [];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d, year = true) => `${d.getDate()} ${SHORT[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ''}`;
const stampLabel = (d) => `${dayLabel(d, false)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const signedPct = (f, decimals = 1) => (Number.isFinite(f) ? `${f >= 0 ? '+' : '−'}${formatPct(Math.abs(f), { decimals })}` : '');
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : undefined);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Named for what it is (QA #5): the value moves when money is added or taken
// out, not only when prices do.
const MONEY_MOVED = 'The change includes money added or withdrawn, not investment return alone.';
const names = (list) => (list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

export default function Investments({ household, members = [], me, data, loading, reloadHousehold }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const [, setParams] = useSearchParams();
  const holdings = data.holdings ?? NONE;
  const holdingHistory = data.holdingHistory ?? NONE;
  const holdingTrades = data.holdingTrades ?? NONE;
  const fxRateHistory = data.fxRateHistory ?? NONE;
  const { reload } = data;

  const [group, setGroup] = useState('All');
  const [range, setRange] = useState('3M');
  // The point picked on the chart, a position in this range's points: in
  // another range it would be another day (the fresh review of PR 5), so a
  // new range or group starts at today's.
  const [pick, setPick] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const now = useNow(data?.loadedAt);

  // A holding opens over the page; closing it goes back (HoldingDrawer.jsx).
  const openHolding = (id, view) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('holding', id);
        if (view) p.set('view', view);
        else p.delete('view');
        return p;
      },
      { state: { drawer: true } },
    );

  // A holding sold down to nothing is kept with its trades, but it is not
  // one of the holdings the household has: the table and every figure above
  // it are the open ones, and the sold ones have their own fold (SHR-371).
  const rows = useMemo(() => visibleHoldings(holdings, scopeMemberId, group).filter((h) => !isClosedHolding(h)), [holdings, scopeMemberId, group]);
  const sold = useMemo(() => visibleHoldings(holdings, scopeMemberId, 'All').filter(isClosedHolding), [holdings, scopeMemberId]);
  // How fresh the prices are, over the holdings in view, whatever group.
  const freshness = useMemo(() => priceFreshness(visibleHoldings(holdings, scopeMemberId, 'All'), now), [holdings, scopeMemberId, now]);
  // What sales made this calendar year, in the household's year, on the
  // holdings in view (sold ones included: selling out is when most is made).
  const year = Number(householdToday().slice(0, 4));
  // Trades or rates that never loaded are placeholders, not data: what sales
  // made is withheld rather than shown as none, and a rupee sale is not
  // valued at today's rate in place of its day's (loadState.js).
  const missing = neverLoaded(data, ['holdingTrades', 'fxRateHistory']);
  const tradesMissing = missing.includes('holdingTrades');
  const ratesMissing = missing.includes('fxRateHistory');
  const inrPerAed = ratesMissing ? null : (household?.inr_per_aed ?? null);
  const fx = useMemo(() => ({ fxHistory: fxRateHistory, inrPerAed }), [fxRateHistory, inrPerAed]);
  const yearProfit = useMemo(
    () => salesProfit(holdingTrades, visibleHoldings(holdings, scopeMemberId, group), { from: `${year}-01-01`, to: `${year + 1}-01-01`, scopeMemberId, ...fx }),
    [holdingTrades, holdings, scopeMemberId, group, year, fx],
  );
  const profitMissing = tradesMissing ? ['holdingTrades'] : !yearProfit.available && ratesMissing ? ['fxRateHistory'] : null;
  const groupsPresent = ['All', ...GROUP_ORDER.filter((g) => g !== 'All' && holdings.some((h) => groupOf(h.asset_class) === g))];

  const table = useMemo(() => holdingTableRows(rows, scopeMemberId), [rows, scopeMemberId]);
  const totalValue = table.reduce((s, r) => s + (r.value ?? 0), 0);
  const notValued = rows.filter(isAwaitingFirstValuation).length;
  // Named for what it is, not for what a reader hopes it is: this moves when
  // money is added or taken out, not only when prices do (QA #5).
  const valueChange = useMemo(() => portfolioValueChange(rows, holdingHistory, range, scopeMemberId, now), [rows, holdingHistory, range, scopeMemberId, now]);
  const series = useMemo(() => portfolioSeries(rows, holdingHistory, scopeMemberId, now), [rows, holdingHistory, scopeMemberId, now]);
  const ranged = useMemo(() => seriesInRange(series, range, now), [series, range, now]);
  const shortOf = seriesShortOf(ranged);
  const allocation = useMemo(() => allocationByClass(rows, scopeMemberId), [rows, scopeMemberId]);
  const dayChange = useMemo(() => changeToday(rows, scopeMemberId), [rows, scopeMemberId]);
  const investedGain = useMemo(() => portfolioInvestedAndGain(rows, scopeMemberId), [rows, scopeMemberId]);

  // Refresh prices calls the price-refresh feed (SHR-237) for whatever
  // holdings have opted into a provider (price_provider set). Re-reading what
  // is stored, without fetching a price, is the page's own Refresh at the top.
  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError('');
    const { data: result, error } = await supabase.functions.invoke('price-refresh');
    setRefreshing(false);
    if (error) {
      setRefreshError(error.message ?? 'Refresh failed.');
      return;
    }
    if (result?.fx?.ok === false) setRefreshError(`the exchange rates didn’t refresh: ${result.fx.error}`);
    await reload();
  }

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  // Holdings that never loaded are not "No holdings", which invited adding
  // them a second time (round 2 of the outside review, E2-3).
  const holdingsMissing = neverLoaded(data, ['holdings']);
  if (holdingsMissing.length > 0) {
    return (
      <Withheld missing={holdingsMissing} onRetry={reload}>
        Your holdings aren&rsquo;t shown, rather than shown as none.
      </Withheld>
    );
  }

  const ownerAvatar = (h) => {
    if (h.is_shared) return <Avatar name="Shared" initial="S" />;
    const at = members.findIndex((m) => m.id === h.owner_member_id);
    const m = members[at];
    return m ? <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={at === 0 ? 'a' : 'b'} /> : null;
  };
  const ownerName = (h) => (h.is_shared ? 'Shared' : (members.find((m) => m.id === h.owner_member_id)?.display_name ?? 'Unassigned'));

  const tools = (
    <Tools>
      {groupsPresent.length > 1 && (
        <Segmented
          label="Which holdings"
          options={groupsPresent.map((g) => ({ id: g, label: g }))}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setPick(null);
          }}
        />
      )}
      <PricesStamp freshness={freshness} />
      {freshness.stale.length > 0 && (
        <button type="button" className="ds-chip ds-chip-warn" onClick={() => openHolding(freshness.stale[0].id)}>
          {`${freshness.stale.length} stale`}
        </button>
      )}
      <button type="button" className="ds-btn" onClick={handleRefresh} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh prices'}
      </button>
      <button type="button" className="ds-btn ds-btn-primary" onClick={() => openHolding('new')}>
        + Holding
      </button>
    </Tools>
  );

  // A failed refresh interrupts, with Try again; a feed that failed for some
  // holdings waits its turn, naming them.
  const banners = refreshError ? (
    <Banner onRetry={handleRefresh}>{`Couldn’t refresh prices: ${refreshError}.${freshness.lastRefreshed ? ` Showing prices from ${stampLabel(freshness.lastRefreshed)}.` : ''}`}</Banner>
  ) : freshness.failing.length > 0 ? (
    <Banner tone="warn" onRetry={handleRefresh}>
      {`${names(freshness.failing.map((h) => h.name))} didn’t refresh, so ${freshness.failing.length === 1 ? 'its price' : 'their prices'} may be old.`}
    </Banner>
  ) : null;

  const profitItem = profitOnSalesItem(yearProfit, profitMissing, money);
  const soldFold = sold.length > 0 && (
    <Fold label="Sold" count={sold.length}>
      <ul className="inv-sold">
        {sold.map((h) => (
          <SoldRow key={h.id} holding={h} owner={ownerName(h)} trades={holdingTrades} money={money} scopeMemberId={scopeMemberId} fx={fx} onOpen={() => openHolding(h.id)} />
        ))}
      </ul>
    </Fold>
  );

  if (rows.length === 0) {
    return (
      <div className="inv">
        {tools}
        {banners}
        {/* Everything in view sold: what the sales made still counts. */}
        {(sold.length > 0 || tradesMissing) && (
          <Card flush>
            <KpiStrip items={[profitItem]} />
          </Card>
        )}
        <Card>
          <EmptyState
            title={group === 'All' ? 'No holdings' : `No ${group} holdings`}
            body={group === 'All' ? 'Add one to follow its value, its trades and its dividends.' : null}
            action={{ label: 'Add a holding', onClick: () => openHolding('new') }}
          />
        </Card>
        {soldFold && <Card flush>{soldFold}</Card>}
      </div>
    );
  }

  const picked = pick !== null && ranged[pick] && !ranged[pick].isLive ? ranged[pick] : null;
  const changeText = valueChange.available
    ? `Change · ${range} ${money.fmtSigned(valueChange.absolute)}${valueChange.pct !== null ? ` (${signedPct(valueChange.pct)})` : ''}`
    : holdingHistory.length === 0
      ? 'No valuation history yet. Refreshing prices records a dated point.'
      : valueChange.missing?.length && valueChange.missing.length < rows.length
        ? `No ${range} change: ${names(valueChange.missing)} has no value from then.`
        : `Not enough history yet for ${range}.`;

  return (
    <div className="inv">
      {tools}
      {banners}
      <Card flush>
        <KpiStrip
          items={[
            {
              label: 'Value',
              hero: true,
              value: (
                <>
                  <span className="ds-code">{money.code}</span>
                  {money.fmt(totalValue)}
                </>
              ),
              // A holding not valued yet counts its placeholder 0 (QA #6):
              // saying so keeps the total from reading as the whole.
              sub: notValued > 0 ? `${notValued} not valued yet, counted as nothing` : group !== 'All' ? group : null,
            },
            { label: 'Invested', value: investedGain.available ? money.fmt(investedGain.invested) : '—' },
            {
              label: 'Profit not yet taken',
              value: investedGain.available ? money.fmtSigned(investedGain.absolute) : '—',
              tone: investedGain.available ? tone(investedGain.absolute) : undefined,
              sub: investedGain.available && investedGain.pct !== null ? `${signedPct(investedGain.pct)} on cost` : null,
            },
            profitItem,
            {
              label: 'Change today',
              value: dayChange.available ? money.fmtSigned(dayChange.absolute) : '—',
              tone: dayChange.available ? tone(dayChange.absolute) : undefined,
              sub: dayChange.available && dayChange.pct !== null ? signedPct(dayChange.pct, 2) : null,
            },
          ]}
        />
      </Card>

      <div className="inv-top">
        <Card
          title="Value over time"
          className="inv-chart-card"
          // One explanation beside the title: a short history's chip holds
          // both caveats, as the prototype's does.
          info={
            shortOf.length > 0 ? (
              <span className="inv-title-extra">
                <Chip tone="warn">Partial history</Chip>
                <InfoButton about="Partial history">{`Some days leave out ${names(shortOf)}, which had no value recorded then, so the line dips there. ${MONEY_MOVED}`}</InfoButton>
              </span>
            ) : (
              <InfoButton about="Value over time">{MONEY_MOVED}</InfoButton>
            )
          }
          right={
            <Segmented
              label="Range"
              options={RANGES.map((r) => ({ id: r, label: r }))}
              value={range}
              onChange={(r) => {
                setRange(r);
                setPick(null);
              }}
            />
          }
        >
          <div className="inv-chart">
            {ranged.length >= 2 ? (
              <TrendLine
                points={ranged.map((p) => ({ value: p.total }))}
                height={200}
                activeIndex={pick}
                onActiveChange={setPick}
                ariaLabel="Value of the investments each day a value was recorded, and today. Use the arrow keys to move between days."
              />
            ) : (
              <p className="inv-ink3 inv-chart-empty">Not enough daily history yet to draw a trend.</p>
            )}
            <div className="inv-readout" aria-live="polite">
              {picked ? (
                <span>
                  {`${dayLabel(picked.date)} · `}
                  <b>{`${money.code} ${money.fmt(picked.total)}`}</b>
                </span>
              ) : (
                <>
                  <span className={valueChange.available ? `inv-${tone(valueChange.absolute) ?? 'ink3'}` : 'inv-ink3'}>{changeText}</span>
                  <span>
                    {'Today · '}
                    <b>{`${money.code} ${money.fmt(totalValue)}`}</b>
                  </span>
                </>
              )}
            </div>
          </div>
        </Card>

        <Card title="Allocation" className="inv-alloc">
          <div className="inv-alloc-body">
            <StackBar label={`By asset class, ${money.code} ${money.fmt(totalValue)} in all`} parts={allocation.map((a) => ({ label: ASSET_CLASS_LABELS[a.assetClass] ?? a.assetClass, value: a.value }))} />
            {/* Of everything invested, so only when nothing is filtered out. */}
            {group === 'All' && <Concentration holdings={rows} scopeMemberId={scopeMemberId} household={household} onCapSaved={reloadHousehold} onOpenHolding={openHolding} />}
          </div>
        </Card>
      </div>

      <Card title="Holdings" right={`${rows.length} held`} flush>
        <div className="ds-table-wrap">
          <table className="ds-table inv-table">
            <thead>
              <tr>
                <th scope="col">Holding</th>
                <th scope="col" className="inv-col-owner">
                  Owner
                </th>
                <th scope="col" className="ds-num">
                  Units
                </th>
                <th scope="col" className="ds-num">
                  Avg price
                </th>
                <th scope="col" className="ds-num">
                  Price now
                </th>
                <th scope="col" className="ds-num">{`Invested (${money.code})`}</th>
                <th scope="col" className="ds-num">{`Value (${money.code})`}</th>
                <th scope="col" className="ds-num">
                  Profit
                </th>
                <th scope="col" className="ds-num">
                  Today
                </th>
              </tr>
            </thead>
            <tbody>
              {table.map(({ holding: h, value, invested, gain, share }) => {
                const failing = Boolean(h.price_provider && h.price_fetch_error);
                return (
                  <tr key={h.id} className="inv-row" data-open onClick={(e) => !e.target.closest('button') && openHolding(h.id)}>
                    <td>
                      <div className="inv-holding">
                        {/* The row opens on a click; the name is the button
                            that opens it from the keyboard (outside review,
                            E-09). */}
                        <button type="button" className="inv-name" onClick={() => openHolding(h.id)}>
                          {h.name}
                        </button>
                        {stalePrice(h, now) && <Chip tone="warn">Stale price</Chip>}
                        {hasSector(h.asset_class) && !h.sector && <Chip>Untagged</Chip>}
                      </div>
                      <div className="inv-sub">{`${ASSET_CLASS_LABELS[h.asset_class] ?? 'Other'}${h.sector && h.sector !== 'broad' ? ` · ${SECTOR_LABELS[h.sector] ?? h.sector}` : ''}`}</div>
                    </td>
                    <td>{ownerAvatar(h)}</td>
                    <td className="ds-num">{h.quantity != null ? Number(h.quantity).toLocaleString('en-AE') : '—'}</td>
                    <td className="ds-num">{h.avg_price != null ? <Price value={h.avg_price} currency={h.currency} /> : '—'}</td>
                    <td className="ds-num">
                      {h.current_price != null ? <Price value={h.current_price} currency={h.currency} /> : null}
                      {!h.price_provider && <div className={h.current_price != null ? 'inv-sub' : 'inv-ink3'}>manual</div>}
                      {h.price_provider && h.current_price == null && '—'}
                    </td>
                    <td className="ds-num">{invested !== null ? money.fmt(invested) : '—'}</td>
                    <td className="ds-num">
                      {/* The stored 0 on a holding nothing has priced yet is
                          a placeholder, not a measurement (QA #6). */}
                      {value === null ? (
                        <span className="inv-ink3">Not valued yet</span>
                      ) : (
                        <>
                          <div className="inv-fig">{money.fmt(value)}</div>
                          {share !== null && <div className="inv-sub">{`${formatPct(share)} of total`}</div>}
                        </>
                      )}
                    </td>
                    <td className="ds-num">
                      {gain ? (
                        <>
                          <div className={`inv-${tone(gain.absolute) ?? 'ink2'}`}>{money.fmtSigned(gain.absolute)}</div>
                          <div className="inv-sub">{signedPct(gain.pct)}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    {/* A failed refresh leaves the last day's change behind:
                        it isn't today's. */}
                    <td className="ds-num">
                      {!failing && h.day_change_pct != null ? <span className={`inv-${tone(h.day_change_pct) ?? 'ink3'}`}>{signedPct(h.day_change_pct / 100, 2)}</span> : <span className="inv-ink3">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {soldFold}
      </Card>
    </div>
  );
}

// A price in its holding's own currency, the code beside it in grey.
function Price({ value, currency }) {
  return (
    <>
      {formatMoney(value, { decimals: 2 })}
      <span className="inv-ccy">{currency}</span>
    </>
  );
}

// The Prices stamp: when the feed last ran, and behind it how old the
// prices are and what the two refreshes do (QA-04).
function PricesStamp({ freshness }) {
  const { lastRefreshed, oldestPricedAt, liveFeeds, neverPriced, failing } = freshness;
  return (
    // Quiet, in the mono figures of a time stamp, as the prototype's.
    <span className="inv-stamp">
    <Popover label={lastRefreshed ? `Prices ${stampLabel(lastRefreshed)}` : 'Prices never refreshed'}>
      <div className="inv-prices">
        <p>
          {oldestPricedAt ? `Oldest valuation ${dayLabel(oldestPricedAt, false)}` : 'No holding has a confirmed valuation yet.'}
          {neverPriced > 0 ? ` · ${neverPriced} never valued` : ''}
        </p>
        <p>{liveFeeds === 0 ? 'No holding has auto-pricing set up yet: open one to opt it in.' : `${plural(liveFeeds, 'holding')} on a live feed`}</p>
        {failing.length > 0 && <p className="inv-warn">{`The last refresh failed for ${names(failing.map((h) => h.name))}.`}</p>}
        <p className="inv-ink3">Refresh prices calls the live feed. Refresh at the top of the page re-reads what is stored and does not fetch prices.</p>
      </div>
    </Popover>
    </span>
  );
}

// What sales made this year, in the screen's currency: after tax, and with
// sales still awaiting the broker's tax, beneath it. Withheld, and why, when
// its trades or rates never loaded, or a rupee sale has no rate.
function profitOnSalesItem(profit, missing, money) {
  const label = 'Profit on sales this year';
  const failed = missing ? couldntLoad(missing) : null;
  if (failed) return { label, value: '—', sub: `Not known: ${failed.charAt(0).toLowerCase()}${failed.slice(1)}` };
  if (!profit.available) return { label, value: '—', sub: 'Not known: a rupee sale has no exchange rate' };
  if (profit.sales === 0) return { label, value: <span className="inv-ink3">None</span> };
  // An Indian sale's tax is deducted by the broker and read from its
  // statement later; until then its profit is before a tax not yet known.
  const sub = [
    plural(profit.sales, 'sale'),
    profit.taxAed > 0 ? `after tax ${money.fmtSigned(profit.profitAed - profit.taxAed)}` : null,
    profit.taxToConfirm > 0 ? `${profit.taxToConfirm} awaiting the broker’s tax` : null,
  ].filter(Boolean);
  return { label, value: money.fmtSigned(profit.profitAed), tone: tone(profit.profitAed), sub: sub.join(' · ') };
}

// A sold-out holding: whose it was, when its last units went, and what all its
// sales made since its trade history started, in the screen's currency.
function SoldRow({ holding, owner, trades, money, scopeMemberId, fx, onOpen }) {
  const lastSale = trades.filter((t) => t.holding_id === holding.id && t.kind === 'sell').reduce((last, t) => (!last || t.trade_date > last ? t.trade_date : last), null);
  const made = salesProfit(trades, [holding], { scopeMemberId, ...fx });
  const soldOn = lastSale ? dayLabel(new Date(`${lastSale}T00:00:00`)) : null;
  return (
    <li>
      <button type="button" className="inv-sold-row" onClick={onOpen}>
        <span className="inv-sold-main">
          <span className="inv-sold-name">{holding.name}</span>
          <span className="inv-sub">{`${owner}${soldOn ? ` · sold out on ${soldOn}` : ''}`}</span>
        </span>
        <span className="inv-sold-made">
          {!made.available ? (
            <span className="inv-ink3">Profit not known</span>
          ) : made.sales > 0 ? (
            <>
              <span className={`inv-${tone(made.profitAed) ?? 'ink2'}`}>{money.fmtSigned(made.profitAed)}</span>
              <span className="inv-ink3"> profit</span>
            </>
          ) : (
            <span className="inv-ink3">—</span>
          )}
        </span>
      </button>
    </li>
  );
}
