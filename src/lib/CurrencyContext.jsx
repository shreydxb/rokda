import { createContext, useContext, useEffect, useState } from 'react';
import { formatBalance, formatMoney, formatSigned } from './money';
import { CURRENCIES, convertFromAed, currencyAvailable, rateNote } from './currency';

const CurrencyContext = createContext(undefined);
const CURRENCY_KEY = 'rokda:currency';

function getInitialCurrency() {
  const stored = localStorage.getItem(CURRENCY_KEY);
  return CURRENCIES.includes(stored) ? stored : 'AED';
}

// Which currency to *display* figures in — a personal, per-browser
// preference, not household data (that's why it lives in localStorage, not
// the database). The actual conversion rate used lives on the household
// (see lib/currency.js) since that's real shared data.
export function CurrencyProvider({ children }) {
  const [currency, setCurrency] = useState(getInitialCurrency);

  useEffect(() => {
    localStorage.setItem(CURRENCY_KEY, currency);
  }, [currency]);

  return <CurrencyContext.Provider value={{ currency, setCurrency }}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (ctx === undefined) throw new Error('useCurrency must be used within a CurrencyProvider');
  return ctx;
}

// Combines the selected display currency with a household's real rate data
// to produce ready-to-use formatters. Falls back to AED (with `fallback:
// true`) when the chosen currency isn't available yet, rather than
// guessing a conversion — callers can use that to grey out a UI toggle.
export function useMoneyDisplay(household) {
  const { currency, setCurrency } = useCurrency();
  const available = currencyAvailable(currency, household);
  const code = available ? currency : 'AED';

  function fmt(amountAed, opts) {
    const converted = convertFromAed(amountAed, code, household);
    return formatMoney(converted ?? amountAed, opts);
  }
  // Sign-preserving display for figures that can go negative — net worth,
  // savings, balances. `fmt` stays a magnitude formatter (QA-08).
  function fmtBalance(amountAed, opts) {
    const converted = convertFromAed(amountAed, code, household);
    return formatBalance(converted ?? amountAed, opts);
  }
  function fmtSigned(amountAed, opts) {
    const converted = convertFromAed(amountAed, code, household);
    return formatSigned(converted ?? amountAed, opts);
  }

  return { currency, setCurrency, code, fallback: !available, fmt, fmtBalance, fmtSigned, rateNote: rateNote(code, household) };
}
