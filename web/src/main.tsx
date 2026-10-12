import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LangProvider } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthGate } from './AuthGate';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <LangProvider>
        <AuthGate><App /></AuthGate>
      </LangProvider>
    </ErrorBoundary>
  </StrictMode>
);
