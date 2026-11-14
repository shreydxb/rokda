import { createContext, useContext, useEffect, useState } from 'react';

const ThemeContext = createContext(undefined);
const THEME_KEY = 'rokda:theme';

function getInitialTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  // The revamp (November 2026): a first visit follows the device's setting;
  // the choice made in the app is stored and wins from then on.
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (ctx === undefined) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
