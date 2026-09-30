"""
Lightweight IoU tracker (copied from legacy_local_model/run_detection.py so the
remote pipeline does not depend on the legacy module).

Assigns a stable ``tracked_vehicle_id`` ("trk_0001", ...) to the same physical
vehicle across consecutive sampled frames of ONE video. Boxes are [x, y, w, h].
"""

from __future__ import annotations


def compute_iou(box_a, box_b) -> float:
    """IoU between two [x, y, w, h] bounding boxes."""
    xa = max(box_a[0], box_b[0])
    ya = max(box_a[1], box_b[1])
    xb = min(box_a[0] + box_a[2], box_b[0] + box_b[2])
    yb = min(box_a[1] + box_a[3], box_b[1] + box_b[3])
    inter = max(0, xb - xa) * max(0, yb - ya)
    area_a = box_a[2] * box_a[3]
    area_b = box_b[2] * box_b[3]
    union = area_a + area_b - inter + 1e-6
    return inter / union


class LightweightTracker:
    """Greedy IoU matcher; with ``match_types`` (default) different vehicle_types never match.

    ``match_types=False`` suits detectors whose class flickers between frames
    (e.g. Car/LCV/Truck on the same box); the caller then votes a class per track.
    """

    def __init__(self, iou_thresh: float = 0.25, max_missed: int = 5, match_types: bool = True):
        self.iou_thresh = iou_thresh
        self.max_missed = max_missed
        self.match_types = match_types
        self.next_track_id = 1
        # track_id -> {bbox, vehicle_type, missed_frames}
        self.tracks: dict = {}

    def update(self, detections: list[dict]) -> list[dict]:
        """Returns copies of ``detections`` enriched with ``tracked_vehicle_id``."""
        updated = []
        unmatched = list(range(len(detections)))

        for track_id, track in list(self.tracks.items()):
            best_iou, best_idx = 0.0, -1
            for idx in unmatched:
                det = detections[idx]
                if self.match_types and det["vehicle_type"] != track["vehicle_type"]:
                    continue
                iou = compute_iou(track["bbox"], det["bbox"])
                if iou > best_iou and iou >= self.iou_thresh:
                    best_iou, best_idx = iou, idx
            if best_idx != -1:
                track["bbox"] = detections[best_idx]["bbox"]
                track["missed_frames"] = 0
                unmatched.remove(best_idx)
                enriched = dict(detections[best_idx])
                enriched["tracked_vehicle_id"] = f"trk_{track_id:04d}"
                updated.append(enriched)
            else:
                track["missed_frames"] += 1

        for tid in [t for t, tr in self.tracks.items() if tr["missed_frames"] > self.max_missed]:
            del self.tracks[tid]

        for idx in unmatched:
            det = detections[idx]
            new_id = self.next_track_id
            self.next_track_id += 1
            self.tracks[new_id] = {"bbox": det["bbox"], "vehicle_type": det["vehicle_type"], "missed_frames": 0}
            enriched = dict(det)
            enriched["tracked_vehicle_id"] = f"trk_{new_id:04d}"
            updated.append(enriched)

        return updated
