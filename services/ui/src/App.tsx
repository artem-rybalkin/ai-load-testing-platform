import { BrowserRouter, Routes, Route, Outlet } from 'react-router-dom';
import { ResultsSocketProvider } from '@/lib/ResultsSocketContext';
import Sidebar from '@/app/components/Sidebar';
import BottomNav from '@/app/components/BottomNav';
import TopBar from '@/app/components/TopBar';
import ActiveTests from '@/app/components/ActiveTests';
import WorkerHealth from '@/app/components/WorkerHealth';
import SystemHealth from '@/app/components/SystemHealth';
import AIStatus from '@/app/components/AIStatus';
import { lazy, Suspense } from 'react';

const HomePage        = lazy(() => import('@/app/page'));
const ResultsPage     = lazy(() => import('@/app/results/page'));
const ResultDetailPage = lazy(() => import('@/app/results/[testId]/page'));
const ComparePage     = lazy(() => import('@/app/results/compare/page'));
const PresetsPage     = lazy(() => import('@/app/presets/page'));
const SchedulesPage   = lazy(() => import('@/app/schedules/page'));
const WebhooksPage    = lazy(() => import('@/app/webhooks/page'));

function RootLayout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <ActiveTests />
        <WorkerHealth />
        <AIStatus />
        <SystemHealth />
        <main className="flex-1 pb-14 lg:pb-0">
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
    <ResultsSocketProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<RootLayout />}>
            <Route path="/"                   element={<HomePage />} />
            <Route path="/results"            element={<ResultsPage />} />
            <Route path="/results/compare"    element={<ComparePage />} />
            <Route path="/results/:testId"    element={<ResultDetailPage />} />
            <Route path="/presets"            element={<PresetsPage />} />
            <Route path="/schedules"          element={<SchedulesPage />} />
            <Route path="/webhooks"           element={<WebhooksPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ResultsSocketProvider>
  );
}
