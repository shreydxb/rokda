import { useState } from 'react';
import { monthKeyLabel } from '../../lib/forecast';
import { Chip, InfoButton } from '../../design-system/kit';
import BasisEditor from './BasisEditor';

// Plan's strip, one line (the revamp, phase 6; design/prototype plan-strip):
// the basis the plan rests on in a few words, with its figures and Change;
// then the scenario, the spending after work and the rates. Why that basis,
// and since when, is behind the basis's (i) (Planning audit, 2.9: a plan
// never passes for a record, nor the records for the plan); what the plan
// assumes beyond the rates is behind theirs. `inputs` is forecastInputs';
// amounts are a month, in today's money.

// The basis in words: a few for the strip, and the whole of it for its (i).
function basisWords(inputs, money) {
  const amount = (v) => `${money.code} ${money.fmt(v)}`;
  const since = inputs.recordsFrom ? ` since ${monthKeyLabel(inputs.recordsFrom)}` : '';
  const n = inputs.monthCount;
  const ended = `the last ${n} ended month${n === 1 ? '' : 's'}${since}`;
  const figures = `spending ${amount(inputs.avgMonthlySpend)} and saving ${amount(inputs.monthlySaving)} a month`;
  const Figures = figures[0].toUpperCase() + figures.slice(1);
  const budgeted = `${inputs.budgetMonths} budgeted month${inputs.budgetMonths === 1 ? '' : 's'}`;
  if (!inputs.ready) {
    const text =
      inputs.basis === 'budget'
        ? `You chose your budget, but no month has a spending budget, and fewer than three months have ended${since} to stand in.`
        : `You chose recorded months, and ${n === 0 ? 'none have' : `${n} of three have`} ended${since}; no month has a spending budget to stand in until then.`;
    return { kind: 'none yet', full: `No basis yet. ${text}` };
  }
  if (inputs.source === 'budget') {
    const chosen = inputs.why === 'chosen';
    let full = `${chosen ? 'Your budget, as you chose.' : 'Your budget, for now.'} ${Figures}, from your spending budget and savings target over ${budgeted}.`;
    if (!chosen) full += ` ${inputs.basis === 'recorded' ? 'You chose recorded months; they' : 'Recorded months'} take over once three have ended${since} · ${n === 0 ? 'none yet' : `${n} so far`}.`;
    // A choice not in effect yet is a status, so it stays in view (the
    // fresh review of the shell).
    return { kind: chosen ? 'your budget' : 'your budget, for now', full, waiting: chosen ? null : `Recorded months: ${n} of 3 ended` };
  }
  if (inputs.why === 'no-budget') {
    return { kind: 'recorded months, for now', full: `Recorded months, for now. You chose your budget, but no month has a spending budget, so ${ended} stand in: ${figures}.` };
  }
  return {
    kind: 'recorded months',
    full: `${inputs.why === 'chosen' ? 'Recorded months, as you chose.' : 'Recorded months.'} The average of ${ended}: ${figures}.${
      inputs.why === 'chosen' ? '' : ' No basis is chosen, so the records took over from your budget once three months had ended.'
    }`,
  };
}

export default function PlanStrip({
  inputs,
  householdId,
  assumptions,
  onSaved,
  money,
  scenarios,
  scenario,
  onScenario,
  spendOptions,
  spendKey,
  onSpend,
  rates,
  assumptionsText = null,
  householdOnly = false,
}) {
  const [editing, setEditing] = useState(false);
  if (!inputs) return null;
  const words = basisWords(inputs, money);
  return (
    <section className="ds-card pl-strip" aria-label="What the plan rests on">
      <div className="pl-strip-row">
        <span className="pl-basis">
          <span className="ds-muted">Basis</span>
          <b>{words.kind}</b>
          {inputs.ready && <span className="pl-ink2">{` · spending ${money.fmt(inputs.avgMonthlySpend)} · saving ${money.fmtBalance(inputs.monthlySaving)} a month`}</span>}
        </span>
        {words.waiting && <Chip>{words.waiting}</Chip>}
        {householdId && (
          <button type="button" className="ds-link ds-link-accent" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
        <InfoButton about="the basis">{words.full}</InfoButton>
        {householdOnly && <Chip>Household</Chip>}
      </div>
      <div className="pl-strip-row">
        <select className="ds-select ds-select-sm" aria-label="Scenario" value={scenario} onChange={(e) => onScenario(e.target.value)}>
          {scenarios.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="ds-select ds-select-sm" aria-label="Spending after work" value={spendKey} onChange={(e) => onSpend(e.target.value)}>
          {spendOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {`${o.label} · ${money.fmtCompact(o.value)} a year`}
            </option>
          ))}
        </select>
        <span className="ds-muted pl-rates">{rates}</span>
        {assumptionsText && <InfoButton about="the assumptions">{assumptionsText}</InfoButton>}
      </div>
      {editing && (
        <BasisEditor
          householdId={householdId}
          assumptions={assumptions}
          recordedMonths={inputs.recordedMonths ?? []}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onSaved?.();
          }}
        />
      )}
    </section>
  );
}
