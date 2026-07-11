import { createBrowserRouter, RouterProvider, Outlet, Navigate } from 'react-router-dom';
import { ResultsSocketProvider } from '@/lib/ResultsSocketContext';
import { HealthProvider } from '@/lib/HealthContext';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { WorkspaceProvider } from '@/lib/WorkspaceContext';
import Sidebar from '@/app/components/Sidebar';
import TopBar from '@/app/components/TopBar';
import ActiveTests from '@/app/components/ActiveTests';
import WorkerHealth from '@/app/components/WorkerHealth';
import SystemHealth from '@/app/components/SystemHealth';
import AIStatus from '@/app/components/AIStatus';
import ErrorBoundary, { RouteErrorBoundary } from '@/app/components/ErrorBoundary';
import Skeleton from '@/app/components/Skeleton';
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
const WorkspacesPage   = lazy(() => import('@/app/workspaces/page'));
const SettingsPage     = lazy(() => import('@/app/settings/page'));
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
        {/* Sticky so worker status / running-test info stays visible while scrolling long pages */}
        <div className="sticky top-0 z-20 bg-bg">
          <TopBar onMenuClick={() => setMenuOpen(true)} />
          <ActiveTests />
          <WorkerHealth />
        </div>
        <AIStatus />
        <SystemHealth />
        <main className="flex-1">
          <Suspense fallback={<div className="p-5"><Skeleton height={240} /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

// Each leaf page route gets its own errorElement (rather than relying on one
// shared ancestor boundary) so a crash on one page doesn't also unmount
// RootLayout's Sidebar/TopBar — matches the two-boundary design this app
// already used with the plain ErrorBoundary class component.
const router = createBrowserRouter([
  {
    path: '/login',
    element: <Suspense fallback={null}><LoginPage /></Suspense>,
    errorElement: <RouteErrorBoundary />,
  },
  {
    element: <AuthGate />,
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        element: <RootLayout />,
        children: [
          {
            path: '/',
            element: <HomePage />,
            loader: () => import('@/app/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          { path: '/chat', element: <ChatPage />, errorElement: <RouteErrorBoundary /> },
          {
            path: '/results',
            element: <ResultsPage />,
            loader: () => import('@/app/results/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: '/results/compare',
            element: <ComparePage />,
            loader: (args) => import('@/app/results/compare/page').then(m => m.loader(args)),
            errorElement: <RouteErrorBoundary />,
          },
          { path: '/results/:testId', element: <ResultDetailPage />, errorElement: <RouteErrorBoundary /> },
          {
            path: '/presets',
            element: <PresetsPage />,
            loader: () => import('@/app/presets/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          { path: '/library', element: <LibraryPage />, errorElement: <RouteErrorBoundary /> },
          {
            path: '/schedules',
            element: <SchedulesPage />,
            loader: () => import('@/app/schedules/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: '/webhooks',
            element: <WebhooksPage />,
            loader: () => import('@/app/webhooks/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: '/team',
            element: <TeamPage />,
            loader: () => import('@/app/team/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: '/org',
            element: <OrgPage />,
            loader: () => import('@/app/org/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: '/workspaces',
            element: <WorkspacesPage />,
            loader: () => import('@/app/workspaces/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
          {
            path: '/settings',
            element: <SettingsPage />,
            loader: () => import('@/app/settings/page').then(m => m.loader()),
            errorElement: <RouteErrorBoundary />,
          },
        ],
      },
    ],
  },
]);

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <WorkspaceProvider>
          <ResultsSocketProvider>
            <HealthProvider>
              <RouterProvider router={router} />
            </HealthProvider>
          </ResultsSocketProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
