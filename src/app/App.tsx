// ═══════════════════════════════════════════════════
// App — Root component with router setup
// All routes rendered inside DashboardLayout; pages are code-split
// (see ./routes.ts) and suspend inside the layout's content area.
// ═══════════════════════════════════════════════════

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DashboardLayout } from '@/shared/layout/DashboardLayout';
import { routes, loginRoute, prefetchRoutesWhenIdle } from './routes';

export default function App() {
  useEffect(() => prefetchRoutesWhenIdle(), []);

  return (
    <BrowserRouter>
      <Routes>
        {/* Sign-in sits outside the dashboard shell. */}
        <Route path={loginRoute.path} element={<loginRoute.page.Component />} />
        <Route element={<DashboardLayout />}>
          {routes.map(({ path, page: { Component } }) => (
            <Route key={path} path={path} element={<Component />} />
          ))}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
