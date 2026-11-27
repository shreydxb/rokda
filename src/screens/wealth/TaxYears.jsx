import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { supabase } from '../../lib/supabaseClient';
import { householdToday } from '../../lib/day';
import { formatMoney } from '../../lib/money';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { shortDate } from '../../lib/dividends';
import { dividendsInYear, financialYearOf, taxRefusalMessage, taxYearLabel, taxYears } from '../../lib/dividendTax';
import { checkWords, eventLine, returnLines, shareLines, stageWords, taxYearCells, unassignedWords } from '../../lib/dividendTaxText';
import { Avatar, Card, Chip, Drawer, EmptyState, InfoButton } from '../../design-system/kit';
import TaxReturnForm from './TaxReturnForm';
import TaxEventForm from './TaxEventForm';

// What the view reads; one that never loaded is said, and Income goes on
// without it.
// The years are built from the holdings and their dividends as well as the
// tax records: with those unread, every statement line read as a difference
// against no dividends (the review of the whole revamp).
const TAX_SOURCES = ['taxReturns', 'taxReturnEvents', 'taxStatements', 'taxStatementLines', 'holdings', 'holdingDividends'];
const fmt = (n) => `INR ${formatMoney(n, { decimals: 2 })}`;
const paise = (n) => Math.round(Number(n) * 100);
const BASES = [
  ['declared', 'Declared that year (a final dividend)'],
  ['paid', 'Paid that year (an interim dividend)'],
  ['statement', 'A statement says so'],
  ['household', 'Our own reading'],
];

// The year's dividends and tax withheld, the presumed part beside, under
// the drawer's "Dividends".
function dividendWords(year) {
  const { confirmed, presumed } = year.rokda;
  if (confirmed.count + presumed.count === 0) return 'None recorded';
  const gross = (paise(confirmed.gross) + paise(presumed.gross)) / 100;
  const tax = (paise(confirmed.tax) + paise(presumed.tax)) / 100;
  let words = `${fmt(gross)}, tax withheld ${fmt(tax)}`;
  if (presumed.count) words += ` (${fmt(presumed.tax)} of it presumed)`;
  return year.provisional ? `${words}, provisional` : words;
}

// Wealth -> Dividends -> Tax years (dividend tax years, spec section 6; the
// revamp, phase 5c, design/prototype taxView): each member's Indian
// dividends by tax year, in rupees, checked against the AIS and Form 26AS,
// one row a year in a table. A year opens in the kit's drawer, which holds
// everything the app shows of it (decision 3): where it stands, each share
// against both statements with its dividends and their tax years, the
// return, and what became of its refund. The figures come from
// src/lib/dividendTax.js, the words from dividendTaxText.js.
export default function TaxYears({ members, scopeMemberId, data }) {
  const [openKey, setOpenKey] = useState(null);
  // The forms open in the year's drawer (the return, a refund record, a
  // dividend's tax year): unsaved work, so closing the drawer asks first,
  // as an editor's does (the fresh review of 5c).
  const [forms, setForms] = useState(() => new Set());
  const onFormOpen = useCallback((key, isOpen) => {
    setForms((prev) => {
      if (prev.has(key) === isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const closeYear = () => {
    setOpenKey(null);
    setForms(new Set());
  };
  const { confirmingClose, requestClose, keepEditing, escapeKey } = useCloseGuard({ dirty: forms.size > 0, onClose: closeYear, listen: false });
  const missing = neverLoaded(data, TAX_SOURCES);
  const { years, unassigned } = useMemo(
    () => taxYears({
      holdings: data.holdings ?? [], dividends: data.holdingDividends ?? [], statements: data.taxStatements ?? [], lines: data.taxStatementLines ?? [],
      returns: data.taxReturns ?? [], events: data.taxReturnEvents ?? [],
    }),
    [data.holdings, data.holdingDividends, data.taxStatements, data.taxStatementLines, data.taxReturns, data.taxReturnEvents],
  );
  const shown = scopeMemberId ? years.filter((y) => y.memberId === scopeMemberId) : years;
  const at = (id) => members.findIndex((m) => m.id === id);
  const nameOf = (id) => members[at(id)]?.display_name ?? 'A member';
  const shared = unassignedWords(unassigned);
  const keyOf = (y) => `${y.memberId}-${y.year}`;
  const opened = openKey ? shown.find((y) => keyOf(y) === openKey) : null;

  if (missing.length) {
    return (
      <Card>
        <p className="ov-warn dv-note" role="alert">
          {couldntLoad(missing)} Refresh the page to try again.
        </p>
      </Card>
    );
  }
  if (shown.length === 0 && !shared) {
    return (
      <Card>
        <EmptyState title="No tax years in this view" body="Indian dividends appear here by tax year once an Indian share pays." />
      </Card>
    );
  }
  return (
    <>
      <Card
        title="Indian dividends by tax year"
        info={<InfoButton about="Indian dividends by tax year">Checked against the AIS (income) and Form 26AS (tax credit). In rupees.</InfoButton>}
        flush
      >
        {shown.length > 0 && (
          <div className="ds-table-wrap">
            <table className="ds-table tx-table">
              <thead>
                <tr>
                  <th scope="col">Tax year</th>
                  <th scope="col">Member</th>
                  <th scope="col" className="ds-num">
                    Dividends
                  </th>
                  <th scope="col" className="ds-num">
                    Tax withheld
                  </th>
                  <th scope="col">Against AIS and 26AS</th>
                  <th scope="col">Return</th>
                  <th scope="col">Refund</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((y) => {
                  const c = taxYearCells(y, fmt);
                  const name = nameOf(y.memberId);
                  return (
                    <tr key={keyOf(y)} className="tx-row" data-open onClick={(e) => !e.target.closest('button') && setOpenKey(keyOf(y))}>
                      <td>
                        <span className="tx-year">
                          {/* The row opens on a click; its year is the button
                              that opens it from the keyboard. */}
                          <button type="button" className="tx-open" onClick={() => setOpenKey(keyOf(y))}>
                            {y.label}
                          </button>
                          {y.provisional && <Chip>Provisional</Chip>}
                        </span>
                      </td>
                      <td>
                        <span className="tx-member">
                          <Avatar name={name} initial={name.slice(0, 1).toUpperCase()} tone={at(y.memberId) === 0 ? 'a' : 'b'} />
                          {name}
                        </span>
                      </td>
                      <td className="ds-num">{c.dividends ?? '—'}</td>
                      <td className="ds-num">{c.tax ?? '—'}</td>
                      <td>
                        <Chip tone={c.check.tone}>{c.check.label}</Chip>
                      </td>
                      <td className="tx-ink2">{c.ret}</td>
                      <td className="tx-ink2">{c.refund ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="tx-notes">
          {shared && <p className="dv-note tx-ink3">{shared}</p>}
          <p className="dv-note tx-ink3">{"A holding's dividends count for its owner today: changing its owner moves them."}</p>
        </div>
      </Card>
      {opened && (
        <Drawer
          kicker={`Tax year · ${nameOf(opened.memberId)}`}
          title={opened.label}
          wide
          onClose={requestClose}
          onEscape={escapeKey}
          footer={
            confirmingClose ? (
              <DiscardPrompt onDiscard={closeYear} onKeepEditing={keepEditing} />
            ) : (
              <button type="button" className="ds-btn" onClick={requestClose}>
                Close
              </button>
            )
          }
        >
          <dl className="tx-kv">
            <dt>Dividends</dt>
            <dd>{dividendWords(opened)}</dd>
            <dt>Against AIS and 26AS</dt>
            <dd>{checkWords(opened)}</dd>
            <dt>Where it stands</dt>
            <dd>{stageWords(opened, fmt)}</dd>
          </dl>
          <YearDetail key={keyOf(opened)} year={opened} data={data} onFormOpen={onFormOpen} />
        </Drawer>
      )}
    </>
  );
}

function YearDetail({ year, data, onFormOpen }) {
  const [editing, setEditing] = useState(null);
  useFormReport(onFormOpen, 'year', editing !== null);
  const [removing, setRemoving] = useState(null);
  const [refusal, setRefusal] = useState(null);
  // Focus goes back where it came from: to the button that opened a form,
  // or, from the remove question, to "Keep it" and then back to Remove.
  const buttonsRef = useRef({});
  const returnToRef = useRef(null);
  const focusNextRef = useFocusAfterRender(buttonsRef);
  const taxReturn = year.taxReturn;
  const filed = Number(taxReturn?.revision ?? 0) >= 1;
  const events = (data.taxReturnEvents ?? []).filter((e) => e.return_id === taxReturn?.id);
  const interest = events.some((e) => e.kind === 'processed' && Number(e.refund_interest) > 0);

  const open = (value, key) => {
    returnToRef.current = key;
    setEditing(value);
  };
  const close = () => {
    focusNextRef.current = returnToRef.current;
    setEditing(null);
  };
  async function saved() {
    await data.reload();
    close();
  }

  async function remove(event) {
    setRefusal(null);
    const { data: result, error } = await supabase.rpc('remove_tax_return_event', { p_member_id: year.memberId, p_event_id: event.id, p_expected_version: event.version });
    setRemoving(null);
    focusNextRef.current = 'add';
    if (error || !result?.ok) {
      setRefusal({ id: event.id, message: error ? `Couldn't remove that: ${error.message}. Nothing was changed.` : taxRefusalMessage(result?.error) });
      return;
    }
    await data.reload();
  }

  return (
    <div className="tx-detail">
      {year.shares.length > 0 && (
        <>
          <h4 className="te-fieldlabel tx-subtitle">Shares</h4>
          <ul className="ht-list">
            {year.shares.map((s) => {
              const lines = shareLines(s, fmt);
              const own = dividendsInYear({ holdings: data.holdings, dividends: data.holdingDividends, memberId: year.memberId, year: year.year, key: s.key });
              return (
                <li key={s.key} className="ht-row hd-row">
                  <div className="mn-row-main">
                    <div className="dv-name">{s.name}</div>
                    <div className="ov-muted dv-detail">{lines.income}</div>
                    <div className="ov-muted dv-detail">{lines.tax}</div>
                  </div>
                  {own.length > 0 && (
                    <details className="dv-fold">
                      <summary>{`Dividends (${own.length})`}</summary>
                      <ul className="ht-list">
                        {own.map((d) => (
                          <DividendYearRow key={d.id} dividend={d} onSaved={data.reload} onFormOpen={onFormOpen} />
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h4 className="te-fieldlabel tx-subtitle">Return</h4>
      {editing === 'return' ? (
        <TaxReturnForm memberId={year.memberId} year={year.year} taxReturn={taxReturn} onSaved={saved} onCancel={close} />
      ) : (
        <div className="tx-lines">
          {returnLines(taxReturn, fmt).map((line) => (
            <div key={line} className="ov-muted dv-detail">
              {line}
            </div>
          ))}
          <div className="ht-actions hd-actions">
            <button type="button" className="om-btn" ref={(el) => (buttonsRef.current.return = el)} onClick={() => open('return', 'return')}>
              {taxReturn ? 'Edit' : 'Set claim basis'}
            </button>
          </div>
        </div>
      )}

      {filed && (
        <>
          <h4 className="te-fieldlabel tx-subtitle">What happened to the refund</h4>
          {events.length > 0 && (
            <ul className="ht-list">
              {events.map((ev) => (
                <li key={ev.id} className="ht-row hd-row">
                  {editing === ev.id ? (
                    <TaxEventForm memberId={year.memberId} year={year.year} taxReturn={taxReturn} event={ev} onSaved={saved} onCancel={close} />
                  ) : (
                    <>
                      <div className="mn-row-main">{eventLine(ev, taxReturn, fmt)}</div>
                      {refusal?.id === ev.id && (
                        <p className="ov-warn tx-hint" role="alert">
                          {refusal.message}
                        </p>
                      )}
                      {removing === ev.id ? (
                        <div className="ht-actions hd-actions">
                          <span className="tx-hint">Remove this record?</span>
                          <button
                            type="button"
                            className="om-btn"
                            ref={(el) => (buttonsRef.current[`keep-${ev.id}`] = el)}
                            onClick={() => {
                              focusNextRef.current = `remove-${ev.id}`;
                              setRemoving(null);
                            }}
                          >
                            Keep it
                          </button>
                          <button type="button" className="om-btn te-delete" onClick={() => remove(ev)}>
                            Remove
                          </button>
                        </div>
                      ) : (
                        <div className="ht-actions hd-actions">
                          <button type="button" className="om-btn" ref={(el) => (buttonsRef.current[`fix-${ev.id}`] = el)} onClick={() => open(ev.id, `fix-${ev.id}`)}>
                            Fix
                          </button>
                          <button
                            type="button"
                            className="om-btn"
                            ref={(el) => (buttonsRef.current[`remove-${ev.id}`] = el)}
                            onClick={() => {
                              focusNextRef.current = `keep-${ev.id}`;
                              setRemoving(ev.id);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editing === 'add' ? (
            <TaxEventForm memberId={year.memberId} year={year.year} taxReturn={taxReturn} event={null} onSaved={saved} onCancel={close} />
          ) : (
            <div className="ht-actions hd-actions">
              <button type="button" className="om-btn" ref={(el) => (buttonsRef.current.add = el)} onClick={() => open('add', 'add')}>
                Add
              </button>
            </div>
          )}
          {interest && <p className="ov-muted tx-hint">{"Refund interest is income of the year it arrives: include it in that year's return."}</p>}
        </>
      )}
    </div>
  );
}

// One dividend counted in the year, and where its year can be set: a final
// dividend declared in March and paid in April belongs to the March year.
function DividendYearRow({ dividend, onSaved, onFormOpen }) {
  const received = dividend.status === 'received';
  const creditYear = financialYearOf(dividend.credited_on);
  const latest = financialYearOf(householdToday());
  const [form, setForm] = useState(null);
  useFormReport(onFormOpen, `dividend-${dividend.id}`, form !== null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const buttonsRef = useRef({});
  const focusNextRef = useFocusAfterRender(buttonsRef);
  const own = dividend.tax_financial_year;
  const close = () => {
    focusNextRef.current = 'set';
    setForm(null);
  };
  let line = `${shortDate(dividend.credited_on)} · ${fmt(received ? dividend.received_gross : dividend.expected_gross)}, tax ${fmt(received ? dividend.received_tax : dividend.expected_tax)} · ${received ? 'Received' : 'Presumed'}`;
  if (own != null) line += ` · counted in ${taxYearLabel(own)}`;

  async function save(year, basis) {
    setBusy(true);
    setMessage('');
    const { data, error } = await supabase.rpc('set_dividend_tax_year', {
      p_dividend_id: dividend.id, p_financial_year: year, p_basis: basis, p_expected_version: form.version,
    });
    setBusy(false);
    if (error || !data?.ok) {
      setMessage(error ? `Couldn't save that: ${error.message}. Nothing was changed.` : taxRefusalMessage(data?.error));
      return;
    }
    close();
    await onSaved();
  }

  return (
    <li className="ht-row hd-row">
      <div className="mn-row-main ov-muted dv-detail">{line}</div>
      {form ? (
        // Escape steps back out of the form only, not the drawer around it.
        <div
          className="ht-form"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        >
          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={`${dividend.id}-year`}>
                Tax year
              </label>
              <select id={`${dividend.id}-year`} ref={(el) => (buttonsRef.current.year = el)} className="te-fieldvalue" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })}>
                {[creditYear - 1, creditYear, creditYear + 1].filter((y) => y <= latest).map((y) => (
                  <option key={y} value={String(y)}>
                    {taxYearLabel(y)}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={`${dividend.id}-basis`}>
                Why
              </label>
              <select id={`${dividend.id}-basis`} className="te-fieldvalue" value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })}>
                {BASES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {message && (
            <p className="ov-warn tx-hint" role="alert">
              {message}
            </p>
          )}
          <div className="ht-form-actions">
            <button type="button" className="om-btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            {own != null && (
              <button type="button" className="om-btn" onClick={() => save(null, null)} disabled={busy}>
                {"Use the credit date's year"}
              </button>
            )}
            <button type="button" className="om-btn ov-btn-primary" onClick={() => save(Number(form.year), form.basis)} disabled={busy}>
              Save tax year
            </button>
          </div>
        </div>
      ) : (
        <div className="ht-actions hd-actions">
          <button
            type="button"
            className="om-btn"
            ref={(el) => (buttonsRef.current.set = el)}
            onClick={() => {
              focusNextRef.current = 'year';
              // The version as opened: a refresh while the form is open
              // brings a partner's change, which a save must not overwrite
              // (the fresh review of round 2; E2-1 for refund records).
              setForm({ year: String(own ?? creditYear), basis: dividend.tax_year_basis ?? 'declared', version: dividend.version });
            }}
          >
            Set tax year
          </button>
        </div>
      )}
    </li>
  );
}

// Tells the drawer whether a form of its is open, and that it isn't once it
// is gone.
function useFormReport(onFormOpen, key, isOpen) {
  useEffect(() => {
    onFormOpen?.(key, isOpen);
  }, [onFormOpen, key, isOpen]);
  useEffect(() => () => onFormOpen?.(key, false), [onFormOpen, key]);
}

// Moves focus, after the next render, to the control named in the returned
// ref (one of buttonsRef.current's keys): a control that was just mounted, so it
// can't be focused before React has drawn it.
function useFocusAfterRender(buttonsRef) {
  const focusNextRef = useRef(null);
  useLayoutEffect(() => {
    const key = focusNextRef.current;
    if (key && buttonsRef.current[key]) {
      buttonsRef.current[key].focus();
      focusNextRef.current = null;
    }
  });
  return focusNextRef;
}
