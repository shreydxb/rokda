import { lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Login from './screens/Login';
import Overview from './screens/Overview';
import AppShell from './shell/AppShell';
import ProtectedRoute from './shell/ProtectedRoute';

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
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppShell />
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
