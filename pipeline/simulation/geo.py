"""
Small, dependency-free geo helpers shared by the city-network simulation.

Coordinates are (lat, lng) tuples in degrees unless stated otherwise.
"""

from __future__ import annotations

import math
from typing import Iterable, List, Sequence, Tuple

EARTH_RADIUS_M = 6_371_008.8
COMPASS_8 = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")

LatLng = Tuple[float, float]


def haversine_m(a: LatLng, b: LatLng) -> float:
    """Great-circle distance in metres."""
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def bearing_deg(a: LatLng, b: LatLng) -> float:
    """Initial bearing from a to b, degrees clockwise from north in [0, 360)."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlng = math.radians(b[1] - a[1])
    x = math.sin(dlng) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def compass8(bearing: float) -> str:
    """Map a bearing to one of N, NE, E, SE, S, SW, W, NW."""
    return COMPASS_8[int(((bearing % 360) + 22.5) // 45) % 8]


def polyline_length_m(coords: Sequence[LatLng]) -> float:
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def _project(origin: LatLng, p: LatLng) -> Tuple[float, float]:
    """Local equirectangular projection (metres) around `origin`."""
    k = math.cos(math.radians(origin[0]))
    return (
        math.radians(p[1] - origin[1]) * EARTH_RADIUS_M * k,
        math.radians(p[0] - origin[0]) * EARTH_RADIUS_M,
    )


def point_segment_distance_m(p: LatLng, a: LatLng, b: LatLng) -> Tuple[float, float]:
    """Distance from p to segment ab, and the projection parameter t in [0, 1]."""
    ax, ay = _project(p, a)
    bx, by = _project(p, b)
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy), t


def locate_on_polyline(p: LatLng, coords: Sequence[LatLng]) -> Tuple[float, float]:
    """Return (min distance to polyline in m, distance along polyline in m)."""
    best = (float("inf"), 0.0)
    along = 0.0
    for i in range(len(coords) - 1):
        seg = haversine_m(coords[i], coords[i + 1])
        d, t = point_segment_distance_m(p, coords[i], coords[i + 1])
        if d < best[0]:
            best = (d, along + t * seg)
        along += seg
    return best


def douglas_peucker(coords: Sequence[LatLng], tolerance_m: float) -> List[LatLng]:
    """Iterative Douglas-Peucker simplification with a tolerance in metres."""
    n = len(coords)
    if n <= 2:
        return list(coords)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        if e - s < 2:
            continue
        idx, dmax = -1, -1.0
        for i in range(s + 1, e):
            d, _ = point_segment_distance_m(coords[i], coords[s], coords[e])
            if d > dmax:
                idx, dmax = i, d
        if dmax > tolerance_m:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [c for c, k in zip(coords, keep) if k]


def bearing_over(coords: Sequence[LatLng], from_end: bool, span_m: float = 150.0) -> float:
    """Travel bearing over the first (or last) `span_m` metres of a polyline."""
    pts: Iterable[LatLng] = reversed(coords) if from_end else coords
    pts = list(pts)
    if len(pts) < 2:
        return 0.0
    anchor = pts[0]
    acc = 0.0
    other = pts[1]
    for i in range(1, len(pts)):
        acc += haversine_m(pts[i - 1], pts[i])
        other = pts[i]
        if acc >= span_m:
            break
    return bearing_deg(other, anchor) if from_end else bearing_deg(anchor, other)


def point_at_distance(coords: Sequence[LatLng], dist_m: float) -> LatLng:
    """Interpolated point `dist_m` metres along a polyline (clamped)."""
    if dist_m <= 0:
        return coords[0]
    acc = 0.0
    for i in range(len(coords) - 1):
        seg = haversine_m(coords[i], coords[i + 1])
        if acc + seg >= dist_m and seg > 0:
            t = (dist_m - acc) / seg
            a, b = coords[i], coords[i + 1]
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        acc += seg
    return coords[-1]
