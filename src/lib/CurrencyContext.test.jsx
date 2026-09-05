import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CurrencyProvider, useCurrency, useMoneyDisplay } from './CurrencyContext';
import { act } from 'react';

const HOUSEHOLD = { inr_per_aed: 23.2, inr_rate_set_at: '2026-09-01T00:00:00Z' };

function useMoneyWithSwitch() {
  const { setCurrency } = useCurrency();
  return { money: useMoneyDisplay(HOUSEHOLD), setCurrency };
}

// QA-08 at the actual call site: screens format through useMoneyDisplay, so
// the currency-aware wrapper has to preserve the sign too.
describe('useMoneyDisplay sign handling', () => {
  it('shows a negative net worth with a minus in AED, USD and INR', () => {
    const { result } = renderHook(() => useMoneyWithSwitch(), { wrapper: CurrencyProvider });

    for (const code of ['AED', 'USD', 'INR']) {
      act(() => result.current.setCurrency(code));
      expect(result.current.money.code).toBe(code);
      expect(result.current.money.fmtBalance(-100)).toMatch(/^−/);
      expect(result.current.money.fmtBalance(-100)).not.toMatch(/−.*−/);
    }
  });

  it('keeps fmt as a magnitude formatter for UI that supplies its own sign', () => {
    const { result } = renderHook(() => useMoneyWithSwitch(), { wrapper: CurrencyProvider });
    expect(result.current.money.fmt(-100)).not.toMatch(/−/);
  });
});
