import { BrowserRouter, Routes, Route, Outlet, Navigate } from 'react-router-dom';
import { ResultsSocketProvider } from '@/lib/ResultsSocketContext';
import { HealthProvider } from '@/lib/HealthContext';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import Sidebar from '@/app/components/Sidebar';
import TopBar from '@/app/components/TopBar';
import ActiveTests from '@/app/components/ActiveTests';
import WorkerHealth from '@/app/components/WorkerHealth';
import SystemHealth from '@/app/components/SystemHealth';
import AIStatus from '@/app/components/AIStatus';
import { lazy, Suspense, useState } from 'react';

const HomePage         = lazy(() => import('@/app/page'));
const ChatPage         = lazy(() => import('@/app/chat/page'));
const ResultsPage      = lazy(() => import('@/app/results/page'));
const ResultDetailPage = lazy(() => import('@/app/results/testId/page'));
const ComparePage      = lazy(() => import('@/app/results/compare/page'));
const PresetsPage      = lazy(() => import('@/app/presets/page'));
const LibraryPage      = lazy(() => import('@/app/library/page'));
const SchedulesPage    = lazy(() => import('@/app/schedules/page'));
const WebhooksPage     = lazy(() => import('@/app/webhooks/page'));
const TeamPage         = lazy(() => import('@/app/team/page'));
const OrgPage          = lazy(() => import('@/app/org/page'));
const LoginPage        = lazy(() => import('@/app/login/page'));

function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RootLayout() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-bg text-tx font-sans">
      {menuOpen && (
        <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-40 bg-black/45 md:hidden" />
      )}
      <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar onMenuClick={() => setMenuOpen(true)} />
        <ActiveTests />
        <WorkerHealth />
        <AIStatus />
        <SystemHealth />
        <main className="flex-1">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ResultsSocketProvider>
        <HealthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Suspense fallback={null}><LoginPage /></Suspense>} />
              <Route element={<AuthGate />}>
                <Route element={<RootLayout />}>
                  <Route path="/"                element={<HomePage />} />
                  <Route path="/chat"            element={<ChatPage />} />
                  <Route path="/results"         element={<ResultsPage />} />
                  <Route path="/results/compare" element={<ComparePage />} />
                  <Route path="/results/:testId" element={<ResultDetailPage />} />
                  <Route path="/presets"         element={<PresetsPage />} />
                  <Route path="/library"         element={<LibraryPage />} />
                  <Route path="/schedules"       element={<SchedulesPage />} />
                  <Route path="/webhooks"        element={<WebhooksPage />} />
                  <Route path="/team"            element={<TeamPage />} />
                  <Route path="/org"             element={<OrgPage />} />
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </HealthProvider>
      </ResultsSocketProvider>
    </AuthProvider>
  );
}
