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
  const [theme, setThemeState] = useState(() => {
    const initial = getInitialTheme();
    // Set before the first paint, so a light device does not flash dark.
    document.documentElement.setAttribute('data-theme', initial);
    return initial;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Only a choice made in the app is saved; the device's setting is read
  // afresh on each visit until then (fresh review of the revamp's shell).
  const setTheme = (next) => {
    localStorage.setItem(THEME_KEY, next);
    setThemeState(next);
  };
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

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
