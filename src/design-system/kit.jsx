import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDrawerFocus } from '../lib/useDrawerFocus';
import Icon from './Icon';
import './kit.css';

// The shared kit (the revamp, phase 2): the prototype's components
// (design/prototype/styles.css) as React, so every rebuilt screen draws a
// card, a chip or a warning the same way. Screens compose these; they do not
// restyle them.

// A panel with a heading and an optional right-hand link or control. `action`
// marks the one card on a screen that needs doing now (review P18).
export function Card({ title, info, right, action = false, flush = false, className = '', children }) {
  const id = useId();
  return (
    <section className={`ds-card${action ? ' ds-card-action' : ''}${className ? ` ${className}` : ''}`} aria-labelledby={title ? id : undefined}>
      {(title || right) && (
        <div className="ds-card-head">
          {/* The (i) sits beside the heading, not in it, so the card's name
              is its title alone (fresh review of the kit). */}
          {title && (
            <div className="ds-card-title">
              <h2 id={id}>{title}</h2>
              {info}
            </div>
          )}
          {right && <div className="ds-card-right">{right}</div>}
        </div>
      )}
      <div className={flush ? 'ds-card-body ds-card-flush' : 'ds-card-body'}>{children}</div>
    </section>
  );
}

// A row of figures split by hairlines: label, figure, one line under it.
export function KpiStrip({ items }) {
  return (
    <dl className="ds-kpis">
      {items.map((k, i) => (
        <div className="ds-kpi" key={k.id ?? `${i}-${k.label}`}>
          <div className="ds-kpi-label">
            <dt>{k.label}</dt>
            {k.info}
          </div>
          <dd className="ds-kpi-value">
            <span className={`ds-fig${k.tone ? ` ds-${k.tone}` : ''}`}>{k.value}</span>
            {k.sub && <span className="ds-kpi-sub">{k.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// The one status label (review P6): grey for neutral, amber for needs a look,
// red for wrong or late, green for done, iris for a display setting.
export function Chip({ tone = 'neutral', children, title }) {
  return (
    <span className={`ds-chip ds-chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

// One warning (review P7): a dot, a short line, one action. Always in view.
export function WarningRow({ tone = 'warn', action, children }) {
  return (
    <div className={`ds-warn ds-warn-${tone}`}>
      <span className="ds-dot" aria-hidden="true" />
      <span className="ds-warn-text">{children}</span>
      {action &&
        (action.href ? (
          <Link className="ds-btn ds-btn-sm" to={action.href}>
            {action.label}
          </Link>
        ) : (
          <button type="button" className="ds-btn ds-btn-sm" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
    </div>
  );
}

// The small (i) beside a heading or label: the explanation opens in place
// (review P10). Escape or a click elsewhere closes it, and focus returns.
export function InfoButton({ about, children }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const button = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  // Escape is answered here and goes no further, so closing the explanation
  // inside a drawer leaves the drawer open (fresh review of the kit).
  const onKeyDown = (e) => {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      e.nativeEvent?.stopImmediatePropagation?.();
      setOpen(false);
      button.current?.focus();
    }
  };
  return (
    <span
      className="ds-info-wrap"
      ref={wrap}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (open && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button type="button" ref={button} className="ds-info" aria-label={`About ${about}`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        i
      </button>
      {open && (
        <span className="ds-pop" id={id} role="note">
          {children}
        </span>
      )}
    </span>
  );
}

// ‹ Nov 2026 › (review P8): one compact stepper for every month or year.
export function MonthStepper({ label, onPrev, onNext, prevDisabled = false, nextDisabled = false, unit = 'month' }) {
  return (
    <div className="ds-stepper">
      <button type="button" aria-label={`Previous ${unit}`} onClick={onPrev} disabled={prevDisabled}>
        <Icon name="left" />
      </button>
      <span className="ds-stepper-label" aria-live="polite">
        {label}
      </span>
      <button type="button" aria-label={`Next ${unit}`} onClick={onNext} disabled={nextDisabled}>
        <Icon name="right" />
      </button>
    </div>
  );
}

// Two to four choices that switch a view (review P9).
export function Segmented({ label, options, value, onChange, full = false }) {
  return (
    <div className={`ds-seg${full ? ' ds-seg-full' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} data-on={value === o.id || undefined} disabled={o.disabled} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// On or off, saved as it changes (review S-telegram-1).
export function Switch({ label, checked, onChange, disabled = false }) {
  return <button type="button" role="switch" className="ds-switch" aria-label={label} aria-checked={checked} data-on={checked || undefined} disabled={disabled} onClick={() => onChange(!checked)} />;
}

// "▸ Done (4)", always at the end of the list it belongs to (review P19).
export function Fold({ label, count, defaultOpen = false, children }) {
  return (
    <details className="ds-fold" open={defaultOpen || undefined}>
      <summary>{count ? `${label} (${count})` : label}</summary>
      <div className="ds-fold-body">{children}</div>
    </details>
  );
}

// A short title, a body only when it names the next step, one button (P11).
export function EmptyState({ title, body, action }) {
  return (
    <div className="ds-empty">
      <div className="ds-empty-title">{title}</div>
      {body && <div className="ds-empty-body">{body}</div>}
      {action && (
        <button type="button" className="ds-btn ds-btn-primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

// What could not be loaded, and Try again (review P12).
export function Banner({ tone = 'neg', onRetry, children }) {
  return (
    // A failure interrupts; a warning waits its turn.
    <div className={`ds-banner ds-banner-${tone}`} role={tone === 'neg' ? 'alert' : 'status'}>
      <Icon name="alert" />
      <span className="ds-banner-text">{children}</span>
      {onRetry && (
        <button type="button" className="ds-btn ds-btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

// The one editor (review P14): a right-hand modal drawer with a kicker, a
// title, an "Unsaved" chip, optional tabs and a sticky footer. Focus is held
// inside it (lib/useDrawerFocus). `onClose` is the editor's own close, which
// asks before discarding changes (lib/useCloseGuard).
export function Drawer({ kicker, title, dirty = false, tabs, tab, onTab, footer, onClose, onEscape, wide = false, children }) {
  const ref = useDrawerFocus();
  const titleId = useId();
  const tabsId = useId();
  const tabRefs = useRef({});
  // Escape is answered on the drawer itself and stops there: the editor's
  // own step back (onEscape, from useCloseGuard with listen: false) or its
  // close, once, and a drawer underneath is left alone (fresh review of the
  // kit).
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.nativeEvent?.stopImmediatePropagation?.();
    if (onEscape) onEscape(e);
    else onClose?.();
  };
  // Left and right move between the tabs, Home and End to either end; only
  // the chosen tab is in the Tab order.
  const onTabKey = (e) => {
    const ids = tabs.map((t) => t.id);
    const at = ids.indexOf(tab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    const next = ids[(to + ids.length) % ids.length];
    onTab(next);
    tabRefs.current[next]?.focus();
  };
  const tabId = (id) => `${tabsId}-${id}`;
  return (
    <div className="ds-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`ds-drawer${wide ? ' ds-drawer-wide' : ''}`} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="ds-drawer-head">
          <div className="ds-drawer-titles">
            {(kicker || dirty) && (
              <div className="ds-drawer-kicker">
                {kicker}
                {dirty && <Chip tone="warn">Unsaved</Chip>}
              </div>
            )}
            <h2 className="ds-drawer-title" id={titleId}>
              {title}
            </h2>
          </div>
          <button type="button" className="ds-btn ds-btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {tabs && (
          <div className="ds-drawer-tabs" role="tablist" aria-labelledby={titleId}>
            {tabs.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={tabId(t.id)}
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                data-on={tab === t.id || undefined}
                onClick={() => onTab(t.id)}
                onKeyDown={onTabKey}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="ds-drawer-body" role={tabs ? 'tabpanel' : undefined} aria-labelledby={tabs ? tabId(tab) : undefined}>
          {children}
        </div>
        {footer && <div className="ds-drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}

const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10}%`;

// A bar filled to a share, with an optional tick at an amount (the month's
// pace, a usual amount). Over full draws full and says by how much: ARIA
// keeps the value within its range, so the words carry the over (fresh
// review of the kit). A value it cannot read draws nothing.
export function ProgressBar({ label, value, max, tick, tone = 'accent', format = (n) => String(n) }) {
  const v = Number.isFinite(value) ? value : 0;
  const m = Number.isFinite(max) && max > 0 ? max : 0;
  const share = m > 0 ? v / m : 0;
  const over = m > 0 && v > m ? v - m : 0;
  const text = `${format(v)} of ${format(m)}${over > 0 ? `, ${format(over)} over` : ''}`;
  return (
    <div className="ds-bar" role="progressbar" aria-label={label} aria-valuenow={Math.max(0, Math.min(v, m))} aria-valuemin={0} aria-valuemax={m} aria-valuetext={text}>
      <span className={`ds-bar-fill ds-bar-${tone}`} style={{ width: pct(share) }} />
      {tick != null && Number.isFinite(tick) && m > 0 && <span className="ds-bar-tick" style={{ left: pct(tick / m) }} />}
    </div>
  );
}

// One bar in steps of the accent, largest darkest, with a legend in words
// (review P21). Parts worth nothing or less, or that cannot be read, are left
// out; past four, the rest are one "Other", so no two parts share a colour.
export function StackBar({ label, parts }) {
  const shown = parts.filter((p) => Number.isFinite(p.value) && p.value > 0).sort((a, b) => b.value - a.value);
  const grouped = shown.length > 4 ? [...shown.slice(0, 3), { label: 'Other', value: shown.slice(3).reduce((s, p) => s + p.value, 0) }] : shown;
  const total = grouped.reduce((s, p) => s + p.value, 0);
  return (
    <div className="ds-stack-wrap">
      <div className="ds-stack" role="img" aria-label={label}>
        {grouped.map((p, i) => (
          <span key={`${i}-${p.label}`} className={`ds-stack-part ds-c${i + 1}`} style={{ width: pct(total > 0 ? p.value / total : 0) }} />
        ))}
      </div>
      <ul className="ds-legend">
        {grouped.map((p, i) => (
          <li key={`${i}-${p.label}`}>
            <span className={`ds-swatch ds-c${i + 1}`} aria-hidden="true" />
            {`${p.label} ${total > 0 ? Math.round((p.value / total) * 100) : 0}%`}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A ranked list of bars, each scaled to the largest, with an optional tick at
// its usual amount (review S-overview-3).
export function BarList({ items, onSelect }) {
  // A value it cannot read is left out, so one bad row cannot blank the rest
  // (fresh review of the kit).
  const sorted = items.filter((i) => Number.isFinite(i.value)).sort((a, b) => b.value - a.value);
  const top = Math.max(0, ...sorted.map((i) => Math.max(i.value, Number.isFinite(i.usual) ? i.usual : 0)));
  return (
    <ul className="ds-barlist">
      {sorted.map((item) => {
        const body = (
          <>
            <span className="ds-bl-label">{item.label}</span>
            <span className="ds-bl-track">
              <span className="ds-bl-fill" style={{ width: pct(top > 0 ? item.value / top : 0) }} />
               {Number.isFinite(item.usual) && <span className="ds-bl-tick" style={{ left: pct(top > 0 ? item.usual / top : 0) }} />}
            </span>
            <span className="ds-bl-value">{item.display}</span>
          </>
        );
        return (
          <li key={item.id} className={onSelect ? 'ds-bl-row ds-bl-selectable' : 'ds-bl-row'}>
            {onSelect ? (
              <button type="button" className="ds-bl-hit" onClick={() => onSelect(item)}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
