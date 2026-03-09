"""Configuration loader and validator — TOML-based."""

import logging
import sys
from pathlib import Path
from typing import Any, Optional

if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib  # type: ignore

logger = logging.getLogger("sentinel.config")

DEFAULTS = {
    "trash_retention_days": 30,
    "classification": {"probe_unknown": True},
    "ignore_patterns": [
        "*.tmp", "*.crdownload", "*.part", "*.partial",
        "*.downloading", "desktop.ini", "thumbs.db", ".DS_Store",
    ],
    "orientation": {
        "ambiguity_tolerance": 0.15,
        "cropdetect_threshold": 24,
        "cropdetect_samples": 5,
        "min_duration_for_cropdetect": 5,
    },
    "dedup": {
        "enabled": True,
        "exact": {"enabled": True, "partial_hash_bytes": 65536, "algorithm": "blake2b"},
        "video": {
            "enabled": True, "frame_interval_seconds": 5,
            "hash_size": 16, "hamming_threshold": 10, "match_threshold_percent": 85,
        },
        "audio": {"enabled": True, "similarity_threshold": 0.8},
        "image": {
            "enabled": True,
            "phash_duplicate": 0.90, "phash_variant": 0.75,
            "phash_skip_geometric": 0.97,
            "low_texture_keypoints_min": 120,
            "low_texture_phash_duplicate": 0.94,
            "low_texture_phash_variant": 0.82,
            "orb_features": 800, "orb_scale_factor": 1.2,
            "feature_max_dimension": 1024,
            "aspect_ratio_tolerance": 0.15,
            "lsh_hamming_radius": 16,
            "geometry": {
                "ransac_models": ["similarity", "affine", "homography"],
                "scale_limits": [0.25, 4.0],
                "duplicate": {"reprojection_px": 2.5, "min_inliers": 40, "coverage": 0.50},
                "variant": {"reprojection_px": 4.0, "min_inliers": 25, "coverage": 0.35},
            },
        },
        "subset": {"enabled": True, "min_duration_ratio": 0.1, "match_threshold_percent": 80},
        "resolution": {"prefer": "higher_quality", "auto_trash": True, "confidence_threshold": 0.85},
    },
    "source": {
        "ads_enabled": True,
        "title_resolution": {"enabled": True, "domains": ["youtube.com", "youtu.be"]},
    },
    "naming": {"sanitize": True, "max_length": 200, "conflict_strategy": "increment"},
    "processing": {
        "write_stable_seconds": 2, "write_check_interval": 0.5,
        "max_retries": 5, "retry_delay_seconds": 3, "workers": 2,
    },
    "logging": {
        "level": "INFO", "file": ".sentinel/sentinel.log",
        "max_size_mb": 10, "backup_count": 5, "console": True,
    },
    "startup": {"catch_up_scan": True, "ensure_destinations": True},
    "tools": {"ffprobe": "ffprobe", "ffmpeg": "ffmpeg", "fpcalc": "fpcalc", "yt_dlp": "yt-dlp"},
    "rules": [],
}


def _deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


class Config:
    def __init__(self, config_path: Optional[str] = None):
        if config_path:
            self._path = Path(config_path)
        else:
            self._path = Path("config.toml")
        self._raw: dict[str, Any] = {}
        self.load()

    def load(self) -> None:
        if not self._path.exists():
            logger.warning("Config file not found at %s — using defaults", self._path)
            self._raw = DEFAULTS.copy()
            return
        with open(self._path, "rb") as f:
            user_config = tomllib.load(f)
        self._raw = _deep_merge(DEFAULTS, user_config)
        self._validate()
        logger.info("Configuration loaded from %s", self._path)

    def _validate(self) -> None:
        if not self._raw.get("watch_folders"):
            logger.warning("No watch_folders configured")
        if not self._raw.get("destinations"):
            logger.warning("No destinations configured")

    def reload(self) -> None:
        logger.info("Reloading configuration...")
        self.load()

    @property
    def watch_folders(self) -> list[dict]:
        return self._raw.get("watch_folders", [])

    @property
    def destinations(self) -> dict[str, str]:
        return self._raw.get("destinations", {})

    @property
    def trash_retention_days(self) -> int:
        return self._raw.get("trash_retention_days", 30)

    @property
    def classification(self) -> dict:
        return self._raw.get("classification", {})

    @property
    def ignore_patterns(self) -> list[str]:
        return self._raw.get("ignore_patterns", [])

    @property
    def orientation(self) -> dict:
        return self._raw.get("orientation", {})

    @property
    def dedup(self) -> dict:
        return self._raw.get("dedup", {})

    @property
    def source(self) -> dict:
        return self._raw.get("source", {})

    @property
    def naming(self) -> dict:
        return self._raw.get("naming", {})

    @property
    def processing(self) -> dict:
        return self._raw.get("processing", {})

    @property
    def logging_config(self) -> dict:
        return self._raw.get("logging", {})

    @property
    def startup(self) -> dict:
        return self._raw.get("startup", {})

    @property
    def tools(self) -> dict:
        return self._raw.get("tools", {})

    @property
    def rules(self) -> list[dict]:
        return self._raw.get("rules", [])

    def get_destination(self, name: str) -> Optional[Path]:
        dest = self.destinations.get(name)
        return Path(dest) if dest else None

    def get_extensions_for_type(self, file_type: str) -> set[str]:
        exts = self.classification.get(file_type, [])
        if isinstance(exts, list):
            return {e.lower().lstrip(".") for e in exts}
        return set()

    def get_all_type_extensions(self) -> dict[str, set[str]]:
        result = {}
        for type_name in ("audio", "video", "image", "document", "archive"):
            result[type_name] = self.get_extensions_for_type(type_name)
        return result
