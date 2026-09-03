import { Routes, Route } from 'react-router-dom';
import Login from './screens/Login';
import Overview from './screens/Overview';
import StubScreen from './screens/StubScreen';
import AppShell from './shell/AppShell';
import ProtectedRoute from './shell/ProtectedRoute';

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
        <Route path="money" element={<StubScreen title="Money" />} />
        <Route path="wealth" element={<StubScreen title="Wealth" />} />
        <Route path="planning" element={<StubScreen title="Planning" />} />
        <Route path="settings" element={<StubScreen title="Settings" />} />
      </Route>
    </Routes>
  );
}
