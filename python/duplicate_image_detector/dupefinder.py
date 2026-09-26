#!/usr/bin/env python3

"""
dupefinder.py

This is a standalone script for detecting duplicate and near-duplicate images within
a directory tree.  It implements a lightweight perceptual hashing and
geometric‑matching pipeline without any machine learning dependencies.

Key features:

 * Walks a directory and filters for supported image formats.
 * Normalises each image to a canonical orientation and colour space.
 * Computes byte-exact and encoding-independent all-frame content identities
   before using an 8×8 perceptual hash (pHash) only to find candidates for
   geometric review.  Quick mode reports identities only.
 * Extracts ORB keypoints and binary descriptors using OpenCV, then matches
   descriptors with a brute‑force Hamming matcher and applies RANSAC to find
   a geometric transform between matched points.  This allows detection of
   crops, resizes, rotations and small edits.
 * Reserves `duplicate` for byte or decoded all-frame pixel identity.  A
   geometry-confirmed perceptual relationship is a `variant`; pHash alone can
   never create a positive label.
 * Groups every verified positive edge into deterministic connected components
   and keeps indirect members explicit rather than silently pruning them.
 * Writes a JSON report describing all pairwise decisions, a CSV file of
   decisions and a simple HTML report with thumbnails for human review.
 * Maintains a persistent SQLite fingerprint cache keyed by full-file SHA-256
   and the fingerprint-affecting configuration.

The script is designed to be deterministic.  It sets random seeds and
disables OpenCV threading to ensure reproducible results across runs.

Usage:

    python dupefinder.py INPUT_DIR --output OUTPUT_DIR

Or double-click to run interactively.

See `--help` for full usage.
"""

import argparse
import csv
import html
import json
import math
import os
import secrets
import sqlite3
import stat as stat_module
import struct
import sys
import threading
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import blake2b, sha256
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    from PIL import Image, ImageFile, ImageOps, UnidentifiedImageError  # type: ignore
except ImportError as e:
    print(f"\n{'='*70}")
    print("ERROR: Missing required dependency")
    print(f"{'='*70}")
    print(f"\n{e}\n")
    print("Please install required packages:")
    print("  pip install opencv-python-headless numpy pillow")
    print(f"\n{'='*70}")
    if getattr(sys.stdin, "isatty", lambda: False)():
        try:
            input("\nPress Enter to exit...")
        except EOFError:
            pass
    sys.exit(1)

# Pillow can throw DecompressionBombError on extremely large images.
Image.MAX_IMAGE_PIXELS = 178956970
ImageFile.LOAD_TRUNCATED_IMAGES = False

# Seeded NumPy RNG for reproducibility. The CLI applies the configured OpenCV
# thread count (one by default) before analysis.
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
        # Safety invariant: symlinks, junctions, and reparse-point entries are
        # always rejected.  These keys remain for old configuration files.
        "follow_symlinks": False,
        "resolve_symlinks_once": False,
        "max_image_pixels": 178956970,
        "max_frames": 10000,
        "max_total_decoded_pixels": 500_000_000,
        "max_total_decoded_bytes": 2_000_000_000,
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
        # Descriptor matches are always mutual and one-to-one.  This legacy
        # option is retained for configuration compatibility.
        "cross_check": True,
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
        # pHash values are candidate/geometry gates, not deletion confidence.
        # The duplicate key is retained for configuration compatibility;
        # positive identity decisions use SHA-256/all-frame content signatures.
        "phash_duplicate": 0.90,
        "phash_variant": 0.75,
        # Deprecated compatibility key.  Geometry is never skipped for a
        # perceptual label, regardless of pHash similarity.
        "phash_skip_geometric": 0.97,
        "low_texture_keypoints_min": 120,
        "low_texture_phash_duplicate": 0.94,
        "low_texture_phash_variant": 0.82,
    },
    "blocking": {
        # Retained for configuration compatibility and score display only.
        # Candidate generation no longer partitions on dimensions.
        "aspect_ratio_tolerance": 0.15,
        "size_bucket_megapixels": [0.25, 1, 2, 4, 8, 16, 32],
        "filesize_order_magnitude": False,
        # Legacy fallback.  The standalone scanner derives its radius from
        # the requested perceptual threshold via hamming_radius_for_similarity.
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
    sha256: str = ""


@dataclass(frozen=True)
class ContentSignature:
    """Encoding-independent, all-frame decoded image identity."""

    digest: str
    width: int
    height: int
    frame_count: int
    has_alpha: bool
    format: str


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
    # none, geometry, byte_exact, or pixel_exact.  Callers must explicitly
    # provide an identity kind before a score may reach 1.0.
    verification: str = "none"


@dataclass
class PairDecision:
    a: Path
    b: Path
    label: str
    metrics: PairMetrics
    match_kind: str = "different"


@dataclass
class Cluster:
    id: str
    members: List[Path]
    representative: Path
    # None denotes an indirect component member with no direct comparison to
    # the graph-central representative.  -1.0 remains the representative
    # marker for compatibility with existing callers.
    member_similarities: Dict[str, Optional[float]]
    member_match_kinds: Dict[str, str] = field(default_factory=dict)

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

    def clear(self) -> None:
        """Remove cached fingerprints without replacing the cache file."""
        with self._lock:
            self.conn.execute("DELETE FROM fingerprints")
            self.conn.commit()

###############################################################################
# Utility functions
###############################################################################

def compute_file_sha256(path: Path) -> str:
    """Return the SHA-256 digest of every byte in *path*."""
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _lstat_identity(path: Path) -> Tuple[int, int, int, int, int]:
    """Snapshot fields used to reject files that change across multi-read analysis."""
    status = path.lstat()
    return (
        int(status.st_dev),
        int(status.st_ino),
        int(status.st_size),
        int(status.st_mtime_ns),
        int(getattr(status, "st_file_attributes", 0)),
    )


def _linklike_from_status(path: Path, status: os.stat_result) -> bool:
    if stat_module.S_ISLNK(status.st_mode):
        return True
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction):
        try:
            if is_junction():
                return True
        except OSError:
            return True
    attributes = getattr(status, "st_file_attributes", 0)
    reparse_flag = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _scan_root_anchor(root: Path) -> Tuple[int, int, int]:
    """Bind a scan to one canonical, non-linked directory identity."""
    status = root.lstat()
    if not stat_module.S_ISDIR(status.st_mode) or _linklike_from_status(root, status):
        raise ValueError("scan root must be a real directory, not a link or reparse point")
    if root.resolve(strict=True) != root:
        raise ValueError("scan root canonical identity changed")
    return (
        int(status.st_dev),
        int(status.st_ino),
        int(getattr(status, "st_file_attributes", 0)),
    )


def _validated_source_identity(
    path: Path,
    root: Path,
    root_anchor: Tuple[int, int, int],
) -> Tuple[int, int, int, int, int]:
    """Reject linked, non-regular, replaced, or out-of-root scan sources."""
    if _scan_root_anchor(root) != root_anchor:
        raise ValueError("scan root identity changed")
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError("source escaped the selected scan root") from error
    if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("source has an unsafe relative path")

    current = root
    for part in relative.parts[:-1]:
        current = current / part
        status = current.lstat()
        if (
            not stat_module.S_ISDIR(status.st_mode)
            or _linklike_from_status(current, status)
        ):
            raise ValueError("source parent is linked or is not a directory")

    status = path.lstat()
    if not stat_module.S_ISREG(status.st_mode) or _linklike_from_status(path, status):
        raise ValueError("source is linked, reparsed, or not a regular file")
    resolved = path.resolve(strict=True)
    if resolved != path:
        raise ValueError("source canonical path changed")
    resolved.relative_to(root)
    if _scan_root_anchor(root) != root_anchor:
        raise ValueError("scan root identity changed during validation")
    return (
        int(status.st_dev),
        int(status.st_ino),
        int(status.st_size),
        int(status.st_mtime_ns),
        int(getattr(status, "st_file_attributes", 0)),
    )


def _canonical_metadata_value(value) -> Optional[Union[int, float, str, bool]]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return value
    return str(value)


def _image_has_alpha(image: Image.Image) -> bool:
    """Detect alpha channels and palette/key transparency without dropping it."""
    try:
        if "A" in image.getbands():
            return True
    except Exception:
        pass
    return "transparency" in image.info


def _exif_transposed_copy(image: Image.Image) -> Image.Image:
    """Return a detached frame with all eight EXIF orientations applied."""
    return ImageOps.exif_transpose(image.copy())


def _render_profile_blob(image: Image.Image) -> bytes:
    """Canonicalise rendering-relevant colour profile cues for identity gating."""
    parts: List[bytes] = []
    for key in ("icc_profile", "gamma", "chromaticity", "srgb"):
        if key not in image.info:
            continue
        value = image.info[key]
        if isinstance(value, bytes):
            encoded = value
        else:
            encoded = json.dumps(
                value,
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
        key_bytes = key.encode("ascii")
        parts.append(struct.pack("<I", len(key_bytes)) + key_bytes)
        parts.append(struct.pack("<Q", len(encoded)) + encoded)
    return b"".join(parts)


def compute_content_signature(path: Path, cfg=None) -> ContentSignature:
    """Compute stable decoded identity across every frame or page.

    The digest intentionally excludes container format and encoded bytes.  It
    includes each EXIF-transposed frame's RGBA pixels and dimensions, plus
    animation timing/disposal and loop metadata where those concepts apply.
    Consequently identical visible content may match across encodings, while
    later-frame, page-order, timing, disposal, and loop differences do not
    collapse together. Callers also gate identity on ``has_alpha`` so an RGB
    source and an alpha-capable source remain review-distinct even when every
    stored alpha value is opaque.
    """
    effective_cfg = cfg or DEFAULT_CFG
    io_cfg = effective_cfg.get("io", {})
    max_frames = int(io_cfg.get("max_frames", 10000))
    max_image_pixels = int(io_cfg.get("max_image_pixels", 178956970))
    max_total_pixels = int(io_cfg.get("max_total_decoded_pixels", 500_000_000))
    max_total_bytes = int(io_cfg.get("max_total_decoded_bytes", 2_000_000_000))
    if min(max_frames, max_image_pixels, max_total_pixels, max_total_bytes) <= 0:
        raise ValueError("content signature decode limits must be positive")

    digest = sha256()
    digest.update(b"dupefinder-content-v2\0")

    with Image.open(path) as image:
        image_format = (image.format or "").upper()
        frame_count = int(getattr(image, "n_frames", 1) or 1)
        if frame_count > max_frames:
            raise ValueError(f"frame/page limit exceeded ({frame_count} > {max_frames})")
        animated = frame_count > 1
        loop = _canonical_metadata_value(image.info.get("loop")) if animated else None
        digest.update(struct.pack("<I", frame_count))
        loop_blob = json.dumps(loop, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        digest.update(struct.pack("<I", len(loop_blob)))
        digest.update(loop_blob)
        root_profile = _render_profile_blob(image)
        digest.update(struct.pack("<Q", len(root_profile)))
        digest.update(root_profile)

        first_width = 0
        first_height = 0
        any_alpha = False
        total_pixels = 0
        total_bytes = 0

        for frame_index in range(frame_count):
            image.seek(frame_index)
            source_width, source_height = image.size
            source_pixels = source_width * source_height
            if source_pixels > max_image_pixels:
                raise ValueError(
                    f"frame/page pixel limit exceeded ({source_pixels} > {max_image_pixels})"
                )
            total_pixels += source_pixels
            if total_pixels > max_total_pixels:
                raise ValueError(
                    f"cumulative decoded pixel limit exceeded ({total_pixels} > {max_total_pixels})"
                )
            source_has_alpha = _image_has_alpha(image)
            frame = _exif_transposed_copy(image)
            source_has_alpha = source_has_alpha or _image_has_alpha(frame)
            rgba = frame.convert("RGBA")
            width, height = rgba.size
            if width * height != source_pixels:
                raise ValueError("EXIF transpose changed decoded pixel count unexpectedly")
            if frame_index == 0:
                first_width, first_height = width, height
            any_alpha = any_alpha or source_has_alpha

            duration = None
            disposal = None
            if animated:
                duration = _canonical_metadata_value(
                    frame.info.get("duration", image.info.get("duration"))
                )
                disposal = _canonical_metadata_value(
                    frame.info.get(
                        "disposal",
                        getattr(image, "disposal_method", image.info.get("disposal")),
                    )
                )

            metadata = json.dumps(
                {"duration": duration, "disposal": disposal},
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            frame_profile = _render_profile_blob(image)
            pixels = rgba.tobytes()
            total_bytes += len(pixels)
            if total_bytes > max_total_bytes:
                raise ValueError(
                    f"cumulative decoded byte limit exceeded ({total_bytes} > {max_total_bytes})"
                )
            digest.update(struct.pack("<III", frame_index, width, height))
            digest.update(struct.pack("<I", len(metadata)))
            digest.update(metadata)
            digest.update(struct.pack("<Q", len(frame_profile)))
            digest.update(frame_profile)
            digest.update(struct.pack("<Q", len(pixels)))
            digest.update(pixels)

        return ContentSignature(
            digest=digest.hexdigest(),
            width=first_width,
            height=first_height,
            frame_count=frame_count,
            has_alpha=any_alpha,
            format=image_format,
        )


def compute_quick_fingerprint(path: Path, max_bytes: int) -> str:
    """Legacy edge fingerprint retained for external compatibility."""
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


def _fingerprint_config_digest(cfg) -> str:
    relevant = {
        # Bump whenever cached feature semantics or validation changes.  V4
        # invalidates rows that could have been written by the old decode race.
        "algorithm_version": "fingerprint-v4",
        "opencv_version": getattr(cv2, "__version__", "unknown"),
        "pillow_version": getattr(Image, "__version__", "unknown"),
        "numpy_version": getattr(np, "__version__", "unknown"),
        "normalize": cfg.get("normalize", {}),
        "hash": cfg.get("hash", {}),
        "features": cfg.get("features", {}),
    }
    encoded = json.dumps(relevant, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return sha256(encoded).hexdigest()[:16]

def file_id_from_path(path: Path, cfg) -> FileId:
    stat = path.stat()
    device = stat.st_dev if cfg["cache"]["use_inode"] else None
    inode = stat.st_ino if cfg["cache"]["use_inode"] else None
    full_sha256 = compute_file_sha256(path)
    quick_fp = f"{full_sha256}:{_fingerprint_config_digest(cfg)}"
    mtime_ms = stat.st_mtime_ns // 1_000_000
    return FileId(
        path=path,
        size=stat.st_size,
        mtime_ms=mtime_ms,
        device=device,
        inode=inode,
        quick_fp=quick_fp,
        sha256=full_sha256,
    )

def list_image_files(root: Path, cfg) -> List[Path]:
    from fnmatch import fnmatch
    include_globs = cfg["io"]["include_globs"]
    exclude_globs = cfg["io"]["exclude_globs"]
    excluded_names = {
        ".git",
        "@eadir",
        "_dupes",
        ".dupefinder_cache",
        "dupefinder_cache",
        ".dupefinder_reports",
        "dupefinder_reports",
        "dupefinder_results",
    }

    def linked_or_reparse(path: Path) -> bool:
        try:
            if path.is_symlink():
                return True
        except OSError:
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction):
            try:
                if is_junction():
                    return True
            except OSError:
                return True
        try:
            attributes = getattr(path.lstat(), "st_file_attributes", 0)
        except OSError:
            return True
        reparse_flag = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return bool(attributes & reparse_flag)

    def excluded_directory(path: Path) -> bool:
        folded = path.name.casefold()
        return (
            folded in excluded_names
            or folded.endswith(".dupefinder_quarantine")
            or folded.endswith(".dupefinder_cache")
            or folded.endswith(".dupefinder_report")
            or folded.endswith(".dupefinder_reports")
            or folded.startswith(".dupefinder-incomplete-")
            or (path / ".dupefinder-report").is_file()
        )

    def excluded_relative(relative: str) -> bool:
        relative_posix = relative.replace(os.sep, "/")
        candidates = (relative_posix, f"./{relative_posix}")
        return any(fnmatch(candidate, pattern) for candidate in candidates for pattern in exclude_globs)

    files: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current_dir = Path(dirpath)
        dirnames[:] = sorted(
            (
                dirname
                for dirname in dirnames
                if not linked_or_reparse(current_dir / dirname)
                and not excluded_directory(current_dir / dirname)
                and not excluded_relative(
                    str((current_dir / dirname).relative_to(root)).replace(os.sep, "/") + "/"
                )
            ),
            key=str.casefold,
        )
        rel_dir = os.path.relpath(dirpath, root)
        for filename in sorted(filenames, key=str.casefold):
            rel_path = os.path.join(rel_dir, filename) if rel_dir != "." else filename
            full_path = Path(root) / rel_path
            if linked_or_reparse(full_path):
                continue
            try:
                if not full_path.is_file():
                    continue
            except OSError:
                continue
            if excluded_relative(rel_path):
                continue
            if not any(fnmatch(filename.casefold(), pat.casefold()) for pat in include_globs):
                continue
            files.append(full_path)
    return sorted(files, key=lambda path: os.path.normcase(str(path)))

###############################################################################
# Image normalisation and hashing
###############################################################################

def load_image_normalized(path: Path, cfg) -> Optional[np.ndarray]:
    """Load frame zero as EXIF-oriented RGB on an explicit matte.

    Alpha-bearing modes, including palette transparency, are converted through
    RGBA before compositing.  This RGB representation is for hashing/features;
    use load_image_rgba() for a lossless-alpha preview.
    """
    try:
        with Image.open(path) as im:
            im.seek(0)
            source_has_alpha = _image_has_alpha(im)
            frame = _exif_transposed_copy(im)
            source_has_alpha = source_has_alpha or _image_has_alpha(frame)
            if source_has_alpha:
                rgba = frame.convert("RGBA")
                color = tuple(int(channel) for channel in cfg["normalize"]["alpha_matte_rgb"])
                matte = Image.new("RGB", rgba.size, color)
                matte.paste(rgba, mask=rgba.getchannel("A"))
                normalized = matte
            else:
                normalized = frame.convert(cfg["normalize"]["target_mode"])
            return np.array(normalized)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return None


def load_image_rgba(path: Path, frame_index: int = 0) -> Optional[Image.Image]:
    """Load one EXIF-oriented frame/page as detached, lossless RGBA pixels."""
    try:
        with Image.open(path) as image:
            frame_count = int(getattr(image, "n_frames", 1) or 1)
            if frame_index < 0 or frame_index >= frame_count:
                return None
            image.seek(frame_index)
            return _exif_transposed_copy(image).convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, EOFError):
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
    matcher = cv2.BFMatcher(norm_type, crossCheck=False)

    def ratio_filtered(query: np.ndarray, train: np.ndarray) -> Dict[int, cv2.DMatch]:
        try:
            candidates = matcher.knnMatch(query, train, k=2)
        except cv2.error:
            return {}
        ratio = cfg["match"]["ratio_test"]
        accepted: Dict[int, cv2.DMatch] = {}
        for pair in candidates:
            if len(pair) != 2:
                continue
            first, second = pair
            if first.distance < ratio * second.distance:
                accepted[first.queryIdx] = first
        return accepted

    forward = ratio_filtered(desc_a, desc_b)
    reverse = ratio_filtered(desc_b, desc_a)
    mutual: List[cv2.DMatch] = []
    used_train: set[int] = set()
    for query_index in sorted(forward):
        match = forward[query_index]
        reverse_match = reverse.get(match.trainIdx)
        if reverse_match is None or reverse_match.trainIdx != query_index:
            continue
        if match.trainIdx in used_train:
            continue
        used_train.add(match.trainIdx)
        mutual.append(match)
    return sorted(mutual, key=lambda match: (match.distance, match.queryIdx, match.trainIdx))


def _convex_hull_area(points: np.ndarray) -> float:
    if points is None or len(points) < 3:
        return 0.0
    try:
        hull = cv2.convexHull(np.asarray(points, dtype=np.float32))
        area = float(cv2.contourArea(hull))
    except (cv2.error, TypeError, ValueError):
        return 0.0
    return area if math.isfinite(area) and area > 0.0 else 0.0

def estimate_transform_and_metrics(
    kps_a: List[cv2.KeyPoint],
    kps_b: List[cv2.KeyPoint],
    matches: List[cv2.DMatch],
    cfg,
) -> Tuple[Optional[str], PairMetrics]:
    if not matches:
        return None, PairMetrics(phash_similarity=0.0, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none", verification="none")
    pts_a = np.float32([kps_a[m.queryIdx].pt for m in matches])
    pts_b = np.float32([kps_b[m.trainIdx].pt for m in matches])
    extent_area_a = _convex_hull_area(np.float32([keypoint.pt for keypoint in kps_a]))
    extent_area_b = _convex_hull_area(np.float32([keypoint.pt for keypoint in kps_b]))
    if extent_area_a <= 1.0 or extent_area_b <= 1.0:
        return None, PairMetrics(phash_similarity=0.0, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none", verification="none")

    best_model: Optional[str] = None
    best_inliers = 0
    best_coverage_a = 0.0
    best_coverage_b = 0.0
    best_residual = float("inf")
    model_params = cfg["geometry"]
    try:
        cv2.setRNGSeed(int(cfg.get("determinism", {}).get("seed", 1337)))
    except (AttributeError, TypeError, ValueError):
        pass

    for model in cfg["geometry"]["ransac_model_order"]:
        if model == "homography" and len(matches) < 4:
            continue
        if model == "affine" and len(matches) < 3:
            continue
        if model == "similarity" and len(matches) < 2:
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
        except cv2.error:
            continue

        if mask is None:
            continue
        H = np.asarray(H, dtype=np.float64)
        if H.shape != (3, 3) or not np.isfinite(H).all():
            continue
        if abs(float(H[2, 2])) <= 1e-12:
            continue
        H = H / H[2, 2]
        if not np.isfinite(H).all() or abs(float(np.linalg.det(H))) <= 1e-12:
            continue
        try:
            condition = float(np.linalg.cond(H))
        except np.linalg.LinAlgError:
            continue
        if not math.isfinite(condition) or condition > 1e10:
            continue

        if model in ("similarity", "affine"):
            linear = H[:2, :2]
            try:
                singular_values = np.linalg.svd(linear, compute_uv=False)
            except np.linalg.LinAlgError:
                continue
            if (
                len(singular_values) != 2
                or not np.isfinite(singular_values).all()
                or singular_values[1] <= 1e-8
                or singular_values[0] / singular_values[1] > 20.0
            ):
                continue

        inlier_mask = mask.reshape(-1).astype(bool)
        pts_a_h = np.hstack([pts_a, np.ones((pts_a.shape[0], 1), dtype=np.float32)])
        pts_b_pred_h = (H @ pts_a_h.T).T
        denominators = pts_b_pred_h[:, 2]
        valid_projection = np.isfinite(pts_b_pred_h).all(axis=1) & (np.abs(denominators) > 1e-12)
        inlier_mask &= valid_projection
        inliers = int(inlier_mask.sum())
        if inliers < 3:
            continue
        pts_b_pred = np.full((len(pts_b_pred_h), 2), np.nan, dtype=np.float64)
        pts_b_pred[valid_projection] = (
            pts_b_pred_h[valid_projection, :2] / denominators[valid_projection, None]
        )
        residuals = np.linalg.norm(pts_b - pts_b_pred, axis=1)
        inlier_residuals = residuals[inlier_mask]
        median_residual = float(np.median(inlier_residuals)) if len(inlier_residuals) else float("inf")
        if not math.isfinite(median_residual):
            continue

        inlier_area_a = _convex_hull_area(pts_a[inlier_mask])
        inlier_area_b = _convex_hull_area(pts_b[inlier_mask])
        if inlier_area_a <= 1.0 or inlier_area_b <= 1.0:
            continue
        linear_scale = math.sqrt(inlier_area_b / inlier_area_a)
        smin, smax = cfg["geometry"]["scale_limits"]
        if not math.isfinite(linear_scale) or linear_scale < smin or linear_scale > smax:
            continue

        coverage_a = min(1.0, inlier_area_a / extent_area_a)
        coverage_b = min(1.0, inlier_area_b / extent_area_b)
        candidate_key = (inliers, min(coverage_a, coverage_b), -median_residual)
        best_key = (best_inliers, min(best_coverage_a, best_coverage_b), -best_residual)
        if best_model is None or candidate_key > best_key:
            best_model = model
            best_inliers = inliers
            best_coverage_a = coverage_a
            best_coverage_b = coverage_b
            best_residual = median_residual

    if best_model is None:
        return None, PairMetrics(phash_similarity=0.0, inliers=0, coverage_a=0.0, coverage_b=0.0, residual_median_px=float("inf"), model="none", verification="none")
    metrics = PairMetrics(
        phash_similarity=0.0,
        inliers=best_inliers,
        coverage_a=best_coverage_a,
        coverage_b=best_coverage_b,
        residual_median_px=best_residual,
        model=best_model,
        verification="geometry",
    )
    return best_model, metrics

def compute_fingerprint(
    path: Path,
    cfg,
    detector,
    cache: FingerprintCache,
    fid: Optional[FileId] = None,
) -> Optional[Fingerprint]:
    fid = fid or file_id_from_path(path, cfg)
    cached = cache.get(fid)
    if cached:
        return cached
    identity_before = _lstat_identity(path)
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
    # Never persist pixels decoded from a file that no longer has the SHA used
    # as this cache key.  The caller also validates its wider multi-read scan,
    # but that happens after this function and cannot retract a poisoned row.
    digest_after = compute_file_sha256(path)
    identity_after = _lstat_identity(path)
    if identity_after != identity_before or digest_after != fid.sha256:
        raise ValueError("file changed while its perceptual fingerprint was computed")
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
    Return a review-oriented similarity score, not deletion probability.

    Only explicit byte or decoded all-frame pixel identity may return 1.0.
    Unverified/pHash-only pairs return zero.  Geometric variants are scored
    below 1.0 using pHash, spatial coverage, inliers, and residual quality.
    """
    if metrics.verification in ("byte_exact", "pixel_exact"):
        return 1.0
    if metrics.verification != "geometry" or metrics.model in ("none", "phash_only", "identity"):
        return 0.0
    if not all(
        math.isfinite(value)
        for value in (
            metrics.phash_similarity,
            metrics.coverage_a,
            metrics.coverage_b,
            metrics.residual_median_px,
        )
    ):
        return 0.0

    variant_cfg = cfg["geometry"]["variant"]
    coverage_score = min(max(metrics.coverage_a, 0.0), max(metrics.coverage_b, 0.0), 1.0)
    inlier_target = max(1, variant_cfg["min_inliers"] * 2)
    inlier_score = min(1.0, metrics.inliers / inlier_target)
    residual_limit = max(float(variant_cfg["reprojection_px"]), 1e-9)
    residual_score = max(0.0, 1.0 - (metrics.residual_median_px / residual_limit))
    phash_score = min(1.0, max(0.0, metrics.phash_similarity))
    score = (
        0.50 * phash_score
        + 0.25 * coverage_score
        + 0.15 * inlier_score
        + 0.10 * residual_score
    )
    return min(0.99, max(0.0, score))


def decide_label(metrics: PairMetrics, fp_a: Fingerprint, fp_b: Fingerprint, cfg) -> str:
    if metrics.verification in ("byte_exact", "pixel_exact"):
        return "duplicate"
    if metrics.verification != "geometry" or metrics.model in ("none", "phash_only", "identity"):
        return "different"
    low_texture_a = fp_a.keypoint_count < cfg["similarity"]["low_texture_keypoints_min"]
    low_texture_b = fp_b.keypoint_count < cfg["similarity"]["low_texture_keypoints_min"]
    if low_texture_a or low_texture_b:
        var_thresh = cfg["similarity"]["low_texture_phash_variant"]
    else:
        var_thresh = cfg["similarity"]["phash_variant"]
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
    """Return one deterministic candidate pool.

    Dimension buckets previously made resized, rotated, cropped, and
    boundary-adjacent copies impossible to compare.  The public function is
    retained for server compatibility, but it no longer blocks by dimensions.
    """
    del stats, cfg
    return {"all": sorted(paths, key=lambda path: os.path.normcase(str(path)))}


def hamming_radius_for_similarity(threshold: float, bits: int = 64) -> int:
    """Largest integer Hamming distance whose similarity meets *threshold*."""
    if not math.isfinite(float(threshold)) or not 0.0 <= float(threshold) <= 1.0:
        raise ValueError("similarity threshold must be within [0,1]")
    if bits <= 0:
        raise ValueError("bits must be positive")
    radius = math.floor(((1.0 - float(threshold)) * bits) + 1e-12)
    return max(0, min(bits, radius))


def candidate_similarity_threshold(cfg: dict) -> float:
    """Lowest configured perceptual threshold that candidate search must honour."""
    return min(
        float(cfg["similarity"]["phash_variant"]),
        float(cfg["similarity"]["low_texture_phash_variant"]),
    )

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
    del stats

    allowed_verification = {"byte_exact", "pixel_exact", "geometry"}
    adjacency: Dict[Path, Dict[Path, PairDecision]] = defaultdict(dict)
    similarity_map: Dict[Tuple[Path, Path], float] = {}
    kind_map: Dict[Tuple[Path, Path], str] = {}

    for decision in pairs:
        if decision.label == "different" or decision.metrics.verification not in allowed_verification:
            continue
        similarity = compute_composite_similarity(
            decision.metrics,
            fingerprints[decision.a],
            fingerprints[decision.b],
            cfg,
            (0, 0),
            (0, 0),
        )
        existing = similarity_map.get((decision.a, decision.b), -1.0)
        if similarity < existing:
            continue
        adjacency[decision.a][decision.b] = decision
        adjacency[decision.b][decision.a] = decision
        similarity_map[(decision.a, decision.b)] = similarity
        similarity_map[(decision.b, decision.a)] = similarity
        kind = decision.match_kind
        if kind == "different":
            kind = {
                "byte_exact": "byte_exact",
                "pixel_exact": "pixel_exact",
                "geometry": "perceptual_variant",
            }[decision.metrics.verification]
        kind_map[(decision.a, decision.b)] = kind
        kind_map[(decision.b, decision.a)] = kind

    path_key = lambda path: os.path.normcase(str(path))

    def distances_from(start: Path, component_set: set[Path]) -> Dict[Path, int]:
        distances = {start: 0}
        queue = deque([start])
        while queue:
            node = queue.popleft()
            for neighbour in sorted(adjacency[node], key=path_key):
                if neighbour not in component_set or neighbour in distances:
                    continue
                distances[neighbour] = distances[node] + 1
                queue.append(neighbour)
        return distances

    visited: set[Path] = set()
    clusters: List[Cluster] = []
    for start in sorted(adjacency, key=path_key):
        if start in visited:
            continue
        queue = deque([start])
        component: List[Path] = []
        visited.add(start)
        while queue:
            node = queue.popleft()
            component.append(node)
            for neighbour in sorted(adjacency[node], key=path_key):
                if neighbour in visited:
                    continue
                visited.add(neighbour)
                queue.append(neighbour)

        component_set = set(component)

        def centrality_key(candidate: Path):
            distances = distances_from(candidate, component_set)
            distance_sum = sum(distances.values())
            degree = len(adjacency[candidate])
            weight_sum = sum(similarity_map[(candidate, neighbour)] for neighbour in adjacency[candidate])
            return (distance_sum, -degree, -weight_sum, path_key(candidate))

        representative = min(component, key=centrality_key)
        representative_distances = distances_from(representative, component_set)
        ordered_others = sorted(
            (member for member in component if member != representative),
            key=lambda member: (representative_distances[member], path_key(member)),
        )
        members = [representative, *ordered_others]
        member_similarities: Dict[str, Optional[float]] = {str(representative): -1.0}
        member_match_kinds = {str(representative): "reference"}
        for member in ordered_others:
            member_similarities[str(member)] = similarity_map.get((representative, member))
            member_match_kinds[str(member)] = kind_map.get((representative, member), "indirect")

        clusters.append(
            Cluster(
                id=f"cluster_{len(clusters):04d}",
                members=members,
                representative=representative,
                member_similarities=member_similarities,
                member_match_kinds=member_match_kinds,
            )
        )
    return clusters

###############################################################################
# Report generation
###############################################################################

def write_json_report(out_dir: Path, pairs: List[PairDecision], clusters: List[Cluster], cfg, errors: List[Tuple[Path, str]]) -> Path:
    def finite_or_none(value: float) -> Optional[float]:
        return float(value) if math.isfinite(float(value)) else None

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
                "match_kind": pd.match_kind,
                "metrics": {
                    "phash_similarity": finite_or_none(pd.metrics.phash_similarity),
                    "inliers": pd.metrics.inliers,
                    "coverage_a": finite_or_none(pd.metrics.coverage_a),
                    "coverage_b": finite_or_none(pd.metrics.coverage_b),
                    "residual_median_px": finite_or_none(pd.metrics.residual_median_px),
                    "model": pd.metrics.model,
                    "verification": pd.metrics.verification,
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
                "member_match_kinds": c.member_match_kinds,
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
        json.dump(report, f, indent=2, allow_nan=False)
    return out_path

def write_csv_report(out_dir: Path, pairs: List[PairDecision]) -> Path:
    out_path = out_dir / "pairs.csv"
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "a", "b", "label", "match_kind", "verification",
            "phash_similarity", "inliers", "coverage_a", "coverage_b",
            "residual_median_px", "model",
        ])
        for pd in pairs:
            writer.writerow([
                str(pd.a), str(pd.b), pd.label, pd.match_kind, pd.metrics.verification,
                f"{pd.metrics.phash_similarity:.4f}",
                pd.metrics.inliers,
                f"{pd.metrics.coverage_a:.4f}",
                f"{pd.metrics.coverage_b:.4f}",
                "" if not math.isfinite(pd.metrics.residual_median_px) else f"{pd.metrics.residual_median_px:.4f}",
                pd.metrics.model,
            ])
    return out_path


def _safe_display_text(value: object) -> str:
    """Render control and bidi-format characters visibly in review labels."""
    rendered: List[str] = []
    for character in str(value):
        codepoint = ord(character)
        unsafe = (
            codepoint <= 0x1F
            or 0x7F <= codepoint <= 0x9F
            or codepoint == 0x061C
            or codepoint in (0x200E, 0x200F)
            or 0x202A <= codepoint <= 0x202E
            or 0x2066 <= codepoint <= 0x2069
        )
        if not unsafe:
            rendered.append(character)
        elif codepoint == 0x09:
            rendered.append("\\t")
        elif codepoint == 0x0A:
            rendered.append("\\n")
        elif codepoint == 0x0D:
            rendered.append("\\r")
        elif codepoint <= 0xFFFF:
            rendered.append(f"\\u{codepoint:04x}")
        else:
            rendered.append(f"\\U{codepoint:08x}")
    return "".join(rendered)

def write_html_report(
    out_dir: Path,
    clusters: List[Cluster],
    cfg,
    detector,
    report_id: Optional[str] = None,
    source_validator=None,
) -> Path:
    """Generate one self-contained review page with report-scoped selections.

    A single page avoids browser-dependent localStorage isolation between
    file URL pages. Stored values are opaque IDs filtered through this
    report's immutable ID-to-path map; exports cannot inherit stale paths from
    another report. This function never moves or deletes source files.
    """
    del detector
    html_dir = out_dir / "html"
    thumbs_dir = html_dir / "thumbnails"
    html_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    report_id = report_id or secrets.token_hex(16)
    all_members = sorted(
        {path for cluster in clusters for path in cluster.members},
        key=lambda path: os.path.normcase(str(path)),
    )
    member_ids = {
        path: blake2b(
            report_id.encode("ascii")
            + b"\0"
            + str(path.absolute()).encode("utf-8", errors="surrogatepass"),
            digest_size=16,
        ).hexdigest()
        for path in all_members
    }
    report_data = {
        "id": report_id,
        "members": {
            member_ids[path]: str(path.absolute())
            for path in all_members
        },
    }
    report_json = json.dumps(
        report_data,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")

    rendered_clusters = []
    for cluster in clusters:
        title = f"Cluster {cluster.id} ({len(cluster.members)} files)"
        try:
            common_root = Path(
                os.path.commonpath([str(path.parent) for path in cluster.members])
            )
        except (ValueError, OSError):
            common_root = None

        rows = []
        for path in cluster.members:
            if source_validator is not None:
                source_validator(path)
            preview = load_image_rgba(path)
            if preview is None:
                continue
            if source_validator is not None:
                source_validator(path)
            try:
                from PIL.Image import Resampling
                preview.thumbnail(
                    (cfg["io"]["thumbnail_max_px"], cfg["io"]["thumbnail_max_px"]),
                    Resampling.LANCZOS,
                )
            except (ImportError, AttributeError):
                preview.thumbnail(
                    (cfg["io"]["thumbnail_max_px"], cfg["io"]["thumbnail_max_px"]),
                    Image.LANCZOS,
                )
            path_identity = os.path.normcase(str(path.absolute())).encode(
                "utf-8", errors="surrogatepass"
            )
            thumb_name = blake2b(path_identity, digest_size=12).hexdigest() + ".png"
            thumb_path = thumbs_dir / thumb_name
            preview.save(thumb_path, format="PNG")
            rows.append(
                (
                    thumb_path,
                    cluster.member_similarities.get(str(path)),
                    path,
                    cluster.member_match_kinds.get(str(path), "indirect"),
                    member_ids[path],
                )
            )
        rendered_clusters.append((cluster, title, common_root, rows))

    index_file = html_dir / "index.html"
    with index_file.open("w", encoding="utf-8") as report:
        report.write("<!doctype html><html><head><meta charset='utf-8'>")
        report.write("<meta name='viewport' content='width=device-width,initial-scale=1'>")
        report.write("<title>Duplicate Finder Review Report</title><style>")
        report.write("body{font-family:sans-serif;margin:0;padding:1em;color:#222}")
        report.write("header{position:sticky;top:0;background:#fff;padding:.6em 0;z-index:10;border-bottom:1px solid #ccc}")
        report.write("button{padding:.5em 1em;font-size:1em}button:disabled{opacity:.5;cursor:not-allowed}")
        report.write("nav ul{display:flex;flex-wrap:wrap;gap:.5em 1em;list-style:none;padding:0}")
        report.write("section{padding-top:1em;border-top:1px solid #ddd;margin-top:1.5em}")
        report.write(".grid{display:flex;flex-wrap:wrap}.item{margin:5px;position:relative}")
        report.write(".thumb-toggle{border:0;background:transparent;padding:0;display:block}")
        report.write(".item img{height:180px;display:block;cursor:pointer;border:4px solid transparent;box-sizing:border-box}")
        report.write(".item img.rep{border-color:#2196f3}.item img.sim-high{border-color:#4caf50}")
        report.write(".item img.sim-med{border-color:#ffc107}.item img.sim-low{border-color:#f44336}")
        report.write(".item img.sim-indirect{border-color:#9e9e9e}.item img.marked{outline:4px solid red;filter:brightness(.7)}")
        report.write(".caption{text-align:center;font-size:.8em}.path{max-width:320px;overflow-wrap:anywhere;color:#666}")
        report.write("</style></head><body>")
        report.write("<header><button id='export' disabled>Export review list (<span id='count'>0</span>)</button></header>")
        report.write("<h1>Duplicate Finder Review Report</h1>")
        report.write("<p>Selections are exported for review only. This report takes no file action.</p>")
        report.write("<p>The blue item is a comparison reference, not a quality recommendation.</p>")
        report.write("<nav aria-label='Result groups'><ul>")
        for cluster, title, _common_root, _rows in rendered_clusters:
            anchor = "cluster-" + html.escape(cluster.id, quote=True)
            report.write(
                f"<li><a href='#{anchor}'>{html.escape(_safe_display_text(title))}</a></li>"
            )
        report.write("</ul></nav>")

        for cluster, title, common_root, rows in rendered_clusters:
            anchor = "cluster-" + html.escape(cluster.id, quote=True)
            report.write(
                f"<section id='{anchor}'><h2>{html.escape(_safe_display_text(title))}</h2>"
                "<div class='grid'>"
            )
            representative = cluster.representative
            for thumb_path, similarity, path, kind, member_id in rows:
                is_reference = (
                    similarity is not None
                    and similarity < 0
                ) or str(path) == str(representative)
                if is_reference:
                    css_class = "rep"
                    label = "COMPARISON REFERENCE"
                elif kind == "byte_exact":
                    css_class = "sim-high"
                    label = "BYTE-EXACT"
                elif kind == "pixel_exact":
                    css_class = "sim-med"
                    label = (
                        "ALL-FRAME PIXEL MATCH · METADATA/ENCODING MAY DIFFER · "
                        "MANUAL REVIEW"
                    )
                elif similarity is None:
                    css_class = "sim-indirect"
                    label = "INDIRECT COMPONENT MATCH"
                elif similarity >= 0.85:
                    css_class = "sim-high"
                    label = f"{int(similarity * 100)}% similar · {kind.replace('_', ' ').upper()}"
                elif similarity >= 0.70:
                    css_class = "sim-med"
                    label = f"{int(similarity * 100)}% similar · {kind.replace('_', ' ').upper()}"
                else:
                    css_class = "sim-low"
                    label = f"{int(similarity * 100)}% similar · {kind.replace('_', ' ').upper()}"

                display_name = _safe_display_text(path.name)
                name_text = html.escape(display_name)
                name_attr = html.escape(display_name, quote=True)
                try:
                    relative_value = (
                        str(path.relative_to(common_root))
                        if common_root is not None
                        else path.name
                    )
                except ValueError:
                    relative_value = path.name
                relative_text = html.escape(_safe_display_text(relative_value))
                full_path_text = html.escape(_safe_display_text(path))
                id_attr = html.escape(member_id, quote=True)
                report.write("<div class='item'>")
                report.write(
                    f"<button type='button' class='thumb-toggle' data-result-id='{id_attr}' "
                    f"aria-label='Toggle {name_attr} for review'>"
                    f"<img class='thumb {css_class}' src='thumbnails/{thumb_path.name}' "
                    f"alt='{name_attr}'></button>"
                )
                report.write(
                    f"<div class='caption'>{name_text}<br><small>{html.escape(label)}</small></div>"
                )
                report.write(
                    f"<div class='caption path'><small>{relative_text}<br>{full_path_text}</small></div>"
                )
                report.write("</div>")
            report.write("</div></section>")

        report.write("<script>window.DUPEFINDER_REPORT=Object.freeze(")
        report.write(report_json)
        report.write(");</script><script>")
        report.write("""
(function(){
  const report = window.DUPEFINDER_REPORT;
  if(!report || !report.id || !report.members){ return; }
  const storageKey = 'dupefinderReview:' + report.id;
  let memoryMarked = [];

  function normalise(value){
    if(!Array.isArray(value)){ value = []; }
    return Array.from(new Set(value.filter(function(id){
      return typeof id === 'string'
        && Object.prototype.hasOwnProperty.call(report.members, id);
    })));
  }

  function readMarked(){
    let value = memoryMarked;
    try {
      const stored = localStorage.getItem(storageKey);
      if(stored !== null){ value = JSON.parse(stored); }
    } catch(_error) {}
    memoryMarked = normalise(value);
    return memoryMarked.slice();
  }

  function writeMarked(marked){
    memoryMarked = normalise(marked);
    try { localStorage.setItem(storageKey, JSON.stringify(memoryMarked)); }
    catch(_error) {}
  }

  function updateExport(){
    const marked = readMarked();
    writeMarked(marked);
    document.getElementById('count').textContent = String(marked.length);
    document.getElementById('export').disabled = marked.length === 0;
  }

  function toggleMark(toggle){
    const resultId = toggle.dataset.resultId;
    const image = toggle.querySelector('img.thumb');
    const marked = readMarked();
    const index = marked.indexOf(resultId);
    if(index >= 0){
      marked.splice(index, 1);
      image.classList.remove('marked');
    } else {
      marked.push(resultId);
      image.classList.add('marked');
    }
    writeMarked(marked);
    updateExport();
  }

  document.addEventListener('DOMContentLoaded', function(){
    const marked = readMarked();
    document.querySelectorAll('button.thumb-toggle').forEach(function(toggle){
      const image = toggle.querySelector('img.thumb');
      if(marked.indexOf(toggle.dataset.resultId) >= 0){
        image.classList.add('marked');
      }
      toggle.addEventListener('click', function(event){
        event.preventDefault();
        toggleMark(toggle);
      });
    });

    document.getElementById('export').addEventListener('click', function(){
      const paths = readMarked().map(function(id){ return report.members[id]; });
      const blob = new Blob([JSON.stringify(paths, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'review_selection.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
    updateExport();
  });
})();
""")
        report.write("</script></body></html>")
    return index_file


###############################################################################
# Main pipeline
###############################################################################

def process_directory(
    input_dir: Path,
    out_dir: Path,
    cfg,
    quick: bool = False,
    rebuild_cache: bool = False,
    dry_run: bool = False,
):
    import tempfile

    input_dir = input_dir.resolve()
    out_dir = out_dir.resolve()
    root_anchor = _scan_root_anchor(input_dir)
    temporary_cache_path: Optional[Path] = None
    cache: Optional[FingerprintCache] = None

    try:
        configured_cache = cfg.get("cache", {}).get("path")
        if dry_run or not configured_cache:
            temporary = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
            temporary_cache_path = Path(temporary.name)
            temporary.close()
            cache_path = temporary_cache_path
        else:
            out_dir.mkdir(parents=True, exist_ok=True)
            configured_path = Path(str(configured_cache))
            cache_path = (
                configured_path
                if configured_path.is_absolute()
                else out_dir / configured_path
            )
            cache_path.parent.mkdir(parents=True, exist_ok=True)

        cache = FingerprintCache(cache_path)
        if rebuild_cache:
            cache.clear()

        print(f"\nScanning directory: {input_dir}")
        files = list_image_files(input_dir, cfg)

        def path_within(path: Path, parent: Path) -> bool:
            try:
                path.relative_to(parent)
                return True
            except ValueError:
                return False

        if out_dir != input_dir and path_within(out_dir, input_dir):
            files = [path for path in files if not path_within(path, out_dir)]
        elif out_dir == input_dir:
            # Preserve the legacy in-place report exclusion so thumbnails
            # created by pre-isolation versions are never treated as sources.
            legacy_html_dir = out_dir / "html"
            files = [
                path for path in files
                if not path_within(path, legacy_html_dir)
            ]
        files = sorted(files, key=lambda path: os.path.normcase(str(path)))
        print(f"Found {len(files)} image files")

        if not files:
            print("\nNo images found. Check your input directory.")
            return None, None, None

        stats: Dict[Path, Tuple[int, int]] = {}
        fingerprints: Dict[Path, Fingerprint] = {}
        file_digests: Dict[Path, str] = {}
        content_signatures: Dict[Path, ContentSignature] = {}
        scanned_identities: Dict[Path, Tuple[int, int, int, int, int]] = {}
        errors: List[Tuple[Path, str]] = []
        detector = None if quick else get_feature_detector(cfg)

        print("\nComputing file, content, and perceptual fingerprints...")
        for completed, path in enumerate(files, start=1):
            before_identity = None
            try:
                before_identity = _validated_source_identity(
                    path,
                    input_dir,
                    root_anchor,
                )
                file_id = file_id_from_path(path, cfg)
                signature = compute_content_signature(path, cfg)
                if quick:
                    fingerprint = Fingerprint(phash64_8x=[0], keypoint_count=0)
                else:
                    fingerprint = compute_fingerprint(
                        path,
                        cfg,
                        detector,
                        cache,
                        fid=file_id,
                    )
                    if fingerprint is None:
                        raise ValueError("analysis decode failed")
                digest_after_analysis = compute_file_sha256(path)
                after_identity = _validated_source_identity(
                    path,
                    input_dir,
                    root_anchor,
                )
                if (
                    after_identity != before_identity
                    or digest_after_analysis != file_id.sha256
                ):
                    errors.append((path, "changed_during_scan"))
                    continue
            except Exception as error:
                try:
                    changed = (
                        before_identity is not None
                        and _validated_source_identity(
                            path,
                            input_dir,
                            root_anchor,
                        ) != before_identity
                    )
                except (OSError, RuntimeError, ValueError):
                    changed = before_identity is not None
                errors.append(
                    (path, "changed_during_scan")
                    if changed
                    else (path, f"{type(error).__name__}: {error}")
                )
                continue

            fingerprints[path] = fingerprint
            file_digests[path] = file_id.sha256
            content_signatures[path] = signature
            scanned_identities[path] = after_identity
            stats[path] = (signature.width, signature.height)
            if completed % 10 == 0 or completed == len(files):
                print(f"  Progress: {completed}/{len(files)}", end="\r")
        print(f"\n  Processed {len(fingerprints)} images successfully")

        ordered_paths = sorted(
            fingerprints,
            key=lambda path: os.path.normcase(str(path)),
        )
        pairs: List[PairDecision] = []
        established_pairs: set[Tuple[Path, Path]] = set()

        def ordered_pair(first: Path, second: Path) -> Tuple[Path, Path]:
            if os.path.normcase(str(first)) <= os.path.normcase(str(second)):
                return first, second
            return second, first

        def add_identity_groups(groups: dict, verification: str) -> None:
            for group_key in sorted(groups, key=str):
                members = sorted(
                    groups[group_key],
                    key=lambda path: os.path.normcase(str(path)),
                )
                for first_index, first in enumerate(members):
                    for second in members[first_index + 1:]:
                        pair_key = ordered_pair(first, second)
                        if pair_key in established_pairs:
                            continue
                        similarity, _ = phash_similarity_scores(
                            fingerprints[first].phash64_8x,
                            fingerprints[second].phash64_8x,
                        )
                        metrics = PairMetrics(
                            phash_similarity=similarity,
                            inliers=0,
                            coverage_a=1.0,
                            coverage_b=1.0,
                            residual_median_px=0.0,
                            model="identity",
                            verification=verification,
                        )
                        pairs.append(
                            PairDecision(
                                a=pair_key[0],
                                b=pair_key[1],
                                label="duplicate",
                                metrics=metrics,
                                match_kind=verification,
                            )
                        )
                        established_pairs.add(pair_key)

        byte_groups: Dict[str, List[Path]] = defaultdict(list)
        for path in ordered_paths:
            byte_groups[file_digests[path]].append(path)
        add_identity_groups(byte_groups, "byte_exact")

        pixel_groups: Dict[Tuple[str, int, int, int, bool], List[Path]] = defaultdict(list)
        for path in ordered_paths:
            signature = content_signatures[path]
            pixel_groups[
                (
                    signature.digest,
                    signature.width,
                    signature.height,
                    signature.frame_count,
                    signature.has_alpha,
                )
            ].append(path)
        add_identity_groups(pixel_groups, "pixel_exact")

        print("\nComparing images...")
        if not quick and len(ordered_paths) > 1:
            phash_map = {
                path: fingerprints[path].phash64_8x
                for path in ordered_paths
            }
            radius = hamming_radius_for_similarity(candidate_similarity_threshold(cfg))
            lsh_map = build_lsh_map(phash_map, radius)
            candidate_pairs = sorted(
                {
                    ordered_pair(path, neighbour)
                    for path in ordered_paths
                    for neighbour in lsh_map[path]
                    if path != neighbour
                    and ordered_pair(path, neighbour) not in established_pairs
                },
                key=lambda pair: (
                    os.path.normcase(str(pair[0])),
                    os.path.normcase(str(pair[1])),
                ),
            )

            for comparison_count, (first, second) in enumerate(
                candidate_pairs,
                start=1,
            ):
                fingerprint_a = fingerprints[first]
                fingerprint_b = fingerprints[second]
                similarity, _ = phash_similarity_scores(
                    fingerprint_a.phash64_8x,
                    fingerprint_b.phash64_8x,
                )
                keypoints_a = reconstruct_keypoints(
                    fingerprint_a.keypoints_data or []
                )
                keypoints_b = reconstruct_keypoints(
                    fingerprint_b.keypoints_data or []
                )
                matches = match_descriptors(
                    fingerprint_a.descriptors,
                    fingerprint_b.descriptors,
                    cfg,
                )
                _, metrics = estimate_transform_and_metrics(
                    keypoints_a,
                    keypoints_b,
                    matches,
                    cfg,
                )
                metrics.phash_similarity = similarity
                label = decide_label(metrics, fingerprint_a, fingerprint_b, cfg)
                match_kind = (
                    "perceptual_variant" if label == "variant" else "different"
                )
                pairs.append(
                    PairDecision(
                        a=first,
                        b=second,
                        label=label,
                        metrics=metrics,
                        match_kind=match_kind,
                    )
                )
                if comparison_count % 50 == 0:
                    print(f"  Comparisons: {comparison_count}", end="\r")

        def changed_since_scan(paths: List[Path]) -> set[Path]:
            changed: set[Path] = set()
            for candidate in paths:
                try:
                    identity_before = _validated_source_identity(
                        candidate,
                        input_dir,
                        root_anchor,
                    )
                    digest_now = compute_file_sha256(candidate)
                    identity_after = _validated_source_identity(
                        candidate,
                        input_dir,
                        root_anchor,
                    )
                    if (
                        identity_before != scanned_identities[candidate]
                        or identity_after != scanned_identities[candidate]
                        or digest_now != file_digests[candidate]
                    ):
                        changed.add(candidate)
                except (OSError, RuntimeError, ValueError):
                    changed.add(candidate)
            return changed

        changed_before_publish = changed_since_scan(ordered_paths)
        if changed_before_publish:
            for path in sorted(
                changed_before_publish,
                key=lambda candidate: os.path.normcase(str(candidate)),
            ):
                errors.append((path, "changed_before_publish"))
                fingerprints.pop(path, None)
                file_digests.pop(path, None)
                content_signatures.pop(path, None)
                scanned_identities.pop(path, None)
                stats.pop(path, None)
            pairs = [
                decision
                for decision in pairs
                if decision.a not in changed_before_publish
                and decision.b not in changed_before_publish
            ]
            ordered_paths = [
                path
                for path in ordered_paths
                if path not in changed_before_publish
            ]

        print(f"\n  Total comparisons: {len(pairs)}")
        print("\nBuilding clusters...")
        clusters = build_clusters(pairs, cfg, fingerprints, stats)
        print(f"  Found {len(clusters)} clusters")

        if dry_run:
            print("\nDry run: report files were not written.")
            return None, None, None

        print("\nGenerating reports...")
        out_dir.mkdir(parents=True, exist_ok=True)
        run_id = (
            datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            + "-"
            + secrets.token_hex(4)
        )
        run_dir = out_dir / f"report-{run_id}"
        with tempfile.TemporaryDirectory(
            prefix=".dupefinder-incomplete-",
            dir=out_dir,
        ) as staging_name:
            staging_dir = Path(staging_name)
            (staging_dir / ".dupefinder-report").write_text(
                "Generated by Duplicate Image Finder.\n",
                encoding="utf-8",
            )
            html_staged = write_html_report(
                staging_dir,
                clusters,
                cfg,
                detector,
                report_id=run_id,
                source_validator=lambda source: _validated_source_identity(
                    source,
                    input_dir,
                    root_anchor,
                ),
            )
            json_staged = write_json_report(
                staging_dir,
                pairs,
                clusters,
                cfg,
                errors,
            )
            csv_staged = (
                write_csv_report(staging_dir, pairs)
                if cfg["report"]["write_csv"]
                else None
            )
            if changed_since_scan(ordered_paths):
                raise RuntimeError(
                    "One or more images changed during report generation; "
                    "no report was published. Run the scan again."
                )
            os.replace(staging_dir, run_dir)
            json_path = run_dir / json_staged.relative_to(staging_dir)
            csv_path = (
                run_dir / csv_staged.relative_to(staging_dir)
                if csv_staged is not None
                else None
            )
            html_path = run_dir / html_staged.relative_to(staging_dir)
        return json_path, csv_path, html_path
    finally:
        if cache is not None:
            cache.close()
        if temporary_cache_path is not None:
            try:
                temporary_cache_path.unlink()
            except OSError:
                pass


###############################################################################
# Command-line interface
###############################################################################

def validate_config(cfg: dict) -> None:
    for key in (
        "max_image_pixels",
        "max_frames",
        "max_total_decoded_pixels",
        "max_total_decoded_bytes",
    ):
        if int(cfg["io"][key]) <= 0:
            raise ValueError(f"io.{key} must be positive")
    for label in ("duplicate", "variant"):
        geometry = cfg["geometry"][label]
        if geometry["reprojection_px"] <= 0:
            raise ValueError(
                f"geometry.{label}.reprojection_px must be positive"
            )
        if geometry["min_inliers"] < 0:
            raise ValueError(
                f"geometry.{label}.min_inliers must be non-negative"
            )
        if not 0.0 <= geometry["coverage"] <= 1.0:
            raise ValueError(
                f"geometry.{label}.coverage must be within [0,1]"
            )
    scale_min, scale_max = cfg["geometry"]["scale_limits"]
    if scale_min <= 0 or scale_max <= 0 or scale_min >= scale_max:
        raise ValueError(
            "geometry.scale_limits must be (min, max) with 0 < min < max"
        )
    for key in (
        "phash_duplicate",
        "phash_variant",
        "low_texture_phash_duplicate",
        "low_texture_phash_variant",
    ):
        value = cfg["similarity"][key]
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"similarity.{key} must be within [0,1]")
    if cfg["similarity"]["phash_variant"] > cfg["similarity"]["phash_duplicate"]:
        raise ValueError("phash_variant should not exceed phash_duplicate")
    if (
        cfg["similarity"]["low_texture_phash_variant"]
        > cfg["similarity"]["low_texture_phash_duplicate"]
    ):
        raise ValueError(
            "low_texture_phash_variant should not exceed "
            "low_texture_phash_duplicate"
        )
    hamming_radius_for_similarity(candidate_similarity_threshold(cfg))
    ratio_test = float(cfg["match"]["ratio_test"])
    if not 0.0 < ratio_test < 1.0:
        raise ValueError("match.ratio_test must be within (0,1)")
    if cfg["blocking"]["aspect_ratio_tolerance"] <= 0:
        raise ValueError("blocking.aspect_ratio_tolerance must be positive")
    if not cfg["blocking"]["size_bucket_megapixels"]:
        raise ValueError("blocking.size_bucket_megapixels must not be empty")


def load_config(config_path: Optional[Path]) -> dict:
    import importlib

    cfg = json.loads(json.dumps(DEFAULT_CFG))
    if config_path:
        with config_path.open("r", encoding="utf-8") as config_file:
            if config_path.suffix.lower() in (".yaml", ".yml"):
                try:
                    yaml = importlib.import_module("yaml")
                except ImportError as error:
                    raise ImportError(
                        "PyYAML is required for YAML configuration files. "
                        "Install pyyaml or use JSON."
                    ) from error
                user_cfg = yaml.safe_load(config_file)
            else:
                user_cfg = json.load(config_file)
        if not isinstance(user_cfg, dict):
            raise ValueError("configuration root must be an object")

        def recursive_update(target: dict, source: dict) -> None:
            for key, value in source.items():
                if (
                    key in target
                    and isinstance(target[key], dict)
                    and isinstance(value, dict)
                ):
                    recursive_update(target[key], value)
                else:
                    target[key] = value

        recursive_update(cfg, user_cfg)
    validate_config(cfg)
    return cfg


def interactive_mode():
    print("\n" + "=" * 70)
    print("DUPLICATE IMAGE FINDER - Interactive Mode")
    print("=" * 70)

    while True:
        print("\nEnter the directory containing images to scan:")
        print("(Drag and drop a folder here, or type the path)")
        input_path = input("> ").strip().strip('"').strip("'")
        if not input_path:
            print("\nNo path provided.")
            continue
        input_dir = Path(input_path)
        if input_dir.is_dir():
            break
        print(f"\nError: Not an available directory: {input_dir}")
        if input("Try again? (y/n): ").strip().lower() != "y":
            return None

    print("\nEnter output directory for reports:")
    print("(Press Enter to use: ./dupefinder_results)")
    output_path = input("> ").strip().strip('"').strip("'")
    output_dir = Path(output_path) if output_path else Path("./dupefinder_results")
    print(f"\nInput:  {input_dir}")
    print(f"Output: {output_dir}")
    quick = (
        input(
            "\nUse quick mode (byte/pixel identity only, faster)? (y/n): "
        ).strip().lower()
        == "y"
    )
    return {
        "input": input_dir,
        "output": output_dir,
        "config": None,
        "quick": quick,
        "rebuild_cache": False,
        "dry_run": False,
    }


def main() -> None:
    interactive = len(sys.argv) == 1
    try:
        if interactive:
            params = interactive_mode()
            if params is None:
                print("\nCancelled.")
                return
            input_dir = params["input"]
            out_dir = params["output"]
            cfg = load_config(params["config"])
            quick = params["quick"]
            rebuild_cache = params["rebuild_cache"]
            dry_run = params["dry_run"]
        else:
            parser = argparse.ArgumentParser(
                description="Detect duplicate and variant images in a folder."
            )
            parser.add_argument("input", help="Input directory to scan")
            parser.add_argument(
                "-o",
                "--output",
                required=True,
                help="Parent directory for isolated per-run reports",
            )
            parser.add_argument(
                "--config",
                help="Path to a JSON or YAML configuration file",
            )
            parser.add_argument(
                "--quick",
                action="store_true",
                help=(
                    "Identity-only mode: byte and all-frame decoded pixel "
                    "matches; no perceptual variants"
                ),
            )
            parser.add_argument(
                "--rebuild-cache",
                action="store_true",
                help="Ignore existing cache entries and recompute fingerprints",
            )
            parser.add_argument(
                "--dry-run",
                action="store_true",
                help="Process files but do not write reports",
            )
            args = parser.parse_args()
            input_dir = Path(args.input).resolve()
            out_dir = Path(args.output).resolve()
            cfg = load_config(Path(args.config) if args.config else None)
            quick = args.quick
            rebuild_cache = args.rebuild_cache
            dry_run = args.dry_run

        print("\nStarting processing...")
        print(f"Input directory: {input_dir}")
        print(f"Output directory: {out_dir}")
        print(f"Quick mode: {quick}")
        cv2.setNumThreads(cfg["determinism"]["opencv_threads"])
        np.random.seed(cfg["determinism"]["seed"])
        json_path, csv_path, html_path = process_directory(
            input_dir,
            out_dir,
            cfg,
            quick=quick,
            rebuild_cache=rebuild_cache,
            dry_run=dry_run,
        )

        if dry_run:
            print("\nDry run complete. Reports not written.")
        elif json_path is None:
            print("\nNo report was produced. Check the input and messages above.")
        else:
            print("\n" + "=" * 70)
            print("RESULTS")
            print("=" * 70)
            print(f"\nJSON report: {json_path}")
            if csv_path:
                print(f"CSV report:  {csv_path}")
            print(f"HTML report: {html_path}")
            print("\nOpen the HTML report in your browser to review results.")
    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
    except Exception as error:
        print("\n" + "=" * 70)
        print("ERROR")
        print("=" * 70)
        print(f"\n{type(error).__name__}: {error}")
        print("\nFull error details:")
        import traceback
        traceback.print_exc()
    finally:
        if interactive and getattr(sys.stdin, "isatty", lambda: False)():
            try:
                input("\nPress Enter to exit...")
            except EOFError:
                pass


if __name__ == "__main__":
    main()
