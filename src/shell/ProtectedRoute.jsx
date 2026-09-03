import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export default function ProtectedRoute({ children }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return null; // avoid a flash to /login while the session is resolving
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;

  return children;
}
