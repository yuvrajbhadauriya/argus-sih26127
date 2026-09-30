// ═══════════════════════════════════════════════════
// App — Root component with router setup
// All routes rendered inside DashboardLayout
// ═══════════════════════════════════════════════════

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DashboardLayout } from '@/shared/layout/DashboardLayout';
import { LiveMapPage } from '@/features/live-map/pages/LiveMapPage';
import { CamerasPage } from '@/features/cameras/pages/CamerasPage';
import { VehiclesPage } from '@/features/vehicles/pages/VehiclesPage';
import { AlertsPage } from '@/features/alerts/pages/AlertsPage';
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage';
import { AdminPage } from '@/features/admin/pages/AdminPage';
import { DetectionsPage } from '@/features/detections/pages/DetectionsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/" element={<LiveMapPage />} />
          <Route path="/cameras" element={<CamerasPage />} />
          <Route path="/vehicles" element={<VehiclesPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/detections" element={<DetectionsPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
