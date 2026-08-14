import { Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './components/AppShell';
import { queryClient } from './lib/queryClient';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import CapturePage from './pages/CapturePage';
import ViewerPage from './pages/ViewerPage';

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">Loading…</div>
  );
}

/** The route tree on its own, so tests can mount it inside a MemoryRouter. */
export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/capture" element={<CapturePage />} />
          <Route path="/viewer" element={<ViewerPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
