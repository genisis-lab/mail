import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ToastProvider } from './components/toast';
import { ACCOUNT_BASE, URL_ACCOUNT } from './lib/accounts';
import { setApiAccount } from './lib/api';
import { registerServiceWorker } from './lib/pwa';
import './styles.css';

registerServiceWorker();
// /u/<id>/… is one of the accounts added after the first: this tab acts as it.
setApiAccount(URL_ACCOUNT);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, err: any) => count < 2 && !(err?.status >= 400 && err?.status < 500), refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={ACCOUNT_BASE || undefined}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
