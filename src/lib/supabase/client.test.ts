import { describe, it, expect } from 'vitest';
import * as client from './client';
import * as cameras from '@/features/cameras/api';
import * as vehicles from '@/features/vehicles/api';
import * as alerts from '@/features/alerts/api';
import * as analytics from '@/features/analytics/api';

// The data-access API used to be re-exported from a single lib/supabase barrel;
// it now lives in each feature's api.ts. Guard the public surface.
describe('data-access API surface', () => {
  it('exposes the public data-access API from the feature modules', () => {
    const expected: [object, string[]][] = [
      [client, ['getSupabase', 'isSupabaseConfigured']],
      [cameras, ['getCameras', 'getCameraById', 'getCamerasByZone', 'fetchCameras']],
      [vehicles, ['searchVehicles', 'fetchTrajectoryByPlate']],
      [alerts, ['fetchAlerts', 'acknowledgeAlert', 'fetchBlacklistEntries']],
      [analytics, ['fetchNetworkAnalytics', 'fetchSimSummaryStats']],
    ];
    for (const [mod, names] of expected) {
      for (const name of names) expect(mod).toHaveProperty(name);
    }
    expect(cameras.fetchCameras).toBe(cameras.getCameras);
  });

  it('isSupabaseConfigured() is false in the test env (no network)', () => {
    expect(client.isSupabaseConfigured()).toBe(false);
  });

  it('getSupabase() refuses to create a client when not configured (never loads the SDK)', async () => {
    await expect(client.getSupabase()).rejects.toThrow('Supabase is not configured');
  });
});
