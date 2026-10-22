import { lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Login from './screens/Login';
import Overview from './screens/Overview';
import SetPassword from './screens/SetPassword';
import TwoStep from './screens/TwoStep';
import AppShell from './shell/AppShell';
import { HouseholdProvider } from './lib/HouseholdContext';
import ProtectedRoute from './shell/ProtectedRoute';
import { useAuth } from './lib/AuthContext';

// Everything used to ship in one chunk, so opening Overview downloaded Money,
// Wealth, Planning and Settings too -- the three biggest trees in the app for
// a screen that renders none of them.
//
// Login and Overview stay eager on purpose. They are the two first paints
// there are: a signed-out visitor needs Login immediately, and Overview is the
// index route, so deferring it would add a round trip to the landing screen
// rather than removing work from it. Splitting pays only where the code is not
// needed yet.
//
// AppShell renders these inside a Suspense boundary, so the nav stays on
// screen while a route's chunk loads instead of the page going blank.
const Money = lazy(() => import('./screens/Money'));
const Wealth = lazy(() => import('./screens/Wealth'));
const Planning = lazy(() => import('./screens/Planning'));
const Settings = lazy(() => import('./screens/Settings'));

export default function App() {
  const { session, recovering, twoStep } = useAuth();

  // Signing in takes a password and a code (docs/decisions.md). Until this
  // session has passed its second step nothing else renders, so no screen,
  // and none of the data hooks behind them, runs a single read at aal1. It
  // comes before a reset link's new password too: Supabase refuses a
  // password change from a member with an authenticator until they have
  // entered its code.
  if (session && twoStep !== 'ok') return <TwoStep />;

  // A reset link signs the person in. They came for a new password, so that
  // is the screen they get, whatever the path, until it is saved or they sign
  // out (docs/decisions.md). Without a session there is nothing to set a
  // password on, and sign-in takes over as usual.
  if (recovering && session) return <SetPassword />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <HouseholdProvider>
              <AppShell />
            </HouseholdProvider>
          </ProtectedRoute>
        }
      >
        <Route index element={<Overview />} />
        <Route path="money" element={<Money />} />
        <Route path="wealth" element={<Wealth />} />
        <Route path="planning" element={<Planning />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
