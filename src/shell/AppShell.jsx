import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTheme } from '../lib/ThemeContext';
import { ScopeFromLink, useScope } from '../lib/ScopeContext';
import { useHousehold } from '../lib/useHousehold';
import { useMoneyDisplay } from '../lib/CurrencyContext';
import { CURRENCIES, currencyAvailable } from '../lib/currency';
import Icon from '../design-system/Icon';
import { useInboxCount } from './useInboxCount';
import './AppShell.css';

// The revamp (November 2026, design/prototype): Inbox is its own item, with
// its count, because it is the queue worked every day (review N1). Until it
// has a page of its own it opens Money's Inbox tab, and is the item marked
// current there instead of Money.
const NAV = [
  { to: '/', label: 'Overview', icon: 'home', end: true },
  { to: '/money?tab=inbox', label: 'Inbox', icon: 'inbox', inbox: true },
  { to: '/money', label: 'Money', icon: 'wallet' },
  { to: '/wealth', label: 'Wealth', icon: 'chart' },
  { to: '/planning', label: 'Planning', icon: 'compass' },
];

export default function AppShell() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { scope, setScope } = useScope();
  const { household, me, members } = useHousehold();
  const { currency, setCurrency } = useMoneyDisplay(household);
  const inboxCount = useInboxCount(household?.id);
  const location = useLocation();
  const onInbox = location.pathname === '/money' && new URLSearchParams(location.search).get('tab') === 'inbox';
  const partnerLabel = members.find((m) => m.id !== me?.id)?.display_name ?? 'Partner';
  const scopes = [
    { id: 'both', label: 'Both' },
    { id: 'me', label: 'Me' },
    { id: 'partner', label: partnerLabel },
  ];
  // On a phone the household switch and the account fold behind one button
  // that says what is chosen, so the page starts near the top of the screen.
  // On a desktop they are always open.
  const [controlsOpen, setControlsOpen] = useState(false);
  const scopeLabel = scopes.find((s) => s.id === scope)?.label ?? 'Both';

  // Display currency, light or dark and sign-out: changed rarely, so they sit
  // in one menu at the foot of the sidebar (review N10).
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef(null);
  const accountButtonRef = useRef(null);
  const menuRef = useRef(null);
  // Focus goes to the menu's first choice as it opens (fresh review of the
  // revamp's shell); Escape closes it and hands focus back to its button.
  useEffect(() => {
    if (accountOpen) menuRef.current?.querySelector('button:not(:disabled)')?.focus();
  }, [accountOpen]);
  useEffect(() => {
    if (!accountOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setAccountOpen(false);
        accountButtonRef.current?.focus();
      }
    };
    const onDown = (e) => {
      if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [accountOpen]);

  const name = me?.display_name ?? user?.email ?? '';
  // Which item is current is worked out here rather than by NavLink, which
  // does not read the address's query and so marked Money current on its
  // Inbox tab as well.
  const isCurrent = (item) => {
    if (item.inbox) return onInbox;
    if (item.end) return location.pathname === item.to;
    const path = item.to.split('?')[0];
    const here = location.pathname === path || location.pathname.startsWith(`${path}/`);
    return here && !(path === '/money' && onInbox);
  };

  return (
    <div className="om-shellwrap">
      <ScopeFromLink />
      <div className="om-shell">
        <aside className="om-side">
          <div className="om-brand">
            <span className="om-brand-mark">
              <Icon name="mark" />
            </span>
            Rokda
          </div>

          <button
            type="button"
            className="om-sidetoggle"
            aria-expanded={controlsOpen}
            aria-controls="om-sidecontrols om-sidefoot"
            onClick={() => setControlsOpen((open) => !open)}
          >
            {scopeLabel} · {currency}
            <span aria-hidden="true">{controlsOpen ? '▴' : '▾'}</span>
          </button>

          <div className="om-sidecontrols om-sidescope" id="om-sidecontrols" data-open={controlsOpen}>
            <div className="om-scopelabel">Showing</div>
            <div className="om-segment om-scope-list" role="group" aria-label="Household scope">
              {scopes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="om-scope"
                  data-active={scope === s.id}
                  // Said, not only shown: data-active is the look, and a
                  // screen reader announces aria-pressed (round 2 of the
                  // outside review, E2-8).
                  aria-pressed={scope === s.id}
                  onClick={() => setScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <nav className="om-nav-list">
            {NAV.map((item) => (
              <Link key={item.label} to={item.to} className={`om-nav${isCurrent(item) ? ' active' : ''}`} aria-current={isCurrent(item) ? 'page' : undefined} onClick={() => setControlsOpen(false)}>
                <Icon name={item.icon} />
                {item.label}
                {item.inbox && inboxCount > 0 && (
                  <span className="om-nav-count">
                    {inboxCount > 99 ? '99+' : inboxCount}
                    <span className="om-sr"> waiting</span>
                  </span>
                )}
              </Link>
            ))}
            <Link
              to="/settings"
              className={`om-nav om-nav-settings${isCurrent({ to: '/settings' }) ? ' active' : ''}`}
              aria-current={isCurrent({ to: '/settings' }) ? 'page' : undefined}
              onClick={() => setControlsOpen(false)}
            >
              <Icon name="settings" />
              Settings
            </Link>
          </nav>

          {/* The menu comes after its button in the page, so Tab moves on into
              it; CSS places it above. It closes once focus leaves it. */}
          <div
            className="om-sidefoot"
            id="om-sidefoot"
            ref={accountRef}
            data-open={controlsOpen}
            onBlur={(e) => {
              if (accountOpen && !accountRef.current?.contains(e.relatedTarget)) setAccountOpen(false);
            }}
          >
            <button
              type="button"
              ref={accountButtonRef}
              className="om-acct"
              aria-label={`Account: ${name}${household?.name ? `, ${household.name}` : ''}`}
              aria-expanded={accountOpen}
              aria-haspopup="dialog"
              onClick={() => setAccountOpen((open) => !open)}
            >
              <span className="om-avatar" aria-hidden="true">
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span className="om-acct-text">
                <span className="om-acct-name">{name}</span>
                <span className="om-acct-sub">{household?.name}</span>
              </span>
              <Icon name="down" />
            </button>
            {accountOpen && (
              <div className="om-menu" role="dialog" aria-label="Account" ref={menuRef}>
                <div className="om-menu-label">Display currency</div>
                <div className="om-segment om-scope-list" role="group" aria-label="Display currency">
                  {CURRENCIES.map((c) => {
                    const enabled = currencyAvailable(c, household);
                    return (
                      <button
                        key={c}
                        type="button"
                        className="om-scope"
                        data-active={currency === c}
                        aria-pressed={currency === c}
                        disabled={!enabled}
                        title={enabled ? undefined : 'Set an INR rate in Settings → Household first'}
                        onClick={() => setCurrency(c)}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
                <div className="om-menu-label">Theme</div>
                <div className="om-segment om-scope-list" role="group" aria-label="Theme">
                  {[
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                  ].map(([id, label]) => (
                    <button key={id} type="button" className="om-scope" data-active={theme === id} aria-pressed={theme === id} onClick={() => setTheme(id)}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="om-menu-sep" />
                <div className="om-menu-who">{user?.email}</div>
                <button type="button" className="om-menu-item" onClick={signOut}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="om-main">
          {/* The lazily loaded routes land here (see App.jsx). The shell --
              nav, scope and currency pickers -- stays rendered while a chunk
              arrives, so switching tabs shows the same skeleton the screens
              use for their own loading rather than an empty page. */}
          <Suspense fallback={<div className="ov-skel" aria-busy="true" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
