import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './lib/AuthContext';
import { ThemeProvider } from './lib/ThemeContext';
import { ScopeProvider } from './lib/ScopeContext';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <ScopeProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ScopeProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>
);
