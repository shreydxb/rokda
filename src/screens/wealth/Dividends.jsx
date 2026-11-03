import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { householdToday } from '../../lib/day';
import { formatMoney } from '../../lib/money';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { dividendRefusalMessage, monthLabel, shortDate } from '../../lib/dividends';
import { buildDividendInput, comingUp, dividendHeadline, feedFreshness, needsYou, spendingEquivalent } from '../../lib/dividendSummary';
import DividendForm from './DividendForm';
import HoldingDividends from './HoldingDividends';
import './HoldingTrades.css';
import './Dividends.css';

// What the tab reads; one that never loaded is said, never shown as none.
const SOURCES = ['holdings', 'holdingDividends', 'holdingTrades', 'dividendEvents', 'dividendSplits', 'dividendSpecialParts', 'dividendFeedStatus', 'accounts'];
const MARKET_NAMES = { IN: 'India', US: 'US' };
const MARKET_ADJECTIVES = { IN: 'Indian', US: 'US' };

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
    <div>
      {neverRun && <p className="ov-muted dv-gap dv-note">{"The dividend feed hasn't run yet. It checks each night."}</p>}
      <Headline input={input} money={money} transactions={data.transactions} />
      <ComingUp input={input} data={data} money={money} />
      <NeedsYou input={input} data={data} />
    </div>
  );
}

const aed = (money, value) => `${money.code} ${money.fmt(value)}`;

function Headline({ input, money, transactions }) {
  const h = dividendHeadline(input);
  const spending = spendingEquivalent(input, { transactions: transactions ?? [], now: new Date() });
  const sinceIn = h.markets.find((m) => m.market === 'IN');
  const sinceUs = h.markets.find((m) => m.market === 'US');
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
            {`${MARKET_NAMES[m.market]}: ${aed(money, m.receivedAed)} received ${m.since ? `since ${shortDate(m.since)}` : 'in the last 12 months'} · ${aed(money, m.expectedAed)} expected`}
          </li>
        ))}
      </ul>
      {h.coverageDiffers && sinceIn?.start && sinceUs?.start && (
        <p className="ov-muted dv-sub">
          {`${MARKET_ADJECTIVES.IN} dividends are counted from ${shortDate(sinceIn.start)}, ${MARKET_ADJECTIVES.US} from ${shortDate(sinceUs.start)}.`}
        </p>
      )}
    </section>
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
