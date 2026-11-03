import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { householdToday } from '../../lib/day';
import { formatMoney, formatPct } from '../../lib/money';
import { SECTOR_LABELS } from '../../lib/holdings';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { dividendRefusalMessage, formatPerShare, monthLabel, shortDate } from '../../lib/dividends';
import {
  buildDividendInput, comingUp, dividendHeadline, dividendSources, dividendsByHolding, dividendsByMonth, feedFreshness, needsYou, spendingEquivalent,
} from '../../lib/dividendSummary';
import DividendForm from './DividendForm';
import HoldingDividends from './HoldingDividends';
import './HoldingTrades.css';
import './Dividends.css';

// What the tab reads; one that never loaded is said, never shown as none.
const SOURCES = ['holdings', 'holdingDividends', 'holdingTrades', 'dividendEvents', 'dividendSplits', 'dividendSpecialParts', 'dividendFeedStatus', 'accounts'];
const MARKET_NAMES = { IN: 'India', US: 'US' };
const MARKET_ADJECTIVES = { IN: 'Indian', US: 'US' };
const A_MARKET_HOLDING = { IN: 'an Indian holding', US: 'a US holding' };

const native = (amount, currency) => `${currency} ${formatMoney(amount, { decimals: 2 })}`;

// Wealth's Dividends tab (SHR-366, spec 6): dividends as passive income, in
// the screen's scope. Earned, Expected and Received are kept apart; what is
// to come is a projection and says so. The figures come from
// src/lib/dividendSummary.js; this lays them out.
export default function Dividends({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const today = householdToday();
  const input = useMemo(() => buildDividendInput({ data, household, scopeMemberId, today }), [data, household, scopeMemberId, today]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  const missing = neverLoaded(data, SOURCES);
  if (missing.length) {
    return (
      <p className="ov-warn dv-gap" role="alert">
        {couldntLoad(missing)} Refresh the page to try again.
      </p>
    );
  }
  if (input.holdings.length === 0) {
    return (
      <div className="ov-empty dv-gap">
        <div className="ov-empty-body">{"No holdings that pay dividends. US-listed and Indian shares appear here once they're added under Investments."}</div>
      </div>
    );
  }
  const neverRun = feedFreshness(input).every((m) => m.neverRun);
  return (
    <div className="dv-tab">
      {neverRun && <p className="ov-muted dv-gap dv-note">{"The dividend feed hasn't run yet. It checks each night."}</p>}
      <Headline input={input} money={money} transactions={data.transactions} />
      <ComingUp input={input} data={data} money={money} />
      <NeedsYou input={input} data={data} />
      <ByMonth input={input} money={money} />
      <ByHolding input={input} data={data} money={money} />
      <Sources input={input} money={money} />
      <Freshness input={input} />
    </div>
  );
}

const aed = (money, value) => `${money.code} ${money.fmt(value)}`;

function Headline({ input, money, transactions }) {
  const h = dividendHeadline(input);
  const spending = spendingEquivalent(input, { transactions: transactions ?? [], now: new Date() });
  return (
    <section className="dv-headline" aria-label="Dividends at a glance">
      <div className="dv-figures">
        <div>
          <div className="ov-kicker">{h.received.since ? `Received since ${shortDate(h.received.since)}` : 'Received in the last 12 months'}</div>
          <div className="ov-hero fig">
            <span className="ov-hero-currency">{money.code}</span> {money.fmt(h.received.aed)}
          </div>
          {h.received.presumedAed > 0 && <div className="ov-muted dv-sub">{`of which ${aed(money, h.received.presumedAed)} presumed, not checked`}</div>}
          {h.received.notCounted > 0 && <div className="ov-warn dv-sub">{`${h.received.notCounted} not counted: no exchange rate`}</div>}
        </div>
        <div>
          <div className="ov-kicker">Expected in the next 12 months</div>
          <div className="dv-figure fig">{aed(money, h.expected.aed)}</div>
          <div className="ov-muted dv-sub">{`about ${aed(money, h.expected.monthlyAed)} a month`}</div>
          {h.expected.notCounted > 0 && <div className="ov-warn dv-sub">{`${h.expected.notCounted} not counted: no exchange rate`}</div>}
          {h.expected.notProjected > 0 && (
            <div className="ov-muted dv-sub">{`${h.expected.notProjected} holding${h.expected.notProjected === 1 ? '' : 's'} not projected: see By holding.`}</div>
          )}
          {spending && (
            <div className="ov-muted dv-sub">
              {spending.basis === 'received' ? `Equal to ${spending.pct}% of recorded spending` : `Expected to equal ${spending.pct}% of recorded spending`}
            </div>
          )}
        </div>
      </div>
      <ul className="dv-markets">
        {h.markets.map((m) => (
          <li key={m.market}>
            {m.start
              ? `${MARKET_NAMES[m.market]}: ${aed(money, m.receivedAed)} received ${m.since ? `since ${shortDate(m.since)}` : 'in the last 12 months'} · ${aed(money, m.expectedAed)} expected`
              : `${MARKET_NAMES[m.market]}: nothing recorded, no opening entry · ${aed(money, m.expectedAed)} expected`}
          </li>
        ))}
      </ul>
      <Coverage headline={h} />
    </section>
  );
}

// When the two markets' records start at different times, both dates, so
// neither total reads as covering what it does not. A market none of whose
// holdings has an opening entry records nothing, and says so.
function Coverage({ headline }) {
  const untracked = headline.markets.filter((m) => !m.start);
  if (untracked.length > 0) {
    return (
      <p className="ov-muted dv-sub">
        {untracked.map((m) => `${MARKET_ADJECTIVES[m.market]} dividends aren't recorded until ${A_MARKET_HOLDING[m.market]} has an opening entry.`).join(' ')}
      </p>
    );
  }
  const india = headline.markets.find((m) => m.market === 'IN');
  const us = headline.markets.find((m) => m.market === 'US');
  if (!headline.coverageDiffers || !india?.start || !us?.start) return null;
  return (
    <p className="ov-muted dv-sub">
      {`${MARKET_ADJECTIVES.IN} dividends are counted from ${shortDate(india.start)}, ${MARKET_ADJECTIVES.US} from ${shortDate(us.start)}.`}
    </p>
  );
}

function ComingUp({ input, data, money }) {
  const [recording, setRecording] = useState(null);
  const items = comingUp(input);
  const holdings = new Map(input.holdings.map((h) => [h.id, h]));
  const accounts = new Map((input.accounts ?? []).map((a) => [a.id, a]));
  return (
    <section className="dv-section" aria-labelledby="dv-coming">
      <h3 className="ov-kicker dv-title" id="dv-coming">
        Coming up
      </h3>
      {items.length === 0 ? (
        <p className="ov-muted dv-note">Nothing declared or owed right now.</p>
      ) : (
        <ul className="ht-list">
          {items.map((x) => {
            const h = holdings.get(x.holdingId);
            const when = x.day ? shortDate(x.day) : x.month ? monthLabel(x.month) : 'date not known';
            const into = accounts.get(x.destinationAccountId)?.name;
            const dividend = x.dividendId ? input.dividends.find((d) => d.id === x.dividendId) : null;
            return (
              <li key={x.dividendId ?? x.eventId} className="ht-row hd-row">
                <div className="mn-row-main">
                  <div>{`${h.name} · ${when}${x.netAed !== null ? ` · ${aed(money, x.netAed)}` : ''}`}</div>
                  <div className="ov-muted">
                    {`${x.kind === 'earned' ? 'Earned' : 'Declared'} · ${native(x.net, x.currency)} expected${into ? ` · into ${into}` : ''}`}
                  </div>
                </div>
                {recording === x.dividendId && dividend ? (
                  <DividendForm
                    holding={h}
                    dividend={dividend}
                    action="record"
                    accounts={input.accounts}
                    onCancel={() => setRecording(null)}
                    onSaved={async () => {
                      await data.reload();
                      setRecording(null);
                    }}
                  />
                ) : (
                  x.canRecord && (
                    <div className="ht-actions hd-actions">
                      <button type="button" className="om-btn" onClick={() => setRecording(x.dividendId)}>
                        Record
                      </button>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function NeedsYou({ input, data }) {
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [reviewing, setReviewing] = useState(null);
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
    <section className="dv-section" aria-labelledby="dv-needs">
      <h3 className="ov-kicker dv-title" id="dv-needs">
        Needs you
      </h3>
      <ul className="ht-list">
        {items.map((item, i) => {
          const h = holdings.get(item.holdingId);
          const key = `${item.kind}-${item.dividendId ?? item.eventId ?? i}`;
          return (
            <li key={key} className="ht-row hd-row">
              <div className="mn-row-main">
                <div>{h.name}</div>
                <div className="ov-muted">{item.text}</div>
              </div>
              {refusal && refusal.eventId === item.eventId && (
                <p className="ov-warn hd-note" role="alert">
                  {refusal.message}
                </p>
              )}
              {item.kind === 'one_off' ? (
                <div className="ht-actions hd-actions">
                  <button type="button" className="om-btn" disabled={!!busy} onClick={() => answer(item, item.special)}>
                    Yes, part was a one-off
                  </button>
                  <button type="button" className="om-btn" disabled={!!busy} onClick={() => answer(item, 0)}>
                    No, all ordinary
                  </button>
                </div>
              ) : item.kind === 'split_not_traded' ? (
                // Its dividends can't settle it: the split goes in the holding's trades.
                <p className="ov-muted hd-note">Record the split in its trades, under Investments.</p>
              ) : reviewing === key ? (
                <HoldingDividends
                  holding={h}
                  dividends={data.holdingDividends}
                  specialParts={data.dividendSpecialParts}
                  accounts={input.accounts}
                  onChanged={data.reload}
                />
              ) : (
                <div className="ht-actions hd-actions">
                  <button type="button" className="om-btn" onClick={() => setReviewing(key)}>
                    Review
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const FREQUENCY = {
  monthly: 'Monthly', quarterly: 'Quarterly', 'half-yearly': 'Half-yearly', yearly: 'Yearly', irregular: 'Irregular', too_new: 'Too new to say',
  none: 'No payments in two years',
};
const STATUS = { may_have_stopped: 'may have stopped paying', not_enough_history: 'not enough history', not_held: 'sold' };

// Received (or earned) month by month, presumed receipts shaded apart, and
// the next twelve months expected in a lighter shade: one bar a month, each
// named for a screen reader by its month and figures.
function ByMonth({ input, money }) {
  const [view, setView] = useState('received');
  const { months, years, leftOut } = dividendsByMonth(input, view);
  const peak = Math.max(1, ...months.map((m) => m.actualAed + m.presumedAed + m.expectedAed));
  const W = months.length * 10;
  const H = 120;
  const height = (v) => (v / peak) * H;
  return (
    <section className="dv-section" aria-labelledby="dv-months">
      <div className="dv-head">
        <h3 className="ov-kicker dv-title" id="dv-months">
          By month
        </h3>
        <div className="dv-switch" role="group" aria-label="Show">
          {['received', 'earned'].map((v) => (
            <button key={v} type="button" className="om-seg" data-active={view === v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'received' ? 'Received' : 'Earned'}
            </button>
          ))}
        </div>
      </div>
      <svg className="dv-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Dividends ${view} by month, and expected`}>
        {months.map((m, i) => {
          const parts = [`${aed(money, m.actualAed)} ${view}`];
          if (m.presumedAed > 0) parts.push(`${aed(money, m.presumedAed)} presumed`);
          if (m.expectedAed > 0) parts.push(`${aed(money, m.expectedAed)} expected`);
          const a = height(m.actualAed);
          const p = height(m.presumedAed);
          const e = height(m.expectedAed);
          return (
            // Each month its own small drawing, so its title names it.
            <svg key={m.month} x={i * 10} y="0" width="10" height={H}>
              <title>{`${monthLabel(m.month)}: ${parts.join(', ')}`}</title>
              <rect x="1" y={H - a} width="8" height={a} className="dv-bar-actual" />
              <rect x="1" y={H - a - p} width="8" height={p} className="dv-bar-presumed" />
              <rect x="1" y={H - a - p - e} width="8" height={e} className="dv-bar-expected" />
            </svg>
          );
        })}
      </svg>
      <div className="dv-axis ov-muted">
        <span>{monthLabel(months[0].month)}</span>
        <span>{monthLabel(months.at(-1).month)}</span>
      </div>
      <p className="ov-muted dv-sub">{`Total ${years.map((y) => `${y.year}: ${aed(money, y.aed)}`).join(' · ')}`}</p>
      {view === 'earned' && leftOut > 0 && (
        <p className="ov-muted dv-sub">{leftOut === 1 ? "1 receipt with no ex-date isn't shown." : `${leftOut} receipts with no ex-date aren't shown.`}</p>
      )}
    </section>
  );
}

// Each holding with dividends found, most expected first; opening one shows
// its dividends, to record, fix or skip. The rest are folded by why they
// have none to show.
function ByHolding({ input, data, money }) {
  const [opened, setOpened] = useState(null);
  const { rows, none, failing, notChecked } = dividendsByHolding(input);
  const names = (holdings) => holdings.map((h) => h.name).join(', ');
  return (
    <section className="dv-section" aria-labelledby="dv-holdings">
      <h3 className="ov-kicker dv-title" id="dv-holdings">
        By holding
      </h3>
      <ul className="ht-list">
        {rows.map((r) => {
          const h = r.holding;
          const next = r.next?.day ? shortDate(r.next.day) : r.next?.month ? monthLabel(r.next.month) : null;
          const parts = [
            r.noOpening ? "no opening entry, so its dividends aren't recorded" : null,
            r.lastOrdinaryPerShare !== null ? `last ${h.currency} ${formatPerShare(r.lastOrdinaryPerShare)} a share` : null,
            `${aed(money, r.receivedAed)} received`,
            // Not projected (too new, stopped, sold) is said by its status, not as a zero.
            r.projected || r.expectedAed > 0 ? `${aed(money, r.expectedAed)} expected` : null,
            r.yields.onValue !== null ? `${formatPct(r.yields.onValue, { decimals: 1 })} on value` : null,
            r.yields.onCost !== null ? `${formatPct(r.yields.onCost, { decimals: 1 })} on cost` : null,
            next ? `next ${next}` : null,
          ].filter(Boolean);
          const frequency = [FREQUENCY[r.frequency?.kind] ?? null, STATUS[r.status] ?? null].filter(Boolean).join(', ');
          return (
            <li key={h.id} className="ht-row hd-row">
              <button type="button" className="dv-rowbutton" aria-expanded={opened === h.id} onClick={() => setOpened(opened === h.id ? null : h.id)}>
                <span className="mn-row-main">
                  <span className="dv-name">{`${h.name}${frequency ? ` · ${frequency}` : ''}`}</span>
                  <span className="ov-muted dv-detail">{parts.join(' · ')}</span>
                </span>
              </button>
              {opened === h.id && (
                <HoldingDividends holding={h} dividends={data.holdingDividends} specialParts={data.dividendSpecialParts} accounts={input.accounts} onChanged={data.reload} />
              )}
            </li>
          );
        })}
      </ul>
      {none.holdings.length > 0 && (
        <details className="dv-fold">
          <summary>{none.since ? `No dividends found since ${shortDate(none.since)}` : 'No dividends found'}</summary>
          <p className="ov-muted dv-sub">{names(none.holdings)}</p>
        </details>
      )}
      {failing.length > 0 && (
        <details className="dv-fold">
          <summary>Checks failing</summary>
          <p className="ov-muted dv-sub">{names(failing)}</p>
        </details>
      )}
      {notChecked.length > 0 && (
        <details className="dv-fold">
          <summary>Not checked yet</summary>
          <p className="ov-muted dv-sub">{names(notChecked)}</p>
        </details>
      )}
    </section>
  );
}

// Where the next twelve months come from: each market with what is withheld
// there, and each sector, as short bars.
function Sources({ input, money }) {
  const { markets, sectors } = dividendSources(input);
  const headline = dividendHeadline(input);
  if (markets.length === 0) return null;
  const total = Math.max(1, ...markets.map((m) => m.expectedAed));
  const sectorTotal = Math.max(1, ...sectors.map((x) => x.expectedAed));
  const bar = (value, of) => <span className="dv-bar" style={{ width: `${Math.max(2, (value / of) * 100)}%` }} aria-hidden="true" />;
  return (
    <section className="dv-section" aria-labelledby="dv-sources">
      <h3 className="ov-kicker dv-title" id="dv-sources">
        Where it comes from
      </h3>
      <ul className="dv-bars">
        {markets.map((m) => (
          <li key={m.market}>
            <span>{`${MARKET_NAMES[m.market]} · ${aed(money, m.expectedAed)}${m.withholdingPct !== null ? ` · ${m.withholdingPct}% withheld` : ''}`}</span>
            {bar(m.expectedAed, total)}
          </li>
        ))}
      </ul>
      <ul className="dv-bars">
        {sectors.map((x) => (
          <li key={x.sector}>
            <span>{`${x.sector === 'unknown' ? 'Unknown' : (SECTOR_LABELS[x.sector] ?? x.sector)} · ${aed(money, x.expectedAed)}`}</span>
            {bar(x.expectedAed, sectorTotal)}
          </li>
        ))}
      </ul>
      <Coverage headline={headline} />
    </section>
  );
}

const checkedAt = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// When each market was last checked, what is failing, and what the figures
// here do not claim.
function Freshness({ input }) {
  const markets = feedFreshness(input);
  return (
    <section className="dv-section" aria-labelledby="dv-fresh">
      <h3 className="ov-kicker dv-title" id="dv-fresh">
        How fresh this is
      </h3>
      <ul className="dv-markets">
        {markets.map((m) => (
          <li key={m.market}>
            {`${MARKET_NAMES[m.market]}: ${m.lastSuccessAt ? `checked ${checkedAt(m.lastSuccessAt)}` : 'not checked yet'}${m.coveredFrom ? ` · history from ${shortDate(m.coveredFrom)}` : ''}`}
          </li>
        ))}
        {markets.flatMap((m) =>
          m.failing.map((f) => (
            <li key={`${m.market}-${f.symbol}`} className="ov-warn">
              {`Checks failing for ${f.symbol} since ${f.since ? shortDate(f.since.slice(0, 10)) : 'it was added'}`}
            </li>
          )),
        )}
      </ul>
      <ul className="dv-notes ov-muted">
        <li>{"Dividends from before a holding's opening entry aren't counted: the units held then are unknown."}</li>
        <li>{"Expected figures are a projection at today's units and exchange rates."}</li>
        <li>{"Dividends earned but not yet received aren't in net worth."}</li>
        <li>The Life plan already counts dividends in its return, so this tab is cash flow, not a second return.</li>
      </ul>
    </section>
  );
}
