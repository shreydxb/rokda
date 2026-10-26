import { useMoneyDisplay } from '../lib/CurrencyContext';

// Said on the screens that stay in AED whatever the display currency: the
// ledger (Money) and the plans entered in AED (Plan, Goals, Debt payoff).
// Converting a budget or a goal typed in dirhams would show a figure nobody
// entered, and converting past spending needs the rate of its own day, which
// waits on rate history (SHR-321). Without this note, picking USD changed the
// net worth and left income reading as the same number, with no sign which
// was which. Nothing is shown while the display currency is AED.
export default function AedNote({ household }) {
  const money = useMoneyDisplay(household);
  if (money.code === 'AED') return null;
  return (
    <div className="ov-muted" role="note" style={{ marginTop: 6, fontSize: 12 }}>
      Amounts here are in AED, as recorded. The {money.code} display applies to Overview, Wealth and the Life plan.
    </div>
  );
}
