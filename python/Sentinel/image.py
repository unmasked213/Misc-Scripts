"""
Image duplicate detection — pHash with canonical transforms, ORB keypoints,
and RANSAC geometric verification.

Adapted from dupefinder.py. Detects exact duplicates, resized copies,
crops, rotations, flips, and minor edits.

Dependencies: opencv-python-headless, numpy, Pillow (all optional —
gracefully degrades if missing).
"""

import logging
import math
import struct
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ..config import Config
from ..database import Database
from ..models import DupeMatch, DupeVerdict, FileRecord, FileType

logger = logging.getLogger("sentinel.dedup.image")

# Lazy imports — degrade gracefully if not installed
_cv2 = None
_np = None
_Image = None
_HAS_DEPS = None


def _ensure_deps() -> bool:
    """Lazy-load OpenCV, NumPy, and Pillow. Returns True if available."""
    global _cv2, _np, _Image, _HAS_DEPS
    if _HAS_DEPS is not None:
        return _HAS_DEPS
    try:
        import cv2
        import numpy as np
        from PIL import Image, ImageFile
        ImageFile.LOAD_TRUNCATED_IMAGES = True
        Image.MAX_IMAGE_PIXELS = 178956970
        _cv2 = cv2
        _np = np
        _Image = Image
        _HAS_DEPS = True
    except ImportError as e:
        logger.info("Image dedup unavailable (missing %s) — skipping", e.name)
        _HAS_DEPS = False
    return _HAS_DEPS


# ── pHash ────────────────────────────────────────────────────

def _compute_phash64(img) -> int:
    """Compute 64-bit perceptual hash via DCT on 8x8 block."""
    np, cv2 = _np, _cv2
    h, w = img.shape[:2]
    if h != w:
        if h < w:
            pad = (w - h) // 2
            img = cv2.copyMakeBorder(img, pad, w - h - pad, 0, 0, cv2.BORDER_REFLECT)
        else:
            pad = (h - w) // 2
            img = cv2.copyMakeBorder(img, 0, 0, pad, h - w - pad, cv2.BORDER_REFLECT)
    img_small = cv2.resize(img, (32, 32), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img_small, cv2.COLOR_RGB2GRAY) if len(img_small.shape) == 3 else img_small
    dct = cv2.dct(gray.astype(np.float32))
    block = dct[:8, :8].flatten()
    med = np.median(block[1:])
    bits = 0
    for coeff in block:
        bits = (bits << 1) | int(coeff > med)
    return bits


def compute_phashes_canonical(img) -> List[int]:
    """Compute pHash for all 8 canonical orientations (4 rotations × 2 flips)."""
    cv2 = _cv2
    hashes = []
    transforms = [img]
    for k in range(1, 4):
        transforms.append(_np.rot90(img, k))
    flip_h = cv2.flip(img, 1)
    transforms.append(flip_h)
    for k in range(1, 4):
        transforms.append(_np.rot90(flip_h, k))
    for t in transforms:
        hashes.append(_compute_phash64(t))
    return hashes


def phash_similarity(hashes_a: List[int], hashes_b: List[int]) -> float:
    """Best pHash similarity between two sets of canonical hashes."""
    best_dist = 64
    for ha in hashes_a:
        for hb in hashes_b:
            d = bin(ha ^ hb).count("1")
            if d < best_dist:
                best_dist = d
                if d == 0:
                    return 1.0
    return 1.0 - (best_dist / 64.0)


# ── Image Loading ────────────────────────────────────────────

def load_image_normalized(path: Path):
    """Load and normalize image: EXIF rotation, alpha compositing, RGB."""
    if not _ensure_deps():
        return None
    Image, np = _Image, _np
    try:
        with Image.open(path) as im:
            # EXIF orientation
            try:
                exif = im.getexif()
            except Exception:
                exif = None
            if exif:
                orient = exif.get(0x0112)
                ops = {
                    3: lambda i: i.rotate(180, expand=True),
                    6: lambda i: i.rotate(270, expand=True),
                    8: lambda i: i.rotate(90, expand=True),
                    2: lambda i: i.transpose(Image.FLIP_LEFT_RIGHT),
                    4: lambda i: i.transpose(Image.FLIP_TOP_BOTTOM),
                    5: lambda i: i.transpose(Image.FLIP_LEFT_RIGHT).rotate(270, expand=True),
                    7: lambda i: i.transpose(Image.FLIP_LEFT_RIGHT).rotate(90, expand=True),
                }
                if orient in ops:
                    im = ops[orient](im)
            # Alpha compositing
            if im.mode in ("RGBA", "LA"):
                matte = Image.new("RGB", im.size, (128, 128, 128))
                matte.paste(im, mask=im.getchannel("A"))
                im = matte
            else:
                im = im.convert("RGB")
            return np.array(im)
    except Exception:
        return None


# ── ORB Features ─────────────────────────────────────────────

def extract_orb_features(img, cfg: dict):
    """Extract ORB keypoints and descriptors."""
    cv2 = _cv2
    image_cfg = cfg.get("image", {})
    max_dim = image_cfg.get("feature_max_dimension", 1024)

    # Resize for feature extraction
    h, w = img.shape[:2]
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        new_w, new_h = int(w * scale), int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    detector = cv2.ORB_create(
        nfeatures=image_cfg.get("orb_features", 800),
        scaleFactor=image_cfg.get("orb_scale_factor", 1.2),
        nlevels=8,
        edgeThreshold=15,
        fastThreshold=12,
    )
    kps, desc = detector.detectAndCompute(img, None)
    if kps is None:
        return [], None
    return kps, desc


def match_descriptors(desc_a, desc_b, ratio_test: float = 0.75):
    """BF Hamming matching with Lowe's ratio test."""
    cv2, np = _cv2, _np
    if desc_a is None or desc_b is None or len(desc_a) == 0 or len(desc_b) == 0:
        return []
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    try:
        raw = matcher.knnMatch(desc_a, desc_b, k=2)
    except cv2.error:
        return []
    good = []
    for pair in raw:
        if len(pair) == 2:
            m, n = pair
            if m.distance < ratio_test * n.distance:
                good.append(m)
    return good


# ── Geometric Verification ───────────────────────────────────

def geometric_verify(kps_a, kps_b, matches, cfg: dict):
    """
    RANSAC geometric verification across similarity, affine, and homography
    models. Returns (model_name, inliers, coverage_a, coverage_b, residual).
    """
    cv2, np = _cv2, _np
    if not matches:
        return None, 0, 0.0, 0.0, float("inf")

    geom_cfg = cfg.get("image", {}).get("geometry", {})
    variant = geom_cfg.get("variant", {})
    reproj = variant.get("reprojection_px", 4.0)
    scale_limits = geom_cfg.get("scale_limits", [0.25, 4.0])

    pts_a = np.float32([kps_a[m.queryIdx].pt for m in matches])
    pts_b = np.float32([kps_b[m.trainIdx].pt for m in matches])

    best_model, best_inliers, best_residual, best_H = None, 0, float("inf"), None

    for model in geom_cfg.get("ransac_models", ["similarity", "affine", "homography"]):
        if model == "homography" and len(matches) < 4:
            continue
        if model in ("similarity", "affine") and len(matches) < 2:
            continue

        try:
            if model == "similarity":
                M, mask = cv2.estimateAffinePartial2D(
                    pts_a, pts_b, method=cv2.RANSAC,
                    ransacReprojThreshold=reproj, maxIters=2000, confidence=0.99,
                )
                if M is None:
                    continue
                H = np.vstack([M, [0, 0, 1]])
            elif model == "affine":
                M, mask = cv2.estimateAffine2D(
                    pts_a, pts_b, method=cv2.RANSAC,
                    ransacReprojThreshold=reproj, maxIters=2000, confidence=0.99,
                )
                if M is None:
                    continue
                H = np.vstack([M, [0, 0, 1]])
            elif model == "homography":
                H, mask = cv2.findHomography(pts_a, pts_b, cv2.RANSAC, reproj)
                if H is None:
                    continue
            else:
                continue
        except cv2.error:
            continue

        mask = mask.reshape(-1) if mask is not None else None
        inliers = int(mask.sum()) if mask is not None else 0
        if inliers == 0:
            continue

        # Compute residual
        pts_a_h = np.hstack([pts_a, np.ones((pts_a.shape[0], 1), dtype=np.float32)])
        pts_b_pred_h = (H @ pts_a_h.T).T
        pts_b_pred = (pts_b_pred_h[:, :2].T / pts_b_pred_h[:, 2]).T
        residuals = np.linalg.norm(pts_b - pts_b_pred, axis=1)
        inlier_residuals = residuals[mask.astype(bool)] if mask is not None else residuals
        med_resid = float(np.median(inlier_residuals)) if len(inlier_residuals) else float("inf")

        if inliers > best_inliers or (inliers == best_inliers and med_resid < best_residual):
            best_model, best_inliers, best_residual, best_H = model, inliers, med_resid, H

    if best_model is None:
        return None, 0, 0.0, 0.0, float("inf")

    # Scale check
    A = best_H[:2, :2]
    try:
        det = float(A[0, 0] * A[1, 1] - A[0, 1] * A[1, 0])
        scale = math.sqrt(det) if det > 0 else 0.0
    except Exception:
        scale = 0.0

    if scale < scale_limits[0] or scale > scale_limits[1]:
        return None, 0, 0.0, 0.0, float("inf")

    cov_a = best_inliers / len(kps_a) if kps_a else 0.0
    cov_b = best_inliers / len(kps_b) if kps_b else 0.0

    return best_model, best_inliers, cov_a, cov_b, best_residual


# ── Composite Similarity Score ───────────────────────────────

def composite_similarity(
    phash_sim: float,
    inliers: int, coverage_a: float, coverage_b: float,
    residual: float, model: Optional[str],
    kp_count_a: int, kp_count_b: int,
    dims_a: Tuple[int, int], dims_b: Tuple[int, int],
    cfg: dict,
) -> float:
    """
    Deletion-safe composite similarity.
    Returns a conservative lower bound on "safe to delete as redundant."
    Pulled directly from dupefinder.py's scoring logic.
    """
    image_cfg = cfg.get("image", {})
    geom_cfg = image_cfg.get("geometry", {})
    dup_geom = geom_cfg.get("duplicate", {})
    var_geom = geom_cfg.get("variant", {})

    base_score = phash_sim
    texture_threshold = image_cfg.get("low_texture_keypoints_min", 120)
    is_low_texture = kp_count_a < texture_threshold or kp_count_b < texture_threshold
    aspect_tol = image_cfg.get("aspect_ratio_tolerance", 0.15)

    aspect_a = dims_a[0] / dims_a[1] if dims_a[1] > 0 else 1.0
    aspect_b = dims_b[0] / dims_b[1] if dims_b[1] > 0 else 1.0
    aspects_match = abs(aspect_a - aspect_b) <= aspect_tol

    pixels_a = dims_a[0] * dims_a[1]
    pixels_b = dims_b[0] * dims_b[1]
    if pixels_a > 0 and pixels_b > 0:
        scale_plausible = max(pixels_a, pixels_b) / min(pixels_a, pixels_b) <= 16.0
    else:
        scale_plausible = False

    dimensions_agree = aspects_match and scale_plausible
    has_geometry = model not in (None, "none", "phash_only")

    geometry_confirmed = (
        has_geometry
        and inliers >= var_geom.get("min_inliers", 25)
        and coverage_a >= var_geom.get("coverage", 0.35)
        and coverage_b >= var_geom.get("coverage", 0.35)
    )
    geometry_strong = (
        geometry_confirmed
        and inliers >= dup_geom.get("min_inliers", 40)
        and coverage_a >= dup_geom.get("coverage", 0.50)
        and coverage_b >= dup_geom.get("coverage", 0.50)
        and residual <= dup_geom.get("reprojection_px", 2.5)
    )

    if base_score >= 0.99:
        if geometry_strong:
            return 1.0
        elif not is_low_texture and dimensions_agree:
            return 1.0
        elif not is_low_texture:
            return 0.99
        elif geometry_confirmed:
            return 0.99
        else:
            return 0.98
    elif base_score >= 0.95:
        if geometry_strong:
            return 0.99
        elif geometry_confirmed:
            return 0.98
        else:
            return base_score
    else:
        if geometry_strong:
            return min(base_score + 0.05, 0.97)
        elif geometry_confirmed:
            return min(base_score + 0.02, 0.95)
        else:
            return base_score


# ── Image Fingerprint ────────────────────────────────────────

class ImageFingerprint:
    """Complete fingerprint for an image file."""
    __slots__ = ("phashes", "kp_count", "descriptors", "dimensions")

    def __init__(self, phashes: List[int], kp_count: int,
                 descriptors=None, dimensions: Tuple[int, int] = (0, 0)):
        self.phashes = phashes
        self.kp_count = kp_count
        self.descriptors = descriptors
        self.dimensions = dimensions

    def phash_blob(self) -> bytes:
        return struct.pack(f"<{len(self.phashes)}Q", *self.phashes)

    @staticmethod
    def from_phash_blob(blob: bytes, kp_count: int) -> "ImageFingerprint":
        n = len(blob) // 8
        phashes = list(struct.unpack(f"<{n}Q", blob))
        return ImageFingerprint(phashes, kp_count)


def compute_image_fingerprint(path: Path, cfg: dict) -> Optional[ImageFingerprint]:
    """Compute full image fingerprint: pHash × 8 + ORB descriptors."""
    if not _ensure_deps():
        return None

    img = load_image_normalized(path)
    if img is None:
        return None

    h, w = img.shape[:2]
    phashes = compute_phashes_canonical(img)
    kps, desc = extract_orb_features(img, cfg)

    return ImageFingerprint(
        phashes=phashes,
        kp_count=len(kps),
        descriptors=desc,
        dimensions=(w, h),
    )


# ── Top-Level Dedup Check ────────────────────────────────────

def check_image_dupe(
    record: FileRecord,
    fingerprint: ImageFingerprint,
    db: Database,
    config: Config,
) -> Optional[DupeMatch]:
    """
    Compare an image fingerprint against stored images in the database.
    Uses pHash for fast filtering, then ORB + RANSAC for verification.
    """
    if not _ensure_deps():
        return None

    dedup_cfg = config.dedup
    image_cfg = dedup_cfg.get("image", {})
    if not image_cfg.get("enabled", True):
        return None

    # Get all image records from DB
    candidates = db.find_by_type("image")
    if not candidates:
        return None

    lsh_radius = image_cfg.get("lsh_hamming_radius", 16)
    skip_geom_thresh = image_cfg.get("phash_skip_geometric", 0.97)

    for cand in candidates:
        if str(record.path) == cand["path"]:
            continue

        # Load stored pHash
        stored_phash_blob = cand.get("image_phash")
        if not stored_phash_blob:
            continue

        try:
            stored_fp = ImageFingerprint.from_phash_blob(
                stored_phash_blob, cand.get("image_kp_count", 0)
            )
        except (struct.error, ValueError):
            continue

        # Fast pHash check
        sim = phash_similarity(fingerprint.phashes, stored_fp.phashes)
        if sim < image_cfg.get("phash_variant", 0.75):
            continue

        # Compute final score
        model, inliers, cov_a, cov_b, residual = None, 0, 0.0, 0.0, float("inf")

        # Skip geometry for very high pHash matches
        if sim < skip_geom_thresh and fingerprint.descriptors is not None:
            # Load stored descriptors
            stored_desc_blob = cand.get("image_descriptors")
            if stored_desc_blob and stored_fp.kp_count > 0:
                try:
                    stored_desc = _np.frombuffer(stored_desc_blob, dtype=_np.uint8)
                    stored_desc = stored_desc.reshape(stored_fp.kp_count, 32)

                    # Load stored keypoints
                    stored_kp_blob = cand.get("image_keypoints")
                    if stored_kp_blob:
                        kp_arr = _np.frombuffer(stored_kp_blob, dtype=_np.float64)
                        kp_arr = kp_arr.reshape(stored_fp.kp_count, 7)
                        stored_kps = []
                        for x, y, size, angle, response, octave, class_id in kp_arr:
                            stored_kps.append(_cv2.KeyPoint(
                                x=float(x), y=float(y), size=float(size),
                                angle=float(angle), response=float(response),
                                octave=int(octave), class_id=int(class_id),
                            ))

                        # Re-extract features from new image for comparison
                        new_img = load_image_normalized(record.path)
                        if new_img is not None:
                            new_kps, new_desc = extract_orb_features(new_img, dedup_cfg)
                            if new_kps and new_desc is not None:
                                matches = match_descriptors(new_desc, stored_desc)
                                model, inliers, cov_a, cov_b, residual = geometric_verify(
                                    new_kps, stored_kps, matches, dedup_cfg,
                                )
                except (ValueError, _np.exceptions.AxisError):
                    pass

        # Composite score
        cand_w = cand.get("width", 0) or 0
        cand_h = cand.get("height", 0) or 0
        score = composite_similarity(
            sim, inliers, cov_a, cov_b, residual, model,
            fingerprint.kp_count, stored_fp.kp_count,
            fingerprint.dimensions, (cand_w, cand_h),
            dedup_cfg,
        )

        # Decision threshold
        resolution_cfg = dedup_cfg.get("resolution", {})
        threshold = resolution_cfg.get("confidence_threshold", 0.85)

        if score >= image_cfg.get("phash_variant", 0.75):
            # Quality comparison
            new_pixels = fingerprint.dimensions[0] * fingerprint.dimensions[1]
            cand_pixels = cand_w * cand_h
            new_size = record.size_bytes
            cand_size = cand.get("size_bytes", 0) or 0
            keep_existing = (cand_pixels > new_pixels) or (
                cand_pixels == new_pixels and cand_size >= new_size
            )

            if score >= image_cfg.get("phash_duplicate", 0.90):
                verdict = DupeVerdict.EXACT_DUPE if score >= 0.98 else DupeVerdict.QUALITY_DUPE
            else:
                verdict = DupeVerdict.QUALITY_DUPE

            return DupeMatch(
                existing_path=cand["path"],
                existing_id=cand["id"],
                verdict=verdict,
                confidence=score,
                reason=f"Image match: pHash={sim:.0%}, composite={score:.0%}, model={model or 'phash_only'}",
                keep_existing=keep_existing,
            )

    return None
