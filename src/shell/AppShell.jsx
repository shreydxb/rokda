import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTheme } from '../lib/ThemeContext';
import { useScope } from '../lib/ScopeContext';
import './AppShell.css';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/money', label: 'Money' },
  { to: '/wealth', label: 'Wealth' },
  { to: '/planning', label: 'Planning' },
];

const SCOPES = [
  { id: 'both', label: 'Both' },
  { id: 'me', label: 'Me' },
  { id: 'partner', label: 'Aparna' },
];

export default function AppShell() {
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { scope, setScope } = useScope();

  return (
    <div className="om-shellwrap">
      <div className="om-shell">
        <aside className="om-side">
          <div className="om-brand">Rokda</div>

          <nav className="om-nav-list">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className="om-nav"
              >
                {item.label}
              </NavLink>
            ))}
            <NavLink to="/settings" className="om-nav om-nav-settings">
              Settings
            </NavLink>
          </nav>

          <div className="om-scopewrap">
            <div className="om-scopelabel">Household</div>
            <div className="om-scope-list" role="group" aria-label="Household scope">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="om-scope"
                  data-active={scope === s.id}
                  onClick={() => setScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="om-sidefoot">
            <button type="button" className="om-themetoggle" onClick={toggleTheme}>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button type="button" className="om-signout" onClick={signOut}>
              <span>{user?.email}</span>
              <span>Sign out</span>
            </button>
          </div>
        </aside>

        <main className="om-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
