import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SessionProvider, useMe, useTheme } from './lib/session';
import { Spinner } from './components/ui';
import { ComposeProvider } from './components/Compose';
import { LoginPage, RegisterPage, ResetPage, SetupPage, ForceTwoFactorPage, ForcePasswordPage, ForgotPage, VerifyRecoveryPage } from './pages/AuthPages';
import { MailLayout } from './pages/MailLayout';
import { AdminLayout } from './pages/admin/AdminLayout';

export function App() {
  const me = useMe();
  const qc = useQueryClient();
  const location = useLocation();
  useTheme(me.data?.user?.prefs.theme, me.data?.instance.accent);

  useEffect(() => {
    const onUnauthorized = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('wren:unauthorized', onUnauthorized);
    window.addEventListener('wren:mfa-required', onUnauthorized);
    return () => {
      window.removeEventListener('wren:unauthorized', onUnauthorized);
      window.removeEventListener('wren:mfa-required', onUnauthorized);
    };
  }, [qc]);

  useEffect(() => {
    if (me.data?.instance.name) document.title = me.data.instance.name;
  }, [me.data?.instance.name]);

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }
  if (me.isError || !me.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-lg font-medium">Can’t reach the server</p>
        <p className="text-sm text-muted">Check your connection and reload the page.</p>
      </div>
    );
  }

  const { user, instance } = me.data;

  if (!instance.setupComplete) {
    return (
      <Routes>
        <Route path="*" element={<SetupPage instance={instance} />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<RegisterPage instance={instance} />} />
        <Route path="/reset" element={<ResetPage instance={instance} />} />
        <Route path="/forgot" element={<ForgotPage instance={instance} />} />
        <Route path="/verify-recovery" element={<VerifyRecoveryPage instance={instance} signedIn={false} />} />
        <Route path="*" element={<LoginPage instance={instance} mfaPending={me.data.mfaPending} next={location.pathname} />} />
      </Routes>
    );
  }

  if (user.mustChangePassword) {
    return <ForcePasswordPage instance={instance} email={user.email} />;
  }

  if (user.mustSetup2fa) {
    return <ForceTwoFactorPage instance={instance} />;
  }

  const isAdmin = user.role === 'admin' || user.role === 'owner';
  return (
    <SessionProvider value={{ user, instance }}>
      <ComposeProvider>
        <Routes>
          <Route path="/login" element={<Navigate to="/inbox" replace />} />
          <Route path="/register" element={<Navigate to="/inbox" replace />} />
          <Route path="/reset" element={<ResetPage instance={instance} />} />
          <Route path="/forgot" element={<Navigate to="/settings/security" replace />} />
          <Route path="/verify-recovery" element={<VerifyRecoveryPage instance={instance} signedIn />} />
          <Route path="/admin/*" element={isAdmin ? <AdminLayout /> : <Navigate to="/inbox" replace />} />
          <Route path="/*" element={<MailLayout />} />
        </Routes>
      </ComposeProvider>
    </SessionProvider>
  );
}
