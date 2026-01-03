#!/usr/bin/env python3

"""
dupefinder.py

This is a standalone script for detecting duplicate and near-duplicate images within
a directory tree.  It implements a lightweight perceptual hashing and
geometric‑matching pipeline without any machine learning dependencies.

Key features:

 * Walks a directory and filters for supported image formats.
 * Normalises each image to a canonical orientation and colour space.
 * Computes an 8×8 perceptual hash (pHash) for up to eight canonical
   rotations/flips of every image.  Hashes are used to quickly discard
   dissimilar files and for a fast "quick" mode where only exact/near matches
   are reported.
 * Extracts ORB keypoints and binary descriptors using OpenCV, then matches
   descriptors with a brute‑force Hamming matcher and applies RANSAC to find
   a geometric transform between matched points.  This allows detection of
   crops, resizes, rotations and small edits.
 * Assigns a label of `duplicate`, `variant` or `different` to each pair
   based on configurable thresholds.  Duplicate means near‑identical, variant
   means edited but still recognisably derived from the same capture, and
   different means unrelated.
 * Groups images into clusters by connecting pairs labelled duplicate or
   variant and then prunes members which do not meet the variant threshold
   relative to the chosen representative to avoid "chain drift".
 * Writes a JSON report describing all pairwise decisions, a CSV file of
   decisions and a simple HTML report with thumbnails for human review.
 * Maintains a persistent cache of fingerprints in a SQLite database keyed
   on a quick content fingerprint derived from the first and last 64 KiB of
   each file.  This avoids recomputing hashes on subsequent runs when files
   have not changed.

The script is designed to be deterministic.  It sets random seeds and
disables OpenCV threading to ensure reproducible results across runs.

Usage:

    python dupefinder.py INPUT_DIR --output OUTPUT_DIR

Or double-click to run interactively.

See `--help` for full usage.
"""

import argparse
import csv
import json
import math
import os
import sqlite3
import struct
import sys
import threading
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import blake2b
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    from PIL import Image, UnidentifiedImageError, ImageFile  # type: ignore
except ImportError as e:
    print(f"\n{'='*70}")
    print("ERROR: Missing required dependency")
    print(f"{'='*70}")
    print(f"\n{e}\n")
    print("Please install required packages:")
    print("  pip install opencv-python-headless numpy pillow")
    print(f"\n{'='*70}")
    input("\nPress Enter to exit...")
    sys.exit(1)

# Pillow can throw DecompressionBombError on extremely large images.
Image.MAX_IMAGE_PIXELS = 178956970
ImageFile.LOAD_TRUNCATED_IMAGES = True

# Seeded NumPy RNG for reproducibility.
# Note: OpenCV threading is now enabled for better performance.
# Set cv2.setNumThreads(1) if you need fully deterministic results.
np.random.seed(1337)

###############################################################################
# Configuration defaults
###############################################################################

DEFAULT_CFG = {
    "io": {
        "include_globs": [
            "*.jpg", "*.jpeg", "*.png", "*.webp",
            "*.heic", "*.avif", "*.tif", "*.tiff",
            "*.bmp", "*.gif"
        ],
        "exclude_globs": ["**/.git/**", "**/@eaDir/**", "**/Thumbs.db", "**/.DS_Store"],
        "follow_symlinks": False,
        "resolve_symlinks_once": True,
        "max_image_pixels": 178956970,
        # Reduced thumbnail size for faster report loading
        "thumbnail_max_px": 400,
    },
    "normalize": {
        "target_mode": "RGB",
        "alpha_matte_rgb": (128, 128, 128),
    },
    "hash": {
        "phash_bits": 64,
        "canonical_transforms": True,
        "early_zero_shortcircuit": True,
    },
    "features": {
        "detector": "ORB",
        "max_dimension": 1024,  # Resize images to this max dimension before feature extraction
        "orb": {
            "nfeatures": 800,
            "scaleFactor": 1.2,
            "nlevels": 8,
            "edgeThreshold": 15,
            "fastThreshold": 12,
        },
    },
    "match": {
        "ratio_test": 0.75,
        "cross_check": False,
        "bf_norm": "NORM_HAMMING",
    },
    "geometry": {
        "ransac_model_order": ["similarity", "affine", "homography"],
        "duplicate": {
            "reprojection_px": 2.5,
            "min_inliers": 40,
            "coverage": 0.50,
        },
        "variant": {
            "reprojection_px": 4.0,
            "min_inliers": 25,
            "coverage": 0.35,
        },
        "scale_limits": (0.25, 4.0),
    },
    "similarity": {
        "phash_duplicate": 0.90,
        "phash_variant": 0.75,
        "phash_skip_geometric": 0.97,  # Skip geometric verification if pHash >= this (very high confidence)
        "low_texture_keypoints_min": 120,
        "low_texture_phash_duplicate": 0.94,
        "low_texture_phash_variant": 0.82,
    },
    "blocking": {
        "aspect_ratio_tolerance": 0.15,
        "size_bucket_megapixels": [0.25, 1, 2, 4, 8, 16, 32],
        "filesize_order_magnitude": False,
        "lsh_hamming_radius": 16,
    },
    "cache": {
        "path": ".dupefinder_cache.sqlite",
        "use_inode": True,
        "quick_fingerprint_bytes": 65536,
    },
    "cluster": {
        "mode": "representative",
    },
    "report": {
        "paginate_threshold": 500,
        "inline_base64_threshold": 50,
        "write_csv": True,
    },
    "determinism": {
        "seed": 1337,
        "opencv_threads": 1,
    },
}

###############################################################################
# Data classes
###############################################################################

@dataclass(frozen=True)
class FileId:
    path: Path
    size: int
    mtime_ms: int
    device: Optional[int]
    inode: Optional[int]
    quick_fp: str


@dataclass
class Fingerprint:
    phash64_8x: List[int]
    keypoint_count: int
    descriptors: Optional[np.ndarray] = None  # ORB descriptors for geometric matching
    keypoints_data: Optional[List[Tuple[float, float, float, float, float, int, int]]] = None  # Serialized keypoints


@dataclass
class PairMetrics:
    phash_similarity: float
    inliers: int
    coverage_a: float
    coverage_b: float
    residual_median_px: float
    model: str


@dataclass
class PairDecision:
    a: Path
    b: Path
    label: str
    metrics: PairMetrics


@dataclass
class Cluster:
    id: str
    members: List[Path]
    representative: Path
    member_similarities: Dict[str, float]

###############################################################################
# Cache management
###############################################################################

class FingerprintCache:
    def __init__(self, cache_path: Path, use_inode: bool = True):
        self.path = cache_path
        self.use_inode = use_inode
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self._ensure_tables()
        self._lock = threading.Lock()

    def _ensure_tables(self):
        cur = self.conn.cursor()

        # Check if table exists and has old schema
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='fingerprints'")
        table_exists = cur.fetchone() is not None

        if table_exists:
            # Check schema version - look for descriptors column
            cur.execute("PRAGMA table_info(fingerprints)")
            columns = {row[1]: row[2] for row in cur.fetchall()}

            # If missing descriptors column or old schema, recreate
            if 'descriptors' not in columns or columns.get('device') == 'INTEGER' or columns.get('inode') == 'INTEGER':
                cur.execute("DROP TABLE fingerprints")
                self.conn.commit()

        # Create table with new schema including descriptors
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS fingerprints (
                path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ms INTEGER NOT NULL,
                device TEXT,
                inode TEXT,
                quick_fp TEXT NOT NULL,
                phash BLOB NOT NULL,
                keypoints INTEGER NOT NULL,
                descriptors BLOB,
                keypoints_data BLOB,
                PRIMARY KEY (path, quick_fp)
            );
            """
        )
        self.conn.commit()

    def get(self, fid: FileId) -> Optional[Fingerprint]:
        with self._lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT phash, keypoints, descriptors, keypoints_data FROM fingerprints WHERE path=? AND quick_fp=?",
                (str(fid.path), fid.quick_fp),
            )
            row = cur.fetchone()
        if row:
            phash_blob, keypoints, desc_blob, kp_blob = row
            phash64_8x = list(struct.unpack("<{}Q".format(len(phash_blob) // 8), phash_blob))

            # Deserialize descriptors if present
            descriptors = None
            if desc_blob:
                desc_array = np.frombuffer(desc_blob, dtype=np.uint8)
                if len(desc_array) > 0 and keypoints > 0:
                    # ORB descriptors are 32 bytes each
                    descriptors = desc_array.reshape(keypoints, 32)

            # Deserialize keypoints data if present
            keypoints_data = None
            if kp_blob:
                # Each keypoint: 7 values (x, y, size, angle, response, octave, class_id)
                kp_array = np.frombuffer(kp_blob, dtype=np.float64)
                if len(kp_array) > 0 and keypoints > 0:
                    kp_array = kp_array.reshape(keypoints, 7)
                    keypoints_data = [tuple(kp) for kp in kp_array]

            return Fingerprint(
                phash64_8x=phash64_8x,
                keypoint_count=keypoints,
                descriptors=descriptors,
                keypoints_data=keypoints_data
            )
        return None

    def set(self, fid: FileId, fp: Fingerprint) -> None:
        phash_blob = struct.pack("<{}Q".format(len(fp.phash64_8x)), *fp.phash64_8x)

        # Serialize descriptors
        desc_blob = None
        if fp.descriptors is not None and len(fp.descriptors) > 0:
            desc_blob = fp.descriptors.tobytes()

        # Serialize keypoints data
        kp_blob = None
        if fp.keypoints_data is not None and len(fp.keypoints_data) > 0:
            kp_array = np.array(fp.keypoints_data, dtype=np.float64)
            kp_blob = kp_array.tobytes()

        with self._lock:
            cur = self.conn.cursor()
            cur.execute(
                "REPLACE INTO fingerprints (path, size, mtime_ms, device, inode, quick_fp, phash, keypoints, descriptors, keypoints_data) VALUES (?,?,?,?,?,?,?,?,?,?);",
                (
                    str(fid.path),
                    fid.size,
                    fid.mtime_ms,
                    str(fid.device) if fid.device is not None else None,
                    str(fid.inode) if fid.inode is not None else None,
                    fid.quick_fp,
                    phash_blob,
                    fp.keypoint_count,
                    desc_blob,
                    kp_blob,
                ),
            )
            self.conn.commit()

    def close(self):
        self.conn.close()

###############################################################################
# Utility functions
###############################################################################

def compute_quick_fingerprint(path: Path, max_bytes: int) -> str:
    h = blake2b(digest_size=16)
    size = path.stat().st_size
    h.update(size.to_bytes(8, byteorder="little"))
    with path.open("rb") as f:
        head = f.read(max_bytes)
        if size > max_bytes:
            f.seek(max(0, size - max_bytes))
            tail = f.read(max_bytes)
        else:
            tail = b""
    h.update(head)
    h.update(tail)
    return h.hexdigest()

def file_id_from_path(path: Path, cfg) -> FileId:
    stat = path.stat()
    device = stat.st_dev if cfg["cache"]["use_inode"] else None
    inode = stat.st_ino if cfg["cache"]["use_inode"] else None
    quick_fp = compute_quick_fingerprint(path, cfg["cache"]["quick_fingerprint_bytes"])
    mtime_ms = stat.st_mtime_ns // 1_000_000
    return FileId(path=path, size=stat.st_size, mtime_ms=mtime_ms, device=device, inode=inode, quick_fp=quick_fp)

def list_image_files(root: Path, cfg) -> List[Path]:
    from fnmatch import fnmatch
    include_globs = cfg["io"]["include_globs"]
    exclude_globs = cfg["io"]["exclude_globs"]
    follow_symlinks = cfg["io"].get("follow_symlinks", False)
    resolve_once = cfg["io"].get("resolve_symlinks_once", True)
    files: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=follow_symlinks):
        rel_dir = os.path.relpath(dirpath, root)
        skip_dir = False
        for pattern in exclude_globs:
            if fnmatch(os.path.join(rel_dir, ""), pattern.rstrip("*")):
                skip_dir = True
                break
        if skip_dir:
            dirnames[:] = []
            continue
        for filename in filenames:
            rel_path = os.path.join(rel_dir, filename) if rel_dir != "." else filename
            full_path = Path(root) / rel_path
            if any(fnmatch(rel_path, pat) for pat in exclude_globs):
                continue
            if not any(fnmatch(filename.lower(), pat) for pat in include_globs):
                continue
            if resolve_once and full_path.is_symlink():
                try:
                    target = full_path.resolve()
                except OSError:
                    continue
                try:
                    target.relative_to(root)
                except ValueError:
                    continue
                full_path = target
            files.append(full_path)
    return files

###############################################################################
# Image normalisation and hashing
###############################################################################

def load_image_normalized(path: Path, cfg) -> Optional[np.ndarray]:
    try:
        with Image.open(path) as im:
            try:
                exif = im.getexif()
            except Exception:
                exif = None
            if exif:
                orientation = exif.get(0x0112, None)
                if orientation == 3:
                    im = im.rotate(180, expand=True)
                elif orientation == 6:
                    im = im.rotate(270, expand=True)
                elif orientation == 8:
                    im = im.rotate(90, expand=True)
                elif orientation == 2:
                    im = im.transpose(Image.FLIP_LEFT_RIGHT)
                elif orientation == 4:
                    im = im.transpose(Image.FLIP_TOP_BOTTOM)
                elif orientation == 5:
                    im = im.transpose(Image.FLIP_LEFT_RIGHT).rotate(270, expand=True)
                elif orientation == 7:
                    im = im.transpose(Image.FLIP_LEFT_RIGHT).rotate(90, expand=True)
            if im.mode in ("RGBA", "LA"):
                color = tuple(int(x) for x in cfg["normalize"]["alpha_matte_rgb"])
                matte = Image.new("RGB", im.size, color)
                matte.paste(im, mask=im.getchannel("A"))
                im = matte
            else:
                im = im.convert(cfg["normalize"]["target_mode"])
            return np.array(im)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return None

def build_thumbnail(img: np.ndarray, max_px: int) -> Image.Image:
    """
    Create a thumbnail from a numpy array image.

    Args:
        img: RGB numpy array
        max_px: Maximum dimension (width or height) in pixels

    Returns:
        PIL Image resized to fit within max_px x max_px
    """
    pil_img = Image.fromarray(img)
    # Use LANCZOS resampling (compatible with Pillow 9.x and 10.x)
    try:
        from PIL.Image import Resampling
        pil_img.thumbnail((max_px, max_px), Resampling.LANCZOS)
    except (ImportError, AttributeError):
        pil_img.thumbnail((max_px, max_px), Image.LANCZOS)
    return pil_img


def resize_for_features(img: np.ndarray, max_dimension: int) -> np.ndarray:
    """
    Resize image if larger than max_dimension for faster feature extraction.

    Args:
        img: RGB numpy array
        max_dimension: Maximum width or height in pixels

    Returns:
        Resized numpy array (or original if already small enough)
    """
    h, w = img.shape[:2]
    if max(h, w) <= max_dimension:
        return img

    if w > h:
        new_w = max_dimension
        new_h = int(h * max_dimension / w)
    else:
        new_h = max_dimension
        new_w = int(w * max_dimension / h)

    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

def dct_2d(arr: np.ndarray) -> np.ndarray:
    return cv2.dct(arr.astype(np.float32))

def compute_phash64(img: np.ndarray) -> int:
    h, w = img.shape[:2]
    if h != w:
        if h < w:
            pad = (w - h) // 2
            img_pad = cv2.copyMakeBorder(img, pad, w - h - pad, 0, 0, cv2.BORDER_REFLECT)
        else:
            pad = (h - w) // 2
            img_pad = cv2.copyMakeBorder(img, 0, 0, pad, h - w - pad, cv2.BORDER_REFLECT)
    else:
        img_pad = img
    img_small = cv2.resize(img_pad, (32, 32), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img_small, cv2.COLOR_RGB2GRAY)
    dct = dct_2d(gray)
    block = dct[:8, :8].flatten()
    med = np.median(block[1:])
    bits = 0
    for coeff in block:
        bits = (bits << 1) | int(coeff > med)
    return bits

def phash_hamming_distance(a: int, b: int) -> int:
    # Use bin().count('1') for Python < 3.10 compatibility
    xor = a ^ b
    if hasattr(xor, 'bit_count'):
        return xor.bit_count()
    return bin(xor).count('1')

def compute_all_phashes(img: np.ndarray, cfg) -> List[int]:
    if not cfg["hash"]["canonical_transforms"]:
        return [compute_phash64(img)]
    hashes: List[int] = []
    transforms = []
    transforms.append(img)
    for k in range(1, 4):
        transforms.append(np.rot90(img, k))
    flip_h = cv2.flip(img, 1)
    transforms.append(flip_h)
    for k in range(1, 4):
        transforms.append(np.rot90(flip_h, k))
    for t in transforms:
        hashes.append(compute_phash64(t))
    return hashes

###############################################################################
# Feature detection and matching
###############################################################################

def get_feature_detector(cfg):
    if cfg["features"]["detector"].upper() == "ORB":
        params = cfg["features"]["orb"]
        return cv2.ORB_create(
            nfeatures=params["nfeatures"],
            scaleFactor=params["scaleFactor"],
            nlevels=params["nlevels"],
            edgeThreshold=params["edgeThreshold"],
            fastThreshold=params["fastThreshold"],
        )
    raise ValueError(f"Unsupported detector: {cfg['features']['detector']}")

def extract_keypoints(img: np.ndarray, detector) -> Tuple[List[cv2.KeyPoint], np.ndarray]:
    kps, desc = detector.detectAndCompute(img, None)
    if kps is None:
        return [], None
    return kps, desc


def reconstruct_keypoints(keypoints_data: List[Tuple[float, float, float, float, float, int, int]]) -> List[cv2.KeyPoint]:
    """Reconstruct cv2.KeyPoint objects from serialized data."""
    if not keypoints_data:
        return []
    keypoints = []
    for x, y, size, angle, response, octave, class_id in keypoints_data:
        kp = cv2.KeyPoint(
            x=float(x),
            y=float(y),
            size=float(size),
            angle=float(angle),
            response=float(response),
            octave=int(octave),
            class_id=int(class_id)
        )
        keypoints.append(kp)
    return keypoints

def match_descriptors(desc_a: np.ndarray, desc_b: np.ndarray, cfg) -> List[cv2.DMatch]:
    if desc_a is None or desc_b is None or len(desc_a) == 0 or len(desc_b) == 0:
        return []
    norm_type = cv2.NORM_HAMMING
    cross_check = cfg["match"]["cross_check"]
    matcher = cv2.BFMatcher(norm_type, crossCheck=cross_check)
    if cross_check:
        return sorted(matcher.match(desc_a, desc_b), key=lambda m: m.distance)
    try:
        matches = matcher.knnMatch(desc_a, desc_b, k=2)
    except cv2.error:
        return []
    good = []
    ratio = cfg["match"]["ratio_test"]
    for pair in matches:
        if len(pair) == 2:
            m, n = pair
            if m.distance < ratio * n.distance:
                good.append(m)
    return good

def estimate_transform_and_metrics(
    kps_a: List[cv2.KeyPoint],
    kps_b: List[cv2.KeyPoint],
    matches: List[cv2.DMatch],
    cfg,
) -> Tuple[Optional[str], PairMetrics]:
    num_kp_a = len(kps_a)
    num_kp_b = len(kps_b)
    if not matches:
        return None, PairMetrics(phash_similarity=0.0, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none")
    pts_a = np.float32([kps_a[m.queryIdx].pt for m in matches])
    pts_b = np.float32([kps_b[m.trainIdx].pt for m in matches])
    best_model, best_inliers, best_residual, best_matrix = None, 0, float("inf"), None
    model_params = cfg["geometry"]
    for model in cfg["geometry"]["ransac_model_order"]:
        # Check minimum points required for each model
        if model == "homography" and len(matches) < 4:
            continue
        elif model in ["similarity", "affine"] and len(matches) < 2:
            continue

        try:
            if model == "similarity":
                M, mask = cv2.estimateAffinePartial2D(pts_a, pts_b, method=cv2.RANSAC,
                                                      ransacReprojThreshold=model_params["variant"]["reprojection_px"],
                                                      maxIters=2000, confidence=0.99)
                if M is None:
                    continue
                H = np.vstack([M, [0, 0, 1]])
            elif model == "affine":
                M, mask = cv2.estimateAffine2D(pts_a, pts_b, method=cv2.RANSAC,
                                               ransacReprojThreshold=model_params["variant"]["reprojection_px"],
                                               maxIters=2000, confidence=0.99)
                if M is None:
                    continue
                H = np.vstack([M, [0, 0, 1]])
            elif model == "homography":
                H, mask = cv2.findHomography(pts_a, pts_b, cv2.RANSAC, model_params["variant"]["reprojection_px"])
                if H is None:
                    continue
            else:
                continue
        except cv2.error as e:
            # Skip this model if OpenCV throws an error
            continue
        mask = mask.reshape(-1) if mask is not None else None
        inliers = int(mask.sum()) if mask is not None else 0
        if inliers == 0:
            continue
        pts_a_h = np.hstack([pts_a, np.ones((pts_a.shape[0], 1), dtype=np.float32)])
        pts_b_pred_h = (H @ pts_a_h.T).T
        pts_b_pred = (pts_b_pred_h[:, :2].T / pts_b_pred_h[:, 2]).T
        residuals = np.linalg.norm(pts_b - pts_b_pred, axis=1)
        inlier_residuals = residuals[mask.astype(bool)] if mask is not None else residuals
        median_residual = np.median(inlier_residuals) if len(inlier_residuals) else float("inf")
        if inliers > best_inliers or (inliers == best_inliers and median_residual < best_residual):
            best_model, best_inliers, best_residual, best_matrix = model, inliers, median_residual, H
    if best_model is None:
        return None, PairMetrics(phash_similarity=0.0, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none")
    A = best_matrix[:2, :2] if best_matrix is not None else None
    scale = None
    if A is not None:
        try:
            det = float(A[0, 0] * A[1, 1] - A[0, 1] * A[1, 0])
            if det > 0:
                scale = math.sqrt(det)
            else:
                scale = 0.0
        except Exception:
            scale = None
    smin, smax = cfg["geometry"]["scale_limits"]
    if scale is None or scale < smin or scale > smax:
        return None, PairMetrics(phash_similarity=0.0, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none")
    coverage_a = best_inliers / num_kp_a if num_kp_a > 0 else 0.0
    coverage_b = best_inliers / num_kp_b if num_kp_b > 0 else 0.0
    metrics = PairMetrics(
        phash_similarity=0.0,
        inliers=best_inliers,
        coverage_a=coverage_a,
        coverage_b=coverage_b,
        residual_median_px=best_residual,
        model=best_model,
    )
    return best_model, metrics

def compute_fingerprint(path: Path, cfg, detector, cache: FingerprintCache) -> Optional[Fingerprint]:
    fid = file_id_from_path(path, cfg)
    cached = cache.get(fid)
    if cached:
        return cached
    img = load_image_normalized(path, cfg)
    if img is None:
        return None
    phashes = compute_all_phashes(img, cfg)

    # Resize for faster feature extraction (pHash uses full image, features use resized)
    max_dim = cfg["features"].get("max_dimension", 1024)
    img_resized = resize_for_features(img, max_dim)
    kps, desc = extract_keypoints(img_resized, detector)

    # Serialize keypoints for caching
    keypoints_data = None
    if kps:
        keypoints_data = [
            (kp.pt[0], kp.pt[1], kp.size, kp.angle, kp.response, kp.octave, kp.class_id)
            for kp in kps
        ]

    fp = Fingerprint(
        phash64_8x=phashes,
        keypoint_count=len(kps),
        descriptors=desc,
        keypoints_data=keypoints_data
    )
    cache.set(fid, fp)
    return fp

###############################################################################
# Similarity and decision logic
###############################################################################

def phash_similarity_scores(hashes_a: List[int], hashes_b: List[int]) -> Tuple[float, int]:
    best_dist = 64
    for ha in hashes_a:
        for hb in hashes_b:
            d = phash_hamming_distance(ha, hb)
            if d < best_dist:
                best_dist = d
                if best_dist == 0:
                    return 1.0, 0
    similarity = 1.0 - (best_dist / 64.0)
    return similarity, best_dist

def compute_composite_similarity(
    metrics: PairMetrics,
    fp_a: Fingerprint,
    fp_b: Fingerprint,
    cfg: dict,
    dims_a: Tuple[int, int],
    dims_b: Tuple[int, int]
) -> float:
    """
    Compute deletion-safe similarity score.

    Returns a CONSERVATIVE LOWER BOUND on "safe to delete as redundant."

    100% unlock conditions (any one sufficient):
      - Perfect pHash + strong geometry
      - Perfect pHash + high texture + dimensional agreement

    100% is blocked by (any one sufficient):
      - Low texture without geometry confirmation
      - Dimension mismatch without geometry confirmation
      - pHash below 0.99

    Invariants:
      - pHash similarity is the base signal
      - Confirming signals can only UNLOCK higher confidence, never penalise
      - Absence of confirmation LIMITS upward movement, never reduces score
      - Nothing ever reduces score below pHash
    """
    base_score = metrics.phash_similarity

    # Texture as entropy proxy (necessary but not sufficient for 100% alone)
    texture_threshold = cfg["similarity"]["low_texture_keypoints_min"]
    is_low_texture = (fp_a.keypoint_count < texture_threshold or
                      fp_b.keypoint_count < texture_threshold)

    # Dimensional agreement: aspect ratio + plausible scale
    # This catches collisions between unrelated images that happen to hash similarly
    aspect_a = dims_a[0] / dims_a[1] if dims_a[1] > 0 else 1.0
    aspect_b = dims_b[0] / dims_b[1] if dims_b[1] > 0 else 1.0
    aspects_match = abs(aspect_a - aspect_b) <= cfg["blocking"]["aspect_ratio_tolerance"]

    # Scale ratio: one should be a plausible resize of the other
    # Policy: allow up to 16x area difference (4x linear scale)
    pixels_a = dims_a[0] * dims_a[1]
    pixels_b = dims_b[0] * dims_b[1]
    if pixels_a > 0 and pixels_b > 0:
        scale_ratio = max(pixels_a, pixels_b) / min(pixels_a, pixels_b)
        scale_plausible = scale_ratio <= 16.0
    else:
        scale_plausible = False

    dimensions_agree = aspects_match and scale_plausible

    # Geometry confirmation (when available)
    has_geometry = metrics.model not in ("none", "phash_only")

    geometry_confirmed = (
        has_geometry and
        metrics.inliers >= cfg["geometry"]["variant"]["min_inliers"] and
        metrics.coverage_a >= cfg["geometry"]["variant"]["coverage"] and
        metrics.coverage_b >= cfg["geometry"]["variant"]["coverage"]
    )

    geometry_strong = (
        geometry_confirmed and
        metrics.inliers >= cfg["geometry"]["duplicate"]["min_inliers"] and
        metrics.coverage_a >= cfg["geometry"]["duplicate"]["coverage"] and
        metrics.coverage_b >= cfg["geometry"]["duplicate"]["coverage"] and
        metrics.residual_median_px <= cfg["geometry"]["duplicate"]["reprojection_px"]
    )

    # === Scoring tiers ===

    if base_score >= 0.99:
        # Perfect pHash (Hamming distance 0)
        if geometry_strong:
            # Geometry confirms derivation: definite 100%
            return 1.0
        elif not is_low_texture and dimensions_agree:
            # High texture + dimensional agreement: 100% for phash_only path
            # Both conditions required to gate against collision-shaped false positives
            return 1.0
        elif not is_low_texture:
            # High texture but dimensions don't match: cap at 99%
            # Could be unrelated images that collided in pHash space
            return 0.99
        elif geometry_confirmed:
            # Low texture but geometry partially confirms
            return 0.99
        else:
            # Low texture, no confirmation: collision plausible
            return 0.98

    elif base_score >= 0.95:
        # Very high pHash (2-3 bits different)
        if geometry_strong:
            return 0.99
        elif geometry_confirmed:
            return 0.98
        else:
            # No boost for texture alone in this band
            # User must glance at 95-99% range anyway
            return base_score

    else:
        # Moderate pHash
        if geometry_strong:
            return min(base_score + 0.05, 0.97)
        elif geometry_confirmed:
            return min(base_score + 0.02, 0.95)
        else:
            return base_score


def decide_label(metrics: PairMetrics, fp_a: Fingerprint, fp_b: Fingerprint, cfg) -> str:
    low_texture_a = fp_a.keypoint_count < cfg["similarity"]["low_texture_keypoints_min"]
    low_texture_b = fp_b.keypoint_count < cfg["similarity"]["low_texture_keypoints_min"]
    if low_texture_a or low_texture_b:
        dup_thresh = cfg["similarity"]["low_texture_phash_duplicate"]
        var_thresh = cfg["similarity"]["low_texture_phash_variant"]
    else:
        dup_thresh = cfg["similarity"]["phash_duplicate"]
        var_thresh = cfg["similarity"]["phash_variant"]
    if (
        metrics.phash_similarity >= dup_thresh
        and metrics.inliers >= cfg["geometry"]["duplicate"]["min_inliers"]
        and metrics.coverage_a >= cfg["geometry"]["duplicate"]["coverage"]
        and metrics.coverage_b >= cfg["geometry"]["duplicate"]["coverage"]
        and metrics.residual_median_px <= cfg["geometry"]["duplicate"]["reprojection_px"]
    ):
        return "duplicate"
    if (
        metrics.phash_similarity >= var_thresh
        and metrics.inliers >= cfg["geometry"]["variant"]["min_inliers"]
        and metrics.coverage_a >= cfg["geometry"]["variant"]["coverage"]
        and metrics.coverage_b >= cfg["geometry"]["variant"]["coverage"]
        and metrics.residual_median_px <= cfg["geometry"]["variant"]["reprojection_px"]
    ):
        return "variant"
    return "different"

###############################################################################
# Blocking and candidate selection
###############################################################################

def assign_buckets(paths: List[Path], stats: Dict[Path, Tuple[int, int]], cfg) -> Dict[str, List[Path]]:
    buckets: Dict[str, List[Path]] = defaultdict(list)
    aspect_tol = cfg["blocking"]["aspect_ratio_tolerance"]
    size_thresholds = cfg["blocking"]["size_bucket_megapixels"]
    use_fs_magnitude = cfg["blocking"]["filesize_order_magnitude"]
    for p in paths:
        width, height = stats[p]
        aspect = width / height if height != 0 else 1.0
        aspect_bin = round(aspect / aspect_tol) * aspect_tol
        mp = (width * height) / 1_000_000.0
        bucket_idx = 0
        for i, th in enumerate(size_thresholds):
            if mp >= th:
                bucket_idx = i
        key_parts = [f"a{aspect_bin:.2f}", f"s{bucket_idx}"]
        if use_fs_magnitude:
            size_bytes = p.stat().st_size
            order = int(math.log10(size_bytes)) if size_bytes > 0 else 0
            key_parts.append(f"f{order}")
        key = ":".join(key_parts)
        buckets[key].append(p)
    return buckets

def build_lsh_map(hashes: Dict[Path, List[int]], radius: int) -> Dict[Path, List[Path]]:
    paths = list(hashes.keys())
    lsh: Dict[Path, List[Path]] = {p: [] for p in paths}
    for i, p in enumerate(paths):
        hp = hashes[p]
        for j in range(i + 1, len(paths)):
            q = paths[j]
            hq = hashes[q]
            best = 64
            for ha in hp:
                for hb in hq:
                    d = phash_hamming_distance(ha, hb)
                    if d < best:
                        best = d
                        if best <= radius:
                            break
                if best <= radius:
                    break
            if best <= radius:
                lsh[p].append(q)
                lsh[q].append(p)
    return lsh

###############################################################################
# Clustering
###############################################################################

def build_clusters(pairs: List[PairDecision], cfg, fingerprints: Dict[Path, Fingerprint], stats: Dict[Path, Tuple[int, int]]) -> List[Cluster]:
    adj: Dict[Path, List[Tuple[Path, float]]] = defaultdict(list)
    for pd in pairs:
        if pd.label == "different":
            continue
        # Use composite similarity for more accurate match percentage
        sim = compute_composite_similarity(
            pd.metrics, fingerprints[pd.a], fingerprints[pd.b],
            cfg, stats[pd.a], stats[pd.b]
        )
        adj[pd.a].append((pd.b, sim))
        adj[pd.b].append((pd.a, sim))
    visited: set[Path] = set()
    clusters: List[Cluster] = []
    sim_map: Dict[Tuple[Path, Path], float] = {}
    for pd in pairs:
        if pd.label != "different":
            # Use composite similarity instead of just pHash
            composite_sim = compute_composite_similarity(
                pd.metrics, fingerprints[pd.a], fingerprints[pd.b],
                cfg, stats[pd.a], stats[pd.b]
            )
            sim_map[(pd.a, pd.b)] = composite_sim
            sim_map[(pd.b, pd.a)] = composite_sim
    def rep_quality(p: Path) -> Tuple[int, int, int, int]:
        w, h = stats.get(p, (0, 0))
        pix = w * h
        kp = fingerprints[p].keypoint_count if p in fingerprints else 0
        try:
            st = p.stat()
            fsize = st.st_size
            mtime = st.st_mtime_ns
        except OSError:
            fsize = 0
            mtime = 0
        return (pix, kp, fsize, mtime)
    for node in adj:
        if node in visited:
            continue
        queue = deque([node])
        component: List[Path] = []
        visited.add(node)
        while queue:
            v = queue.popleft()
            component.append(v)
            for u, _sim in adj[v]:
                if u not in visited:
                    visited.add(u)
                    queue.append(u)
        rep = max(component, key=rep_quality)
        members: List[Path] = []
        member_sim: Dict[str, float] = {}
        for m in component:
            if m == rep:
                members.append(m)
                member_sim[str(m)] = -1.0  # Special marker for representative
                continue
            sim = sim_map.get((rep, m), 0.0)
            # Minimum threshold for cluster membership
            # With deletion-safe scoring, scores are >= pHash, so 0.70 aligns with variant threshold
            if sim >= 0.70:
                members.append(m)
                member_sim[str(m)] = sim
        members_sorted = [rep] + sorted([m for m in members if m != rep], key=rep_quality, reverse=True)
        cluster_id = f"cluster_{len(clusters):04d}"
        clusters.append(Cluster(id=cluster_id, members=members_sorted, representative=rep, member_similarities=member_sim))
    return clusters

###############################################################################
# Report generation
###############################################################################

def write_json_report(out_dir: Path, pairs: List[PairDecision], clusters: List[Cluster], cfg, errors: List[Tuple[Path, str]]) -> Path:
    report = {
        "config": cfg,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "stats": {
            "pairs_compared": len(pairs),
            "clusters": len(clusters),
            "duplicates": sum(1 for pd in pairs if pd.label == "duplicate"),
            "variants": sum(1 for pd in pairs if pd.label == "variant"),
            "different_sampled": sum(1 for pd in pairs if pd.label == "different"),
        },
        "pairs": [
            {
                "a": str(pd.a),
                "b": str(pd.b),
                "label": pd.label,
                "metrics": {
                    "phash_similarity": pd.metrics.phash_similarity,
                    "inliers": pd.metrics.inliers,
                    "coverage_a": pd.metrics.coverage_a,
                    "coverage_b": pd.metrics.coverage_b,
                    "residual_median_px": pd.metrics.residual_median_px,
                    "model": pd.metrics.model,
                },
            }
            for pd in pairs
        ],
        "clusters": [
            {
                "id": c.id,
                "members": [str(p) for p in c.members],
                "representative": str(c.representative),
                "member_similarities": c.member_similarities,
            }
            for c in clusters
        ],
        "errors": [
            {"path": str(p), "error": err}
            for p, err in errors
        ],
    }
    out_path = out_dir / "report.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    return out_path

def write_csv_report(out_dir: Path, pairs: List[PairDecision]) -> Path:
    out_path = out_dir / "pairs.csv"
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["a", "b", "label", "phash_similarity", "inliers", "coverage_a", "coverage_b", "residual_median_px", "model"])
        for pd in pairs:
            writer.writerow([
                str(pd.a), str(pd.b), pd.label,
                f"{pd.metrics.phash_similarity:.4f}",
                pd.metrics.inliers,
                f"{pd.metrics.coverage_a:.4f}",
                f"{pd.metrics.coverage_b:.4f}",
                f"{pd.metrics.residual_median_px:.4f}",
                pd.metrics.model,
            ])
    return out_path

def write_html_report(out_dir: Path, clusters: List[Cluster], cfg, detector) -> Path:
    """
    Generate an interactive HTML report for reviewing duplicate clusters.  Each cluster
    page presents thumbnails with colour‑coded borders based on similarity to the
    cluster representative, allows the user to click thumbnails to mark them
    for deletion and provides a button to export the marked list as a JSON file.

    The export uses browser localStorage to persist selections across cluster
    pages.  Marked images are not deleted by this script – a separate helper
    (see delete_marked.py) reads the JSON and safely moves files to a trash
    directory.
    """
    html_dir = out_dir / "html"
    thumbs_dir = html_dir / "thumbnails"
    html_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    pages: List[Tuple[str, str]] = []
    # Map of cluster id to its representative
    rep_map: Dict[str, Path] = {}
    for cluster in clusters:
        rep_map[cluster.id] = cluster.representative
    for cluster in clusters:
        page_name = f"{cluster.id}.html"
        title = f"Cluster {cluster.id} ({len(cluster.members)} files)"
        html_file = html_dir / page_name
        rows: List[Tuple[Path, float, Path]] = []
        for p in cluster.members:
            img = load_image_normalized(p, cfg)
            if img is None:
                continue
            thumb = build_thumbnail(img, cfg["io"]["thumbnail_max_px"])
            thumb_path = thumbs_dir / (p.name + ".jpg")
            thumb.save(thumb_path, format="JPEG")
            sim = cluster.member_similarities.get(str(p), 0.0)
            rows.append((thumb_path, sim, p))
        with html_file.open("w", encoding="utf-8") as f:
            f.write("<html><head><meta charset='utf-8'><title>")
            f.write(title)
            f.write("</title>")
            f.write("<style>")
            f.write("body{font-family:sans-serif;margin:0;padding:1em;}\n")
            f.write("header{position:sticky;top:0;background:#fff;padding:0.5em 0;z-index:10;border-bottom:1px solid #ccc;}\n")
            f.write("button{padding:0.5em 1em;font-size:1em;}\n")
            f.write("button:disabled{opacity:0.5;cursor:not-allowed;}\n")
            f.write(".grid{display:flex;flex-wrap:wrap;}\n")
            f.write(".item{margin:5px;position:relative;}\n")
            f.write(".item img{height:180px;display:block;cursor:pointer;border:4px solid transparent;box-sizing:border-box;}\n")
            f.write(".item img.rep{border-color:#2196f3;}\n")
            f.write(".item img.sim-high{border-color:#4caf50;}\n")
            f.write(".item img.sim-med{border-color:#ffc107;}\n")
            f.write(".item img.sim-low{border-color:#f44336;}\n")
            f.write(".item img.marked{outline:4px solid red;filter:brightness(0.7);}\n")
            f.write(".caption{text-align:center;font-size:0.8em;}\n")
            f.write("</style></head><body>")
            f.write("<header><button id='export' disabled>Export deletion list (<span id='count'>0</span>)</button></header>")
            f.write(f"<h2>{title}</h2>")
            f.write("<div class='grid'>")
            rep_path = rep_map.get(cluster.id)
            for thumb_path, sim, pth in rows:
                classes: List[str] = []
                # Check if this is the representative (sim == -1.0 marker or path match)
                is_rep = (sim < 0) or (rep_path and str(pth) == str(rep_path))
                if is_rep:
                    classes.append("rep")
                else:
                    # Thresholds for deletion-safe similarity scoring
                    # 85%+ = very high confidence, minimal review needed
                    # 70%+ = high confidence, quick glance recommended
                    # below 70% = lower confidence, visual comparison needed
                    if sim >= 0.85:
                        classes.append("sim-high")
                    elif sim >= 0.70:
                        classes.append("sim-med")
                    else:
                        classes.append("sim-low")
                f.write("<div class='item'>")
                cls_str = " ".join(classes)
                f.write(f"<a href='{pth.as_posix()}'><img class='thumb {cls_str}' data-path='{pth.as_posix()}' data-sim='{sim:.4f}' src='thumbnails/{thumb_path.name}' alt='{pth.name}'></a>")
                # Show just filename for representative, percentage for others
                if is_rep:
                    f.write(f"<div class='caption'>{pth.name}<br><small>REFERENCE</small></div>")
                else:
                    pct = int(sim * 100)
                    f.write(f"<div class='caption'>{pth.name}<br><small>{pct}% similar</small></div>")
                f.write("</div>")
            f.write("</div>")
            # JavaScript for marking and export
            f.write("<script>\n")
            f.write("(function(){\n")
            f.write("function updateExport(){\n")
            f.write("  const marked = JSON.parse(localStorage.getItem('markedPaths') || '[]');\n")
            f.write("  const btn = document.getElementById('export');\n")
            f.write("  const cnt = document.getElementById('count');\n")
            f.write("  cnt.textContent = marked.length;\n")
            f.write("  btn.disabled = (marked.length === 0);\n")
            f.write("}\n")
            f.write("function toggleMark(img){\n")
            f.write("  const path = img.dataset.path;\n")
            f.write("  let marked = JSON.parse(localStorage.getItem('markedPaths') || '[]');\n")
            f.write("  const idx = marked.indexOf(path);\n")
            f.write("  if(idx >= 0){\n")
            f.write("    marked.splice(idx,1);\n")
            f.write("    img.classList.remove('marked');\n")
            f.write("  } else {\n")
            f.write("    marked.push(path);\n")
            f.write("    img.classList.add('marked');\n")
            f.write("  }\n")
            f.write("  localStorage.setItem('markedPaths', JSON.stringify(marked));\n")
            f.write("  updateExport();\n")
            f.write("}\n")
            f.write("document.addEventListener('DOMContentLoaded', function(){\n")
            f.write("  const imgs = document.querySelectorAll('img.thumb');\n")
            f.write("  const marked = JSON.parse(localStorage.getItem('markedPaths') || '[]');\n")
            f.write("  imgs.forEach(function(img){\n")
            f.write("    if(marked.indexOf(img.dataset.path) >= 0){\n")
            f.write("      img.classList.add('marked');\n")
            f.write("    }\n")
            f.write("    img.addEventListener('click', function(ev){\n")
            f.write("      ev.preventDefault();\n")
            f.write("      toggleMark(img);\n")
            f.write("    });\n")
            f.write("  });\n")
            f.write("  document.getElementById('export').addEventListener('click', function(){\n")
            f.write("    const marked = JSON.parse(localStorage.getItem('markedPaths') || '[]');\n")
            f.write("    const data = JSON.stringify(marked, null, 2);\n")
            f.write("    const blob = new Blob([data], {type:'application/json'});\n")
            f.write("    const url = URL.createObjectURL(blob);\n")
            f.write("    const a = document.createElement('a');\n")
            f.write("    a.href = url;\n")
            f.write("    a.download = 'to_delete.json';\n")
            f.write("    document.body.appendChild(a);\n")
            f.write("    a.click();\n")
            f.write("    document.body.removeChild(a);\n")
            f.write("    URL.revokeObjectURL(url);\n")
            f.write("  });\n")
            f.write("  updateExport();\n")
            f.write("});\n")
            f.write("})();\n")
            f.write("</script>")
            f.write("</body></html>")
        pages.append((page_name, title))
    # Build index page
    index_file = html_dir / "index.html"
    with index_file.open("w", encoding="utf-8") as f:
        f.write("<html><head><meta charset='utf-8'><title>Duplicate Finder Report</title>")
        f.write("<style>body{font-family:sans-serif;margin:0;padding:1em;} ul{list-style:none;padding:0;} li{margin:5px 0;} a{text-decoration:none;color:#2196f3;} a:hover{text-decoration:underline;} header{position:sticky;top:0;background:#fff;padding:0.5em 0;border-bottom:1px solid #ccc;} button{padding:0.5em 1em;font-size:1em;} button:disabled{opacity:0.5;cursor:not-allowed;}</style>")
        f.write("</head><body>")
        f.write("<header><button id='export' disabled>Export deletion list (<span id='count'>0</span>)</button></header>")
        f.write("<h1>Duplicate Finder Report</h1>")
        f.write("<ul>")
        for page, title in pages:
            f.write(f"<li><a href='{page}'>{title}</a></li>")
        f.write("</ul>")
        # Script for export from index
        f.write("<script>\n")
        f.write("(function(){\n")
        f.write("function updateExport(){\n")
        f.write("  const marked = JSON.parse(localStorage.getItem('markedPaths') || '[]');\n")
        f.write("  const btn = document.getElementById('export');\n")
        f.write("  const cnt = document.getElementById('count');\n")
        f.write("  cnt.textContent = marked.length;\n")
        f.write("  btn.disabled = (marked.length === 0);\n")
        f.write("}\n")
        f.write("document.addEventListener('DOMContentLoaded', function(){\n")
        f.write("  document.getElementById('export').addEventListener('click', function(){\n")
        f.write("    const marked = JSON.parse(localStorage.getItem('markedPaths') || '[]');\n")
        f.write("    const data = JSON.stringify(marked, null, 2);\n")
        f.write("    const blob = new Blob([data], {type:'application/json'});\n")
        f.write("    const url = URL.createObjectURL(blob);\n")
        f.write("    const a = document.createElement('a');\n")
        f.write("    a.href = url;\n")
        f.write("    a.download = 'to_delete.json';\n")
        f.write("    document.body.appendChild(a);\n")
        f.write("    a.click();\n")
        f.write("    document.body.removeChild(a);\n")
        f.write("    URL.revokeObjectURL(url);\n")
        f.write("  });\n")
        f.write("  updateExport();\n")
        f.write("});\n")
        f.write("})();\n")
        f.write("</script>")
        f.write("</body></html>")
    return index_file

###############################################################################
# Main pipeline
###############################################################################

def process_directory(input_dir: Path, out_dir: Path, cfg, quick=False, rebuild_cache=False, dry_run=False):
    out_dir.mkdir(parents=True, exist_ok=True)

    # Use temporary cache (deleted after scan completes)
    import tempfile
    temp_cache = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
    cache_path = Path(temp_cache.name)
    temp_cache.close()
    cache = FingerprintCache(cache_path)
    
    print(f"\nScanning directory: {input_dir}")
    files = list_image_files(input_dir, cfg)
    print(f"Found {len(files)} image files")
    
    if len(files) == 0:
        print("\nNo images found. Check your input directory.")
        cache.close()
        return None, None, None
    
    stats: Dict[Path, Tuple[int, int]] = {}
    fingerprints: Dict[Path, Fingerprint] = {}
    errors: List[Tuple[Path, str]] = []
    detector = get_feature_detector(cfg)
    
    def worker(p):
        fp = compute_fingerprint(p, cfg, detector, cache)
        if fp is None:
            return p, None, None
        img = load_image_normalized(p, cfg)
        if img is None:
            return p, fp, None
        h, w = img.shape[:2]
        return p, fp, (w, h)
    
    print("\nComputing fingerprints...")
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(worker, p) for p in files]
        completed = 0
        for fut in concurrent.futures.as_completed(futures):
            p, fp, wh = fut.result()
            completed += 1
            if completed % 10 == 0 or completed == len(files):
                print(f"  Progress: {completed}/{len(files)}", end="\r")
            if fp is None or wh is None:
                errors.append((p, "decode_failed"))
                continue
            fingerprints[p] = fp
            stats[p] = wh
    print(f"\n  Processed {len(fingerprints)} images successfully")
    
    buckets = assign_buckets(list(stats.keys()), stats, cfg)
    pairs: List[PairDecision] = []
    
    print("\nComparing images...")
    total_comparisons = 0
    for bucket_key, paths in buckets.items():
        if len(paths) < 2:
            continue
        phash_map = {p: fingerprints[p].phash64_8x for p in paths}
        lsh_map = build_lsh_map(phash_map, cfg["blocking"]["lsh_hamming_radius"])
        compared_pairs = set()
        candidate_pairs: List[Tuple[Path, Path]] = []
        for p in paths:
            for q in lsh_map[p]:
                if p >= q:
                    continue
                if (p, q) in compared_pairs or (q, p) in compared_pairs:
                    continue
                compared_pairs.add((p, q))
                candidate_pairs.append((p, q))
        if not candidate_pairs:
            continue
        
        def compare_pair(pair: Tuple[Path, Path]) -> PairDecision:
            p, q = pair
            fp_a = fingerprints[p]
            fp_b = fingerprints[q]
            sim, _ = phash_similarity_scores(fp_a.phash64_8x, fp_b.phash64_8x)
            metrics = PairMetrics(phash_similarity=sim, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none")
            label = "different"
            if quick:
                if sim >= cfg["similarity"]["phash_duplicate"]:
                    label = "duplicate"
                elif sim >= cfg["similarity"]["phash_variant"]:
                    label = "variant"
                return PairDecision(a=p, b=q, label=label, metrics=metrics)
            img_a = load_image_normalized(p, cfg)
            img_b = load_image_normalized(q, cfg)
            if img_a is None or img_b is None:
                if sim >= cfg["similarity"]["phash_duplicate"]:
                    label = "duplicate"
                elif sim >= cfg["similarity"]["phash_variant"]:
                    label = "variant"
                return PairDecision(a=p, b=q, label=label, metrics=metrics)
            kps_a, desc_a = extract_keypoints(img_a, detector)
            kps_b, desc_b = extract_keypoints(img_b, detector)
            min_kp = cfg["similarity"]["low_texture_keypoints_min"]
            if len(kps_a) < min_kp and len(kps_b) < min_kp:
                if sim >= cfg["similarity"]["phash_duplicate"]:
                    label = "duplicate"
                elif sim >= cfg["similarity"]["phash_variant"]:
                    label = "variant"
                return PairDecision(a=p, b=q, label=label, metrics=metrics)
            matches = match_descriptors(desc_a, desc_b, cfg)
            model_name, geo_metrics = estimate_transform_and_metrics(kps_a, kps_b, matches, cfg)
            geo_metrics.phash_similarity = sim
            if model_name is None:
                return PairDecision(a=p, b=q, label="different", metrics=geo_metrics)
            label = decide_label(geo_metrics, fp_a, fp_b, cfg)
            return PairDecision(a=p, b=q, label=label, metrics=geo_metrics)
        
        max_workers = min(4, len(candidate_pairs))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            for result in pool.map(compare_pair, candidate_pairs):
                pairs.append(result)
                total_comparisons += 1
                if total_comparisons % 50 == 0:
                    print(f"  Comparisons: {total_comparisons}", end="\r")
    
    print(f"\n  Total comparisons: {total_comparisons}")
    
    print("\nBuilding clusters...")
    clusters = build_clusters(pairs, cfg, fingerprints, stats)
    print(f"  Found {len(clusters)} clusters")
    
    print("\nGenerating reports...")
    json_path = write_json_report(out_dir, pairs, clusters, cfg, errors)
    csv_path = None
    if cfg["report"]["write_csv"]:
        csv_path = write_csv_report(out_dir, pairs)
    html_path = write_html_report(out_dir, clusters, cfg, detector)
    
    cache.close()

    # Delete temporary cache file
    try:
        cache_path.unlink()
    except Exception:
        pass

    return json_path, csv_path, html_path

###############################################################################
# Command-line interface
###############################################################################

def validate_config(cfg: dict) -> None:
    for label in ["duplicate", "variant"]:
        geom = cfg["geometry"][label]
        if geom["reprojection_px"] <= 0:
            raise ValueError(f"geometry.{label}.reprojection_px must be positive")
        if geom["min_inliers"] < 0:
            raise ValueError(f"geometry.{label}.min_inliers must be non-negative")
        if not (0.0 <= geom["coverage"] <= 1.0):
            raise ValueError(f"geometry.{label}.coverage must be within [0,1]")
    smin, smax = cfg["geometry"]["scale_limits"]
    if smin <= 0 or smax <= 0 or smin >= smax:
        raise ValueError("geometry.scale_limits must be (min, max) with 0 < min < max")
    for key in ["phash_duplicate", "phash_variant", "low_texture_phash_duplicate", "low_texture_phash_variant"]:
        val = cfg["similarity"][key]
        if not (0.0 <= val <= 1.0):
            raise ValueError(f"similarity.{key} must be within [0,1]")
    if cfg["similarity"]["phash_variant"] > cfg["similarity"]["phash_duplicate"]:
        raise ValueError("phash_variant should not exceed phash_duplicate")
    if cfg["blocking"]["aspect_ratio_tolerance"] <= 0:
        raise ValueError("blocking.aspect_ratio_tolerance must be positive")
    if not cfg["blocking"]["size_bucket_megapixels"]:
        raise ValueError("blocking.size_bucket_megapixels must not be empty")

def load_config(config_path: Optional[Path]) -> dict:
    import importlib
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    if config_path:
        with config_path.open("r", encoding="utf-8") as f:
            suffix = config_path.suffix.lower()
            if suffix in (".yaml", ".yml"):
                try:
                    yaml = importlib.import_module("yaml")  # type: ignore
                except ImportError:
                    raise ImportError("PyYAML is required to load YAML configuration files. Install with `pip install pyyaml` or use JSON.")
                user_cfg = yaml.safe_load(f)
            else:
                user_cfg = json.load(f)
        def recursive_update(a: dict, b: dict):
            for k, v in b.items():
                if k in a and isinstance(a[k], dict) and isinstance(v, dict):
                    recursive_update(a[k], v)
                else:
                    a[k] = v
        recursive_update(cfg, user_cfg)
    validate_config(cfg)
    return cfg

def interactive_mode():
    print("\n" + "="*70)
    print("DUPLICATE IMAGE FINDER - Interactive Mode")
    print("="*70)
    
    while True:
        print("\nEnter the directory containing images to scan:")
        print("(Drag and drop a folder here, or type the path)")
        input_path = input("> ").strip().strip('"').strip("'")
        
        if not input_path:
            print("\nNo path provided.")
            continue
        
        input_dir = Path(input_path)
        if not input_dir.exists():
            print(f"\nError: Directory does not exist: {input_dir}")
            retry = input("Try again? (y/n): ").strip().lower()
            if retry != 'y':
                return None
            continue
        
        if not input_dir.is_dir():
            print(f"\nError: Not a directory: {input_dir}")
            retry = input("Try again? (y/n): ").strip().lower()
            if retry != 'y':
                return None
            continue
        
        break
    
    print("\nEnter output directory for reports:")
    print("(Press Enter to use: ./dupefinder_results)")
    output_path = input("> ").strip().strip('"').strip("'")
    
    if not output_path:
        output_dir = Path("./dupefinder_results")
    else:
        output_dir = Path(output_path)
    
    print(f"\nInput:  {input_dir}")
    print(f"Output: {output_dir}")
    
    quick = False
    use_quick = input("\nUse quick mode (hash-only, faster)? (y/n): ").strip().lower()
    if use_quick == 'y':
        quick = True
    
    return {
        'input': input_dir,
        'output': output_dir,
        'config': None,
        'quick': quick,
        'rebuild_cache': False,
        'dry_run': False,
    }

def main():
    try:
        if len(sys.argv) == 1:
            params = interactive_mode()
            if params is None:
                print("\nCancelled.")
                input("\nPress Enter to exit...")
                return

            input_dir = params['input']
            out_dir = params['output']
            cfg = load_config(params['config'])
            quick = params['quick']
            rebuild_cache = params['rebuild_cache']
            dry_run = params['dry_run']
        else:
            parser = argparse.ArgumentParser(description="Detect duplicate and variant images in a folder.")
            parser.add_argument("input", help="Input directory to scan")
            parser.add_argument("-o", "--output", required=True, help="Output directory for reports")
            parser.add_argument("--config", type=str, help="Path to JSON or YAML configuration file")
            parser.add_argument("--quick", action="store_true", help="Fast mode using only perceptual hash; skip geometry checks")
            parser.add_argument("--rebuild-cache", action="store_true", help="Ignore existing cache and recompute fingerprints")
            parser.add_argument("--dry-run", action="store_true", help="Process files but do not write reports")
            args = parser.parse_args()

            input_dir = Path(args.input).resolve()
            out_dir = Path(args.output).resolve()
            cfg = load_config(Path(args.config) if args.config else None)
            quick = args.quick
            rebuild_cache = args.rebuild_cache
            dry_run = args.dry_run

        print(f"\nStarting processing...")
        print(f"Input directory: {input_dir}")
        print(f"Output directory: {out_dir}")
        print(f"Quick mode: {quick}")

        cv2.setNumThreads(cfg["determinism"]["opencv_threads"])
        np.random.seed(cfg["determinism"]["seed"])

        print(f"\nCalling process_directory...")
        json_path, csv_path, html_path = process_directory(
            input_dir, out_dir, cfg,
            quick=quick,
            rebuild_cache=rebuild_cache,
            dry_run=dry_run
        )

        if json_path is None:
            print("\nProcessing failed or no images found.")
            print("Please check:")
            print(f"  1. The input directory exists: {input_dir}")
            print(f"  2. The directory contains image files (jpg, png, etc.)")
            print(f"  3. You have read permissions for the directory")
        elif dry_run:
            print("\nDry run complete. Reports not written.")
        else:
            print("\n" + "="*70)
            print("RESULTS")
            print("="*70)
            print(f"\nJSON report: {json_path}")
            if csv_path:
                print(f"CSV report:  {csv_path}")
            print(f"HTML report: {html_path}")
            print("\nOpen the HTML report in your browser to view results.")

    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
    except Exception as e:
        print(f"\n{'='*70}")
        print("ERROR")
        print(f"{'='*70}")
        print(f"\n{type(e).__name__}: {e}")
        print("\nFull error details:")
        import traceback
        traceback.print_exc()
        print("\nIf you need help, please report this error with the full traceback above.")
    finally:
        input("\nPress Enter to exit...")

if __name__ == "__main__":
    main()