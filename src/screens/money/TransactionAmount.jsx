import { formatMoney } from '../../lib/money';
import { CURRENCIES, currencyAvailable } from '../../lib/currency';
import { estimateNote } from '../../lib/transactionForm';

// Part of the transaction editor (TransactionEditor.jsx), split out with
// the round 2 cleanup (SHR-383).
//
// The amount as it was paid, and in another currency the AED debited, or what
// it is estimated at until that is known (lib/transactionForm.js,
// amountFigures).
export default function TransactionAmount({ form, set, household, figures: { foreign, debited, estimate, amountError } }) {
  return (
    <div>
      <div className="te-hero-label">Amount</div>
      <div className="te-hero-row">
        <select
          className="te-hero-currency te-hero-currency-select"
          aria-label="Currency"
          value={form.entry_currency}
          onChange={(e) => set('entry_currency', e.target.value)}
        >
          {CURRENCIES.filter((code) => currencyAvailable(code, household)).map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <input aria-label="Amount"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          className="te-hero-input"
          value={form.amount}
          onChange={(e) => set('amount', e.target.value)}
          aria-invalid={!!amountError}
          placeholder="0"
        />
      </div>
      {foreign && (
        <div className="te-aed-debited">
          <label className="te-fieldcell">
            <span className="te-fieldlabel">AED debited</span>
            <input
              className="te-fieldvalue"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              aria-label="AED debited"
              value={form.aed_debited}
              onChange={(e) => set('aed_debited', e.target.value)}
              placeholder={estimate ? formatMoney(Math.abs(estimate.aed), { decimals: 2 }) : 'From the statement'}
            />
          </label>
          <div className="ov-muted" style={{ fontSize: 11.5 }}>
            {debited != null
              ? 'The AED that left the account, as the statement shows it. This is what every total counts.'
              : estimate
                ? `Estimated at ${estimateNote(estimate, form.entry_currency)} until you enter the AED debited.`
                : `No ${form.entry_currency} rate for that date. Enter the AED debited.`}
          </div>
        </div>
      )}
    </div>
  );
}
