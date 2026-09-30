// ═══════════════════════════════════════════════════
// NERO Shared Type Definitions
// Single source of truth for all data shapes
// ═══════════════════════════════════════════════════

/** Camera/feed status */
export type CameraStatus = 'online' | 'offline' | 'maintenance';

/** Vehicle type (the ANPR model's classes mapped to the dashboard's five) */
export type VehicleType = 'car' | 'truck' | 'bus' | 'motorcycle' | 'unknown';

/** Indian plate colours: white private, yellow commercial (taxi / bus / goods), green EV. */
export type PlateColour = 'private' | 'commercial' | 'ev';

/** Alert priority levels */
export type AlertPriority = 'low' | 'medium' | 'high' | 'critical';

/** Watchlist/blacklist category */
export type WatchlistCategory = 'stolen' | 'wanted' | 'missing' | 'flagged' | 'custom';

// ── Core entities ──────────────────────────────────

/** A virtual camera mapped 1:1 to a pre-downloaded traffic video */
export interface CameraFeed {
  id: string;
  name: string;
  code: string;
  lat: number;
  lng: number;
  zone: string;
  direction: string;
  /** Road / junction the camera watches (e.g. "Western Express Highway at Vile Parle Flyover"). */
  road?: string;
  status: CameraStatus;
  /** Clip name (file stem) of the camera's video, e.g. "mumbai_overhead-dense-jam-plates_pexels31048534". */
  video_slug?: string;
  video_url: string;
  thumbnail_url?: string;
  created_at: string;
  updated_at: string;
}

/** A single vehicle detection event from the ANPR pipeline output */
export interface Detection {
  event_id: string;
  camera_id: string;
  tracked_vehicle_id?: number | string;
  plate_text_raw: string;
  plate_text_normalized: string;
  confidence_score: number;
  vehicle_type: VehicleType;
  timestamp: string | number;
  frame_timestamp_sec?: number;
  lat?: number;
  lng?: number;
  bbox: BoundingBox;
  image_ref?: string;
}

/** Bounding box coordinates for detection overlay */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Aggregated vehicle view (derived from detections) */
export interface Vehicle {
  plate_text: string;
  vehicle_type: VehicleType;
  /** Plate colour when known (taxis are cars with yellow plates, EVs are green). */
  plate_variant?: PlateColour;
  first_seen: string;
  last_seen: string;
  detection_count: number;
  camera_count: number;
}

/** Reconstructed journey of a vehicle across cameras */
export interface Trajectory {
  id: string;
  plate_text: string;
  vehicle_type: VehicleType;
  /** Plate colour when known (see Vehicle.plate_variant). */
  plate_variant?: PlateColour;
  waypoints: TrajectoryWaypoint[];
  total_travel_time_seconds: number;
  camera_count: number;
  first_seen: string;
  last_seen: string;
  /** Where the trajectory came from (absent on legacy rows). */
  source?: TrajectorySource;
  /** Road distance covered between observed stops, in metres. */
  total_distance_m?: number;
  /** Time spent moving between observed stops (excludes off-network gaps). */
  moving_time_seconds?: number;
  /** Free-form tags, e.g. "watchlist", "anomaly:cloned_plate". */
  tags?: string[];
  /** Detected anomalies worth surfacing to an operator. */
  anomalies?: TrajectoryAnomaly[];
}

/** Origin of a reconstructed trajectory */
export type TrajectorySource = 'supabase' | 'simulation' | 'mock';

/** 8-point compass heading of travel */
export type CompassHeading = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** An anomaly flagged on a trajectory */
export interface TrajectoryAnomaly {
  kind: 'cloned_plate' | 'circling' | string;
  message: string;
  /** Waypoint indices (into `waypoints`) that evidence the anomaly */
  waypoint_indices?: number[];
}

/** A single stop in a vehicle's trajectory */
export interface TrajectoryWaypoint {
  camera_id: string;
  camera_name: string;
  lat: number;
  lng: number;
  timestamp: string;
  time_since_previous_seconds: number | null;
  /** Camera code (e.g. "VP-01"), when known */
  camera_code?: string;
  /** Direction of travel when seen at this camera */
  heading?: CompassHeading | string;
  /** Average speed over the hop from the previous stop of the same trip */
  speed_kmph_from_prev?: number | null;
  /** Road distance of the hop from the previous stop of the same trip */
  distance_m_from_prev?: number | null;
  /** Index of the continuous trip this stop belongs to (0-based) */
  trip_index?: number;
  /** Road geometry [lat, lng][] from the previous stop of the same trip */
  path_from_prev?: [number, number][] | null;
}

/** A watchlist/blacklist entry */
export interface BlacklistEntry {
  id: string;
  plate_text: string;
  category: WatchlistCategory;
  priority: AlertPriority;
  reason: string;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** An alert generated when a detection matches a blacklist entry */
export interface AlertRecord {
  id: string;
  detection_event_id: string;
  blacklist_entry_id: string;
  plate_text: string;
  camera_id: string;
  camera_name: string;
  priority: AlertPriority;
  category: WatchlistCategory;
  reason: string;
  timestamp: string;
  lat: number;
  lng: number;
  acknowledged: boolean;
  acknowledged_by?: string;
  acknowledged_at?: string;
}

/** An audit log entry */
export interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  user_email: string;
  details: string;
  timestamp: string;
}

/** Congestion metric for a zone-time bucket */
export interface CongestionMetric {
  zone: string;
  time_bucket: string;
  detection_count: number;
  avg_speed?: number;
  congestion_level: 'low' | 'medium' | 'high';
}

/** Origin-Destination pair */
export interface ODPair {
  origin_zone: string;
  destination_zone: string;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  trip_count: number;
  avg_travel_time_seconds: number;
}

/** Corridor stats */
export interface CorridorStats {
  id: string;
  name: string;
  from_zone: string;
  to_zone: string;
  trajectory_count: number;
  avg_travel_time_seconds: number;
  peak_hour: string;
  peak_count: number;
}
