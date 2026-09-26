#!/usr/bin/env python3
"""Fail-closed web backend for the duplicate image finder."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import os
import secrets
import stat as stat_module
import sys
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from flask import Flask, Response, jsonify, request
from PIL import Image, ImageOps
from werkzeug.serving import WSGIRequestHandler, make_server

from dupefinder import (
    DEFAULT_CFG,
    FingerprintCache,
    compute_composite_similarity,
    compute_content_signature,
    compute_file_sha256,
    compute_fingerprint,
    estimate_transform_and_metrics,
    get_feature_detector,
    list_image_files,
    match_descriptors,
    phash_similarity_scores,
    reconstruct_keypoints,
)


try:
    RESAMPLE_LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 9.1
    RESAMPLE_LANCZOS = Image.LANCZOS


app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 1_048_576
app.config["TRUSTED_HOSTS"] = ["127.0.0.1", "localhost"]

API_TOKEN = secrets.token_urlsafe(32)
SESSION_TTL_SECONDS = 2 * 60 * 60
FOLDER_TOKEN_TTL_SECONDS = 10 * 60
SELECTION_TOKEN_TTL_SECONDS = 5 * 60
HEARTBEAT_TIMEOUT_SECONDS = 5 * 60
MAX_SESSIONS = 32
MAX_RESULT_IDS = 10_000
MAX_THUMBNAIL_SIZE = 1_024
TERMINAL_STATUSES = {"complete", "cancelled", "error"}
TERMINAL_EVENTS = {"complete", "cancelled", "error"}

scan_sessions: Dict[str, dict] = {}
folder_tokens: Dict[str, dict] = {}
registry_lock = threading.RLock()
server_state_lock = threading.RLock()
server_instance = None
last_server_activity = time.time()
shutdown_requested = False
active_file_operations = 0


class ApiProblem(Exception):
    def __init__(self, message: str, status: int = 400, **details: Any):
        super().__init__(message)
        self.message = message[:500]
        self.status = status
        self.details = details


class ScanCancelled(Exception):
    pass


class ScanInvalidated(Exception):
    pass


class TokenSafeRequestHandler(WSGIRequestHandler):
    """Do not place query tokens or other query data in access logs."""

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        original_path = self.path
        try:
            self.path = original_path.split("?", 1)[0]
            super().log_request(code, size)
        finally:
            self.path = original_path


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_message(exc: BaseException, fallback: str = "Operation failed") -> str:
    message = str(exc).strip()
    if not message:
        return fallback
    return message.replace("\r", " ").replace("\n", " ")[:500]


def _log_local_exception(context: str) -> None:
    print(f"[{context}]", file=sys.stderr)
    traceback.print_exc(file=sys.stderr)


def _touch_server_activity() -> None:
    global last_server_activity
    with server_state_lock:
        last_server_activity = time.time()


def _constant_time_token_valid(candidate: Optional[str]) -> bool:
    supplied = candidate if isinstance(candidate, str) else ""
    return secrets.compare_digest(supplied, API_TOKEN)


@app.before_request
def authenticate_api_request():
    if request.host.lower() not in {
        "127.0.0.1:5000", "localhost:5000"
    }:
        if request.path.startswith("/api/"):
            return jsonify({"error": "Invalid Host header"}), 400
        return Response("Invalid Host header", status=400, mimetype="text/plain")

    if not request.path.startswith("/api/"):
        return None

    fetch_site = request.headers.get("Sec-Fetch-Site", "").lower()
    if fetch_site == "cross-site":
        return jsonify({"error": "Cross-site requests are not permitted"}), 403

    origin = request.headers.get("Origin")
    if origin and origin not in {"http://127.0.0.1:5000", "http://localhost:5000"}:
        return jsonify({"error": "Request origin is not permitted"}), 403

    query_token_allowed = (
        request.path.startswith("/api/events/")
        or request.path == "/api/thumbnail"
    )
    candidate = request.args.get("token") if query_token_allowed else None
    header_token = request.headers.get("X-DupeFinder-Token")
    if header_token is not None:
        candidate = header_token
    if not _constant_time_token_valid(candidate):
        return jsonify({"error": "Invalid API token"}), 401

    _touch_server_activity()
    return None


@app.after_request
def harden_response(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "connect-src 'self'; object-src 'none'; base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'"
    )
    return response


@app.errorhandler(ApiProblem)
def handle_api_problem(exc: ApiProblem):
    payload = {"error": exc.message}
    payload.update(exc.details)
    return jsonify(payload), exc.status


@app.errorhandler(413)
def handle_request_too_large(_exc):
    return jsonify({"error": "Request body is too large"}), 413


def _json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiProblem("A JSON object is required")
    return data


def _bounded_string(value: Any, field: str, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ApiProblem(f"{field} must be a non-empty string")
    return value


def _parse_result_ids(value: Any, field: str = "result_ids") -> List[str]:
    if not isinstance(value, list) or not value:
        raise ApiProblem(f"{field} must be a non-empty array")
    if len(value) > MAX_RESULT_IDS:
        raise ApiProblem(f"{field} contains too many entries")
    result: List[str] = []
    seen = set()
    for item in value:
        result_id = _bounded_string(item, field, 256)
        if result_id in seen:
            raise ApiProblem(f"{field} contains duplicate IDs")
        seen.add(result_id)
        result.append(result_id)
    return result


def _new_session() -> Tuple[str, dict]:
    session_id = secrets.token_urlsafe(24)
    lock = threading.RLock()
    pause_event = threading.Event()
    pause_event.set()
    session = {
        "id": session_id,
        "status": "idle",
        "progress": 0,
        "message": "",
        "root": None,
        "root_identity": None,
        "quick_mode": False,
        "threshold": 0.85,
        "records": {},
        "edges": [],
        "clusters": [],
        "marked": set(),
        "errors": [],
        "events": [],
        "next_event_id": 1,
        "lock": lock,
        "condition": threading.Condition(lock),
        "action_lock": threading.RLock(),
        "pause_event": pause_event,
        "cancel_event": threading.Event(),
        "thread": None,
        "pending_selections": {},
        "operations": [],
        "created_at": time.time(),
        "last_access": time.time(),
    }
    return session_id, session


def _session_or_error(session_id: Any) -> dict:
    session_key = _bounded_string(session_id, "session_id", 256)
    with registry_lock:
        session = scan_sessions.get(session_key)
    if session is None:
        raise ApiProblem("Invalid or expired session", 404)
    with session["lock"]:
        session["last_access"] = time.time()
    return session


def _recovery_payload_locked(session: dict) -> dict:
    for operation in reversed(session["operations"]):
        if operation.get("state") in {"partial_failed", "undo_partial_failed"}:
            manifest_path = str(operation.get("manifest_path", ""))[:32_767]
            return {
                "recovery_required": True,
                "recovery_manifest_path": manifest_path,
                "recovery_summary": (
                    "A file operation ended with ambiguous or missing file locations. "
                    "No further actions are allowed in this process; consult the durable "
                    "manifest before closing it."
                ),
            }
    return {
        "recovery_required": False,
        "recovery_manifest_path": None,
        "recovery_summary": None,
    }


def _require_complete_locked(session: dict) -> None:
    if session["status"] != "complete":
        raise ApiProblem("The scan must be complete before this action", 409)
    recovery = _recovery_payload_locked(session)
    if recovery["recovery_required"]:
        raise ApiProblem(
            "A partial file operation requires recovery from its durable manifest",
            409,
            can_undo=False,
            **recovery,
        )


def _emit(session: dict, event_type: str, data: dict) -> None:
    with session["condition"]:
        event = {
            "id": session["next_event_id"],
            "type": event_type,
            "data": data,
        }
        session["next_event_id"] += 1
        session["events"].append(event)
        session["last_access"] = time.time()
        session["condition"].notify_all()


def _worker_checkpoint(session: dict) -> None:
    while not session["pause_event"].wait(timeout=0.25):
        if session["cancel_event"].is_set():
            raise ScanCancelled()
    if session["cancel_event"].is_set():
        raise ScanCancelled()


def _expire_pending_selections_locked(session: dict) -> None:
    now = time.time()
    expired = [
        token for token, selection in session["pending_selections"].items()
        if selection["expires_at"] <= now
    ]
    for token in expired:
        del session["pending_selections"][token]


def _has_unrestored_operation_locked(session: dict) -> bool:
    return any(
        op.get("state") in {"committed", "partial_failed", "undo_partial_failed"}
        for op in session["operations"]
    )


def _expire_registries() -> None:
    now = time.time()
    with registry_lock:
        expired_folder_tokens = [
            token for token, entry in folder_tokens.items()
            if entry["expires_at"] <= now
        ]
        for token in expired_folder_tokens:
            del folder_tokens[token]

        expired_sessions = []
        for session_id, session in scan_sessions.items():
            with session["lock"]:
                _expire_pending_selections_locked(session)
                thread = session.get("thread")
                active = session["status"] in {"scanning", "paused", "cancelling"}
                active = active or (thread is not None and thread.is_alive())
                protected = _has_unrestored_operation_locked(session)
                stale = now - session["last_access"] > SESSION_TTL_SECONDS
                if stale and not active and not protected:
                    expired_sessions.append(session_id)
        for session_id in expired_sessions:
            del scan_sessions[session_id]


def _register_folder_path(path_value: Any) -> dict:
    path_text = _bounded_string(path_value, "path", 32_767)
    try:
        canonical = Path(path_text).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiProblem("Folder does not exist or cannot be resolved")
    if not canonical.is_dir():
        raise ApiProblem("Selected path is not a directory")
    try:
        directory_identity = _directory_identity(canonical)
    except OSError:
        raise ApiProblem("Selected folder identity could not be read")
    identity_problem = _directory_identity_problem(canonical, directory_identity)
    if identity_problem:
        raise ApiProblem("Selected folder is linked or has an unsafe identity")
    token = secrets.token_urlsafe(24)
    with registry_lock:
        folder_tokens[token] = {
            "path": canonical,
            "identity": directory_identity,
            "expires_at": time.time() + FOLDER_TOKEN_TTL_SECONDS,
        }
    return {"success": True, "folder_token": token, "display_path": str(canonical)}


def _resolve_folder_token(token_value: Any) -> Tuple[Path, Tuple[int, int]]:
    token = _bounded_string(token_value, "folder_token", 256)
    with registry_lock:
        entry = folder_tokens.get(token)
        if entry is None or entry["expires_at"] <= time.time():
            folder_tokens.pop(token, None)
            raise ApiProblem("Invalid or expired folder token", 404)
        stored_path = entry["path"]
        stored_identity = entry["identity"]
    try:
        current = stored_path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiProblem("Selected folder is no longer available", 409)
    if (
        current != stored_path
        or not current.is_dir()
        or _directory_identity_problem(stored_path, stored_identity)
    ):
        raise ApiProblem("Selected folder identity has changed", 409)
    return current, stored_identity


def _directory_identity(path: Path) -> Tuple[int, int]:
    directory_stat = path.lstat()
    if not stat_module.S_ISDIR(directory_stat.st_mode):
        raise OSError("not a directory")
    return int(directory_stat.st_dev), int(directory_stat.st_ino)


def _directory_identity_problem(
    path: Path,
    expected: Optional[Tuple[int, int]],
) -> Optional[str]:
    try:
        if _is_linklike(path):
            return "directory is linked or a reparse point"
        if path.resolve(strict=True) != path:
            return "directory canonical path changed"
        current = _directory_identity(path)
        if expected is not None and current != tuple(expected):
            return "directory identity changed"
    except (OSError, RuntimeError):
        return "directory is unavailable"
    return None


def _signature_value(signature: Any, field: str) -> Any:
    if isinstance(signature, dict):
        if field not in signature:
            raise ValueError(f"content signature is missing {field}")
        return signature[field]
    if not hasattr(signature, field):
        raise ValueError(f"content signature is missing {field}")
    return getattr(signature, field)


def _stable_stat_tuple(file_stat: os.stat_result) -> Tuple[int, int, int, int]:
    return (
        int(file_stat.st_dev),
        int(file_stat.st_ino),
        int(file_stat.st_size),
        int(file_stat.st_mtime_ns),
    )


def _relative_text(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return path.name


def _file_error(path: Path, root: Path, stage: str, exc: BaseException) -> dict:
    relative_path = _relative_text(path, root)
    message = _safe_message(exc)
    message = message.replace(str(root), "<scan root>")
    message = message.replace(str(path), relative_path)
    return {
        "relative_path": relative_path,
        "stage": stage,
        "message": message,
    }


def _capture_record(
    path: Path,
    root: Path,
    cfg: dict,
    detector: Any,
    cache: Optional[FingerprintCache],
    quick_mode: bool,
) -> dict:
    canonical = path.resolve(strict=True)
    canonical.relative_to(root)
    if not canonical.is_file():
        raise ValueError("not a regular file")

    initial_stat = canonical.lstat()
    if not stat_module.S_ISREG(initial_stat.st_mode):
        raise ValueError("not a regular file")

    sha_before = compute_file_sha256(canonical)
    signature = compute_content_signature(canonical, cfg)
    fingerprint = None
    if not quick_mode:
        if cache is None:
            raise RuntimeError("fingerprint cache is unavailable")
        fingerprint = compute_fingerprint(canonical, cfg, detector, cache)
        if fingerprint is None:
            raise ValueError("perceptual fingerprint could not be computed")
    sha_after = compute_file_sha256(canonical)
    final_stat = canonical.lstat()

    if sha_before != sha_after or _stable_stat_tuple(initial_stat) != _stable_stat_tuple(final_stat):
        raise ValueError("file changed while it was being analysed")

    width = int(_signature_value(signature, "width"))
    height = int(_signature_value(signature, "height"))
    frame_count = int(_signature_value(signature, "frame_count"))
    if width <= 0 or height <= 0 or frame_count <= 0:
        raise ValueError("content signature contains invalid dimensions or frame count")

    relative = canonical.relative_to(root)
    result_id = secrets.token_urlsafe(18)
    return {
        "id": result_id,
        "_path": canonical,
        "relative_path": str(relative),
        "name": canonical.name,
        "size": int(final_stat.st_size),
        "mtime_ns": int(final_stat.st_mtime_ns),
        "modified": float(final_stat.st_mtime),
        "st_dev": int(final_stat.st_dev),
        "st_ino": int(final_stat.st_ino),
        "file_sha256": str(sha_after),
        "_content_digest": str(_signature_value(signature, "digest")),
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "has_alpha": bool(_signature_value(signature, "has_alpha")),
        "format": str(_signature_value(signature, "format") or "unknown"),
        "_fingerprint": fingerprint,
        "active": True,
    }


def _edge_key(a: str, b: str) -> Tuple[str, str]:
    return (a, b) if a < b else (b, a)


EDGE_PRIORITY = {"variant": 1, "pixel_duplicate": 2, "exact": 3}


def _content_identity_key(record: dict) -> Tuple[Any, ...]:
    """Exact conservative decoded-content policy used everywhere in the API."""
    return (
        record["_content_digest"],
        record["width"],
        record["height"],
        record["frame_count"],
        record["has_alpha"],
    )


def _put_edge(edge_map: dict, edge: dict) -> None:
    key = _edge_key(edge["a"], edge["b"])
    current = edge_map.get(key)
    if current is None or EDGE_PRIORITY[edge["match_kind"]] > EDGE_PRIORITY[current["match_kind"]]:
        edge_map[key] = edge


def _identity_edges(records: Dict[str, dict]) -> dict:
    edge_map: Dict[Tuple[str, str], dict] = {}
    sha_groups: Dict[str, List[str]] = defaultdict(list)
    content_groups: Dict[Tuple[Any, ...], List[str]] = defaultdict(list)

    for result_id, record in records.items():
        sha_groups[record["file_sha256"]].append(result_id)
        content_groups[_content_identity_key(record)].append(result_id)

    for ids in sha_groups.values():
        ordered = sorted(ids, key=lambda item: (records[item]["relative_path"].casefold(), item))
        if len(ordered) < 2:
            continue
        for left_index, left_id in enumerate(ordered):
            for right_id in ordered[left_index + 1:]:
                _put_edge(edge_map, {
                    "a": left_id,
                    "b": right_id,
                    "similarity": 1.0,
                    "match_kind": "exact",
                    "verification": "SHA-256 byte identity",
                })

    for ids in content_groups.values():
        ordered = sorted(ids, key=lambda item: (records[item]["relative_path"].casefold(), item))
        if len(ordered) < 2:
            continue
        for left_index, left_id in enumerate(ordered):
            for right_id in ordered[left_index + 1:]:
                if records[left_id]["file_sha256"] == records[right_id]["file_sha256"]:
                    kind = "exact"
                    verification = "SHA-256 byte identity"
                else:
                    kind = "pixel_duplicate"
                    verification = "all-frame RGBA identity; file bytes differ"
                _put_edge(edge_map, {
                    "a": left_id,
                    "b": right_id,
                    "similarity": 1.0,
                    "match_kind": kind,
                    "verification": verification,
                })
    return edge_map


def _variant_geometry_confirmed(metrics: Any, cfg: dict) -> bool:
    variant = cfg["geometry"]["variant"]
    return (
        metrics.model not in (None, "none", "phash_only")
        and metrics.inliers >= variant["min_inliers"]
        and metrics.coverage_a >= variant["coverage"]
        and metrics.coverage_b >= variant["coverage"]
        and metrics.residual_median_px <= variant["reprojection_px"]
    )


def _variant_edges(
    session: dict,
    records: Dict[str, dict],
    edge_map: dict,
    cfg: dict,
    threshold: float,
) -> None:
    ids = sorted(records, key=lambda item: (records[item]["relative_path"].casefold(), item))
    pair_total = len(ids) * (len(ids) - 1) // 2
    pair_number = 0

    for left_index, left_id in enumerate(ids):
        for right_id in ids[left_index + 1:]:
            _worker_checkpoint(session)
            pair_number += 1
            pair_key = _edge_key(left_id, right_id)
            if pair_key in edge_map:
                continue

            left_fp = records[left_id]["_fingerprint"]
            right_fp = records[right_id]["_fingerprint"]
            if left_fp is None or right_fp is None:
                continue
            similarity, _distance = phash_similarity_scores(
                left_fp.phash64_8x, right_fp.phash64_8x
            )

            try:
                left_keypoints = reconstruct_keypoints(left_fp.keypoints_data or [])
                right_keypoints = reconstruct_keypoints(right_fp.keypoints_data or [])
                matches = match_descriptors(left_fp.descriptors, right_fp.descriptors, cfg)
                model_name, metrics = estimate_transform_and_metrics(
                    left_keypoints, right_keypoints, matches, cfg
                )
                metrics.phash_similarity = similarity
                if model_name is None or not _variant_geometry_confirmed(metrics, cfg):
                    continue
                variant_similarity = float(compute_composite_similarity(
                    metrics,
                    left_fp,
                    right_fp,
                    cfg,
                    (records[left_id]["width"], records[left_id]["height"]),
                    (records[right_id]["width"], records[right_id]["height"]),
                ))
                if not 0.0 <= variant_similarity < 1.0:
                    continue
                if variant_similarity < threshold:
                    continue
                _put_edge(edge_map, {
                    "a": left_id,
                    "b": right_id,
                    "similarity": variant_similarity,
                    "match_kind": "variant",
                    "verification": (
                        f"geometric {metrics.model} verification: "
                        f"{metrics.inliers} inliers, "
                        f"coverage {metrics.coverage_a:.3f}/{metrics.coverage_b:.3f}, "
                        f"median residual {metrics.residual_median_px:.3f}px"
                    ),
                })
            except Exception as exc:
                with session["lock"]:
                    if len(session["errors"]) < MAX_RESULT_IDS:
                        session["errors"].append({
                            "relative_path": (
                                f"{records[left_id]['relative_path']} | "
                                f"{records[right_id]['relative_path']}"
                            ),
                            "stage": "geometric_verification",
                            "message": "geometric verification failed safely",
                        })

            if pair_number % 20 == 0 and pair_total:
                percent = 55 + int((pair_number / pair_total) * 35)
                _emit(session, "progress", {
                    "current": pair_number,
                    "total": pair_total,
                    "percent": min(90, percent),
                    "message": f"Verifying {pair_number}/{pair_total} candidate pairs...",
                })


def _record_payload(record: dict) -> dict:
    return {
        "id": record["id"],
        "name": record["name"],
        "relative_path": record["relative_path"],
        "full_path": str(record["_path"]),
        "size": record["size"],
        "width": record["width"],
        "height": record["height"],
        "modified": record["modified"],
        "frame_count": record["frame_count"],
        "has_alpha": record["has_alpha"],
        "format": record["format"],
        "file_sha256": record["file_sha256"],
    }


def _cluster_id(session_id: str, member_ids: Sequence[str]) -> str:
    digest = hashlib.sha256(
        (session_id + "\0" + "\0".join(sorted(member_ids))).encode("utf-8")
    ).hexdigest()
    return f"cluster_{digest[:24]}"


def _build_clusters(
    session_id: str,
    records: Dict[str, dict],
    edges: Sequence[dict],
    active_ids: Optional[set] = None,
) -> List[dict]:
    if active_ids is None:
        active_ids = {result_id for result_id, record in records.items() if record["active"]}

    adjacency: Dict[str, set] = defaultdict(set)
    edge_lookup: Dict[Tuple[str, str], dict] = {}
    for edge in edges:
        a, b = edge["a"], edge["b"]
        if a not in active_ids or b not in active_ids:
            continue
        adjacency[a].add(b)
        adjacency[b].add(a)
        edge_lookup[_edge_key(a, b)] = edge

    clusters = []
    visited = set()
    for start in sorted(adjacency, key=lambda item: (records[item]["relative_path"].casefold(), item)):
        if start in visited:
            continue
        component = []
        work = deque([start])
        visited.add(start)
        while work:
            node = work.popleft()
            component.append(node)
            for neighbour in sorted(adjacency[node]):
                if neighbour not in visited:
                    visited.add(neighbour)
                    work.append(neighbour)
        if len(component) < 2:
            continue

        reference_id = sorted(
            component,
            key=lambda item: (
                -len(adjacency[item]),
                records[item]["relative_path"].casefold(),
                records[item]["relative_path"],
                item,
            ),
        )[0]

        members = []
        for result_id in sorted(
            component,
            key=lambda item: (
                item != reference_id,
                records[item]["relative_path"].casefold(),
                records[item]["relative_path"],
                item,
            ),
        ):
            member = _record_payload(records[result_id])
            member["exact_peer_count"] = sum(
                peer_id != result_id
                and records[peer_id]["file_sha256"] == records[result_id]["file_sha256"]
                for peer_id in component
            )
            member["pixel_peer_count"] = sum(
                peer_id != result_id
                and _content_identity_key(records[peer_id])
                == _content_identity_key(records[result_id])
                and records[peer_id]["file_sha256"] != records[result_id]["file_sha256"]
                for peer_id in component
            )
            if result_id == reference_id:
                member.update({
                    "similarity": None,
                    "match_kind": "reference",
                    "verification": "comparison reference selected by graph degree centrality",
                    "is_representative": True,
                })
            else:
                direct_edge = edge_lookup.get(_edge_key(reference_id, result_id))
                if direct_edge is None:
                    member.update({
                        "similarity": None,
                        "match_kind": "indirect",
                        "verification": "connected through verified matches; no direct reference comparison",
                        "is_representative": False,
                    })
                else:
                    member.update({
                        "similarity": direct_edge["similarity"],
                        "match_kind": direct_edge["match_kind"],
                        "verification": direct_edge["verification"],
                        "is_representative": False,
                    })
            members.append(member)

        component_set = set(component)
        kinds = sorted({
            edge["match_kind"] for edge in edges
            if edge["a"] in component_set and edge["b"] in component_set
        }, key=lambda kind: (-EDGE_PRIORITY[kind], kind))
        clusters.append({
            "id": _cluster_id(session_id, component),
            "representative_id": reference_id,
            "members": members,
            "kinds": kinds,
        })

    clusters.sort(key=lambda cluster: (
        cluster["members"][0]["relative_path"].casefold(), cluster["id"]
    ))
    return clusters


def _scan_worker(session: dict, root: Path, quick_mode: bool, threshold: float) -> None:
    cache = None
    cache_path = None
    records: Dict[str, dict] = {}
    local_errors: List[dict] = []
    try:
        cfg = copy.deepcopy(DEFAULT_CFG)
        _emit(session, "status", {"message": "Discovering image files..."})
        files = list_image_files(root, cfg)
        files = sorted(files, key=lambda path: (str(path).casefold(), str(path)))
        _emit(session, "status", {
            "message": f"Found {len(files)} image files",
            "total": len(files),
        })

        if not quick_mode:
            temp_cache = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
            cache_path = Path(temp_cache.name)
            temp_cache.close()
            cache = FingerprintCache(cache_path)
            detector = get_feature_detector(cfg)
        else:
            detector = None

        seen_canonical = set()
        total_files = len(files)
        for index, discovered_path in enumerate(files, start=1):
            _worker_checkpoint(session)
            try:
                canonical = discovered_path.resolve(strict=True)
                canonical.relative_to(root)
                canonical_key = os.path.normcase(str(canonical))
                if canonical_key in seen_canonical:
                    continue
                record = _capture_record(
                    canonical, root, cfg, detector, cache, quick_mode
                )
                seen_canonical.add(canonical_key)
                records[record["id"]] = record
            except Exception as exc:
                local_errors.append(_file_error(discovered_path, root, "analysis", exc))

            if index % 5 == 0 or index == total_files:
                percent = int((index / max(total_files, 1)) * 50)
                _emit(session, "progress", {
                    "current": index,
                    "total": total_files,
                    "percent": min(50, percent),
                    "message": f"Analysing {index}/{total_files} images...",
                })

        _worker_checkpoint(session)
        with session["lock"]:
            session["errors"] = local_errors

        edge_map = _identity_edges(records)
        if not quick_mode and len(records) > 1:
            _emit(session, "status", {"message": "Running geometric verification..."})
            _variant_edges(session, records, edge_map, cfg, threshold)

        _worker_checkpoint(session)
        changed_before_publish = []
        with session["lock"]:
            expected_root_identity = session.get("root_identity")
        root_problem = _directory_identity_problem(root, expected_root_identity)
        if root_problem:
            changed_before_publish.append({
                "relative_path": ".",
                "stage": "changed_before_publish",
                "message": root_problem,
            })
        for record in records.values():
            _worker_checkpoint(session)
            problem = _identity_problem(record, root, require_hash=True)
            if problem:
                changed_before_publish.append({
                    "relative_path": record["relative_path"],
                    "stage": "changed_before_publish",
                    "message": problem,
                })
        if changed_before_publish:
            with session["lock"]:
                session["errors"].extend(changed_before_publish)
            raise ScanInvalidated()

        edges = list(edge_map.values())
        edges.sort(key=lambda edge: (_edge_key(edge["a"], edge["b"]), edge["match_kind"]))
        clusters = _build_clusters(session["id"], records, edges)

        with session["lock"]:
            session["records"] = records
            session["edges"] = edges
            session["clusters"] = clusters
            session["marked"].clear()
            session["errors"] = list(session["errors"])
            session["status"] = "complete"
            session["progress"] = 100
            session["message"] = f"Found {len(clusters)} verified groups"

        _emit(session, "complete", {
            "clusters": clusters,
            "marked_ids": [],
            "marked": [],
            "can_undo": False,
            "recovery_required": False,
            "recovery_manifest_path": None,
            "recovery_summary": None,
            "errors": list(session["errors"]),
            "total_clusters": len(clusters),
            "total_images": len(records),
            "message": f"Found {len(clusters)} verified groups",
        })
    except ScanCancelled:
        with session["lock"]:
            session["status"] = "cancelled"
            session["message"] = "Scan cancelled"
        _emit(session, "cancelled", {"message": "Scan cancelled"})
    except ScanInvalidated:
        with session["lock"]:
            session["status"] = "error"
            session["message"] = "Scan invalidated because files changed; please rescan"
            invalidation_errors = copy.deepcopy(session["errors"])
        _emit(session, "error", {
            "message": "One or more files changed before results were published; please rescan",
            "errors": invalidation_errors,
        })
    except Exception as exc:
        _log_local_exception("scan failed")
        with session["lock"]:
            session["status"] = "error"
            session["message"] = "Scan failed"
        _emit(session, "error", {
            "message": "Scan failed safely; no files were changed",
        })
    finally:
        if cache is not None:
            try:
                cache.close()
            except Exception:
                _log_local_exception("cache close failed")
        if cache_path is not None:
            for suffix in ("", "-wal", "-shm"):
                try:
                    Path(str(cache_path) + suffix).unlink(missing_ok=True)
                except Exception:
                    _log_local_exception("cache cleanup failed")


def _cluster_membership_locked(session: dict) -> Dict[str, str]:
    membership = {}
    for cluster in session["clusters"]:
        for member in cluster["members"]:
            membership[member["id"]] = cluster["id"]
    return membership


def _validate_marked_survivors_locked(session: dict, proposed: set) -> None:
    for cluster in session["clusters"]:
        active_ids = {
            member["id"] for member in cluster["members"]
            if session["records"].get(member["id"], {}).get("active")
        }
        if active_ids and active_ids.issubset(proposed):
            raise ApiProblem("At least one active member must remain unmarked in every group", 409)


def _marked_response_locked(session: dict) -> dict:
    marked_ids = sorted(session["marked"])
    response = {
        "marked_ids": marked_ids,
        "marked": marked_ids,
        "total_marked": len(marked_ids),
        "can_undo": _can_undo_locked(session),
    }
    response.update(_recovery_payload_locked(session))
    return response


def _is_linklike(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        file_stat = path.lstat()
        attributes = getattr(file_stat, "st_file_attributes", 0)
        reparse_flag = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return bool(attributes & reparse_flag)
    except FileNotFoundError:
        return False
    except OSError:
        return True


def _ensure_no_linklike_components(path: Path, ancestor: Path) -> None:
    try:
        relative = path.relative_to(ancestor)
    except ValueError:
        raise ApiProblem("Path escaped its permitted root", 409)
    current = ancestor
    if current.exists() and _is_linklike(current):
        raise ApiProblem("Linked or reparse-point roots are unsafe for file actions", 409)
    for part in relative.parts:
        current = current / part
        if current.exists() and _is_linklike(current):
            raise ApiProblem("Linked or reparse-point path components are unsafe", 409)


def _identity_at_path_problem(
    record: dict,
    path: Path,
    permitted_root: Path,
    require_hash: bool = True,
) -> Optional[str]:
    try:
        _ensure_no_linklike_components(path, permitted_root)
        resolved = path.resolve(strict=True)
        if resolved != path:
            return "canonical path changed"
        resolved.relative_to(permitted_root)
        file_stat = path.lstat()
        if not stat_module.S_ISREG(file_stat.st_mode):
            return "source is not a regular file"
        expected = (
            record["st_dev"], record["st_ino"], record["size"], record["mtime_ns"]
        )
        if _stable_stat_tuple(file_stat) != expected:
            return "file identity or metadata changed since the scan"
        if require_hash and compute_file_sha256(path) != record["file_sha256"]:
            return "file content changed since the scan"
        final_stat = path.lstat()
        if _stable_stat_tuple(final_stat) != expected:
            return "file changed during validation"
    except (OSError, RuntimeError, ApiProblem):
        return "file path is unavailable or failed containment validation"
    return None


def _identity_problem(record: dict, root: Path, require_hash: bool = True) -> Optional[str]:
    return _identity_at_path_problem(
        record, record["_path"], root, require_hash=require_hash
    )


def _assess_operation_locations(
    session: dict,
    entries: Sequence[dict],
    root: Path,
    operation_dir: Path,
) -> List[dict]:
    outcomes = []
    root_is_valid = _directory_identity_problem(
        root, session.get("root_identity")
    ) is None
    for entry in entries:
        record = session["records"][entry["result_id"]]
        original = Path(entry["original_path"])
        quarantined = Path(entry["quarantine_path"])
        original_valid = root_is_valid and (
            _identity_at_path_problem(record, original, root, require_hash=True) is None
        )
        quarantine_valid = (
            _identity_at_path_problem(
                record, quarantined, operation_dir, require_hash=True
            ) is None
        )
        if original_valid and not quarantine_valid:
            location = "original"
            active = True
        elif quarantine_valid and not original_valid:
            location = "quarantine"
            active = False
        elif original_valid and quarantine_valid:
            location = "ambiguous_both"
            active = True
        else:
            location = "missing_or_changed"
            active = False
        entry["status"] = location
        outcomes.append({
            "result_id": entry["result_id"],
            "relative_path": entry["relative_path"],
            "location": location,
            "active": active,
            "original_valid": original_valid,
            "quarantine_valid": quarantine_valid,
        })
    return outcomes


def _apply_location_outcomes_locked(session: dict, outcomes: Sequence[dict]) -> List[dict]:
    for outcome in outcomes:
        session["records"][outcome["result_id"]]["active"] = outcome["active"]
    active_ids = {
        result_id
        for result_id, record in session["records"].items()
        if record["active"]
    }
    session["clusters"] = _build_clusters(
        session["id"], session["records"], session["edges"], active_ids
    )
    session["marked"].clear()
    session["pending_selections"].clear()
    return copy.deepcopy(session["clusters"])


def _reconcile_undo_preflight_failure(
    session: dict,
    operation: dict,
    entries: Sequence[dict],
    root: Path,
    operation_dir: Path,
    error: str,
    failures: Sequence[dict],
):
    mutable_entries = copy.deepcopy(list(entries))
    location_outcomes = _assess_operation_locations(
        session, mutable_entries, root, operation_dir
    )
    quarantined_ids = {
        outcome["result_id"]
        for outcome in location_outcomes
        if outcome["location"] == "quarantine"
    }
    unresolved = any(
        outcome["location"] in {"ambiguous_both", "missing_or_changed"}
        for outcome in location_outcomes
    )
    if unresolved:
        operation_state = "undo_partial_failed"
        manifest_state = "undo_preflight_partial_failed"
        operation_entries = mutable_entries
    elif quarantined_ids:
        operation_state = "committed"
        manifest_state = "undo_preflight_failed_recoverable"
        operation_entries = [
            entry for entry in mutable_entries
            if entry["result_id"] in quarantined_ids
        ]
    else:
        operation_state = "restored"
        manifest_state = "restored_after_preflight_reconciliation"
        operation_entries = mutable_entries

    with session["lock"]:
        response_clusters = _apply_location_outcomes_locked(
            session, location_outcomes
        )
        operation["state"] = operation_state
        operation["entries"] = copy.deepcopy(operation_entries)
        operation["result_ids"] = [
            entry["result_id"] for entry in operation_entries
        ]
        if operation_state == "restored":
            session["clusters"] = copy.deepcopy(operation["pre_clusters"])
            response_clusters = copy.deepcopy(session["clusters"])
        can_undo = _can_undo_locked(session)
        recovery = _recovery_payload_locked(session)

    manifest_path = Path(operation["manifest_path"])
    manifest = {
        "schema_version": 1,
        "operation_id": operation["operation_id"],
        "session_id": session["id"],
        "scan_root": str(root),
        "quarantine_directory": str(operation_dir),
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "state": manifest_state,
        "entries": mutable_entries,
        "selection_snapshot": copy.deepcopy(
            operation.get("selection_snapshot", [])
        ),
        "pre_operation_clusters": operation["pre_clusters"],
        "preflight_failures": copy.deepcopy(list(failures)),
        "reconciliation": location_outcomes,
    }
    try:
        if (
            not _is_linklike(operation_dir)
            and operation_dir.resolve(strict=True) == operation_dir
            and manifest_path.parent == operation_dir
        ):
            _try_write_manifest(
                manifest_path, manifest, "undo preflight reconciliation manifest write failed"
            )
    except Exception:
        _log_local_exception("undo preflight manifest location validation failed")

    _emit(session, "results_updated", {
        "reason": "undo_preflight_failed_reconciled",
        "clusters": response_clusters,
        "marked_ids": [],
        "marked": [],
        "can_undo": can_undo,
        **recovery,
    })
    return jsonify({
        "error": error,
        "failures": list(failures),
        "reconciliation": location_outcomes,
        "clusters": response_clusters,
        "marked_ids": [],
        "marked": [],
        "manifest_path": str(manifest_path),
        "can_undo": can_undo,
        "recovery_available": operation_state == "committed",
        **recovery,
    }), 409


def _is_filesystem_root(path: Path) -> bool:
    if path == path.parent:
        return True
    try:
        anchor = Path(path.anchor).resolve(strict=False) if path.anchor else None
    except OSError:
        anchor = None
    return anchor is not None and path == anchor


def _safe_relative_path(relative_text: str) -> Path:
    relative = Path(relative_text)
    if relative.is_absolute() or not relative.parts:
        raise ApiProblem("Recorded relative path is unsafe", 409)
    if any(part in ("", ".", "..") for part in relative.parts):
        raise ApiProblem("Recorded relative path is unsafe", 409)
    return relative


def _prepare_quarantine_paths(root: Path, operation_id: str, records: Sequence[dict]) -> Tuple[Path, Path, List[dict]]:
    if _is_filesystem_root(root):
        raise ApiProblem("Quarantine actions are refused for filesystem or drive roots", 409)
    if root.resolve(strict=True) != root:
        raise ApiProblem("Scan root identity has changed", 409)
    _ensure_no_linklike_components(root, root)

    quarantine_base = root.parent / f"{root.name}.dupefinder_quarantine"
    _ensure_no_linklike_components(root.parent, root.parent)
    if quarantine_base.exists():
        if _is_linklike(quarantine_base) or not quarantine_base.is_dir():
            raise ApiProblem("Quarantine base is linked or is not a directory", 409)
        if quarantine_base.resolve(strict=True) != quarantine_base:
            raise ApiProblem("Quarantine base resolved outside its recorded path", 409)
    else:
        quarantine_base.mkdir(mode=0o700)

    operation_dir = quarantine_base / operation_id
    if operation_dir.exists() or operation_dir.is_symlink():
        raise ApiProblem("Quarantine operation destination already exists", 409)
    operation_dir.mkdir(mode=0o700)
    if operation_dir.resolve(strict=True) != operation_dir:
        raise ApiProblem("Quarantine operation directory is unsafe", 409)

    entries = []
    for record in records:
        relative = _safe_relative_path(record["relative_path"])
        destination = operation_dir / relative
        destination_parent = destination.parent
        destination_parent.mkdir(parents=True, exist_ok=True)
        _ensure_no_linklike_components(destination_parent, operation_dir)
        parent_resolved = destination_parent.resolve(strict=True)
        parent_resolved.relative_to(operation_dir)
        resolved_candidate = parent_resolved / destination.name
        resolved_candidate.relative_to(operation_dir)
        if destination.exists() or destination.is_symlink():
            raise ApiProblem("A quarantine destination already exists", 409)
        entries.append({
            "result_id": record["id"],
            "relative_path": record["relative_path"],
            "original_path": str(record["_path"]),
            "quarantine_path": str(destination),
            "file_sha256": record["file_sha256"],
            "status": "pending",
        })
    return quarantine_base, operation_dir, entries


def _write_manifest_atomic(manifest_path: Path, manifest: dict) -> None:
    manifest_parent = manifest_path.parent
    if (
        not manifest_parent.is_dir()
        or _is_linklike(manifest_parent)
        or manifest_parent.resolve(strict=True) != manifest_parent
    ):
        raise OSError("manifest directory identity is unsafe")
    fd, temp_name = tempfile.mkstemp(
        prefix=".manifest-", suffix=".tmp", dir=manifest_parent
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, manifest_path)
        if os.name != "nt":
            directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            directory_fd = os.open(manifest_parent, directory_flags)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _try_write_manifest(manifest_path: Path, manifest: dict, context: str) -> bool:
    try:
        _write_manifest_atomic(manifest_path, manifest)
        return True
    except Exception:
        _log_local_exception(context)
        return False


def _move_file_no_overwrite(source: Path, destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"destination already exists: {destination}")
    if os.name == "nt":
        os.rename(source, destination)
        return
    os.link(source, destination, follow_symlinks=False)
    try:
        os.unlink(source)
    except Exception:
        try:
            os.unlink(destination)
        except OSError:
            pass
        raise


@contextlib.contextmanager
def _file_operation():
    global active_file_operations
    with server_state_lock:
        if shutdown_requested:
            raise ApiProblem("Server shutdown is already in progress", 503)
        active_file_operations += 1
    try:
        yield
    finally:
        with server_state_lock:
            active_file_operations -= 1


def _selection_review_locked(session: dict, result_ids: Sequence[str]) -> List[dict]:
    member_payloads = {}
    membership = {}
    for cluster in session["clusters"]:
        for member in cluster["members"]:
            membership[member["id"]] = cluster["id"]
            member_payloads[member["id"]] = member
    review = []
    for result_id in result_ids:
        item = copy.deepcopy(member_payloads[result_id])
        item["cluster_id"] = membership[result_id]
        review.append(item)
    return review


def _preflight_selection_locked(session: dict, result_ids: Sequence[str]) -> List[dict]:
    _require_complete_locked(session)
    membership = _cluster_membership_locked(session)
    records = []
    for result_id in result_ids:
        record = session["records"].get(result_id)
        if record is None or not record["active"] or result_id not in membership:
            raise ApiProblem("Selection contains an inactive or unknown result ID", 409)
        records.append(record)
    selected = set(result_ids)
    for cluster in session["clusters"]:
        cluster_ids = {member["id"] for member in cluster["members"]}
        if selected.intersection(cluster_ids) and cluster_ids.issubset(selected):
            raise ApiProblem("Quarantine must leave at least one active member in every affected group", 409)
    return records


def _latest_unrestored_operation_locked(session: dict) -> Optional[dict]:
    for operation in reversed(session["operations"]):
        state = operation.get("state")
        if state == "committed":
            return operation
        if state in {"partial_failed", "undo_partial_failed"}:
            # A newer operation with an unresolved partial state must be dealt
            # with from its durable manifest before an older operation can be
            # touched.  Skipping past it would make the older snapshot unsafe.
            return None
    return None


def _can_undo_locked(session: dict) -> bool:
    return _latest_unrestored_operation_locked(session) is not None


def _server_has_active_work() -> bool:
    with server_state_lock:
        if active_file_operations:
            return True
    with registry_lock:
        sessions = list(scan_sessions.values())
    for session in sessions:
        with session["lock"]:
            thread = session.get("thread")
            if session["status"] in {"scanning", "paused", "cancelling"}:
                return True
            if thread is not None and thread.is_alive():
                return True
    return False


def _cancel_active_scans_for_shutdown() -> int:
    with registry_lock:
        sessions = list(scan_sessions.values())
    cancelling = []
    for session in sessions:
        with session["lock"]:
            if session["status"] not in {"scanning", "paused"}:
                continue
            session["status"] = "cancelling"
            session["message"] = "Cancelling scan before graceful shutdown"
            session["cancel_event"].set()
            # A paused worker must be released so it can observe cancellation
            # and run its cache-cleanup finally block.
            session["pause_event"].set()
            session["condition"].notify_all()
            cancelling.append(session)
    for session in cancelling:
        _emit(session, "status", {
            "message": "Cancelling scan before graceful shutdown...",
        })
    return len(cancelling)


def _request_graceful_shutdown_if_idle() -> bool:
    global shutdown_requested
    with server_state_lock:
        shutdown_requested = True
        server = server_instance
    if server is None:
        return False
    _cancel_active_scans_for_shutdown()
    if _server_has_active_work():
        return False
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


@app.route("/")
def index():
    index_path = Path(__file__).resolve().with_name("index.html")
    try:
        html = index_path.read_text(encoding="utf-8")
    except OSError:
        return Response("Application interface is unavailable", status=500, mimetype="text/plain")
    if html.count("__DUPEFINDER_API_TOKEN__") != 1:
        return Response(
            "Application interface token placeholder is invalid",
            status=500,
            mimetype="text/plain",
        )
    html = html.replace("__DUPEFINDER_API_TOKEN__", API_TOKEN, 1)
    return Response(html, mimetype="text/html")


@app.route("/api/session", methods=["POST"])
def create_scan_session():
    _expire_registries()
    with server_state_lock:
        if shutdown_requested:
            raise ApiProblem("Server shutdown is already in progress", 503)
        with registry_lock:
            for existing in scan_sessions.values():
                with existing["lock"]:
                    recovery = _recovery_payload_locked(existing)
                    if recovery["recovery_required"]:
                        raise ApiProblem(
                            "A prior file operation requires recovery before a new scan can start",
                            409,
                            **recovery,
                        )
            if len(scan_sessions) >= MAX_SESSIONS:
                raise ApiProblem("Too many active sessions", 429)
            session_id, session = _new_session()
            scan_sessions[session_id] = session
    return jsonify({"session_id": session_id})


@app.route("/api/select-folder", methods=["POST"])
def select_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog

        root_window = tk.Tk()
        root_window.withdraw()
        try:
            root_window.wm_attributes("-topmost", 1)
        except Exception:
            pass
        try:
            folder_path = filedialog.askdirectory(
                title="Select folder to scan for duplicates", mustexist=True
            )
        finally:
            root_window.destroy()
    except Exception:
        _log_local_exception("folder picker failed")
        raise ApiProblem("The native folder picker could not be opened", 500)

    if not folder_path:
        return jsonify({"success": False, "cancelled": True})
    return jsonify(_register_folder_path(folder_path))


@app.route("/api/scan", methods=["POST"])
def start_scan():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    root, root_identity = _resolve_folder_token(data.get("folder_token"))
    quick_mode = data.get("quick_mode", False)
    threshold = data.get("threshold", 0.85)
    if not isinstance(quick_mode, bool):
        raise ApiProblem("quick_mode must be a boolean")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
        raise ApiProblem("threshold must be a number")
    threshold = float(threshold)
    if not 0.50 <= threshold <= 1.0:
        raise ApiProblem("threshold must be between 0.50 and 1.00")

    with server_state_lock:
        if shutdown_requested:
            raise ApiProblem("Server shutdown is already in progress", 503)
        with session["lock"]:
            if session["status"] != "idle" or session.get("thread") is not None:
                raise ApiProblem("This session has already been used for a scan", 409)
            session["root"] = root
            session["root_identity"] = root_identity
            session["quick_mode"] = quick_mode
            session["threshold"] = threshold
            session["status"] = "scanning"
            session["message"] = "Starting scan"
            session["pause_event"].set()
            session["cancel_event"].clear()
            worker = threading.Thread(
                target=_scan_worker,
                args=(session, root, quick_mode, threshold),
                daemon=True,
                name=f"dupefinder-scan-{session['id'][:8]}",
            )
            session["thread"] = worker
    _emit(session, "status", {"message": "Starting scan..."})
    worker.start()
    return jsonify({"status": "started", "session_id": session["id"]})


@app.route("/api/pause", methods=["POST"])
def pause_scan():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    with session["lock"]:
        if session["status"] != "scanning":
            raise ApiProblem("Only an active scan can be paused", 409)
        session["pause_event"].clear()
        session["status"] = "paused"
    _emit(session, "paused", {"message": "Scan paused"})
    return jsonify({"status": "paused"})


@app.route("/api/resume", methods=["POST"])
def resume_scan():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    with session["lock"]:
        if session["status"] != "paused":
            raise ApiProblem("Only a paused scan can be resumed", 409)
        session["status"] = "scanning"
        session["pause_event"].set()
    _emit(session, "resumed", {"message": "Scan resumed"})
    return jsonify({"status": "scanning"})


@app.route("/api/cancel", methods=["POST"])
def cancel_scan():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    with session["lock"]:
        if session["status"] not in {"scanning", "paused"}:
            raise ApiProblem("Only an active scan can be cancelled", 409)
        session["status"] = "cancelling"
        session["cancel_event"].set()
        session["pause_event"].set()
    _emit(session, "status", {"message": "Cancelling scan..."})
    return jsonify({"status": "cancelling"})


@app.route("/api/scan-control", methods=["POST"])
def control_scan():
    data = _json_body()
    action = data.get("action")
    if action == "pause":
        return pause_scan()
    if action == "resume":
        return resume_scan()
    if action == "cancel":
        return cancel_scan()
    raise ApiProblem("action must be pause, resume, or cancel")


@app.route("/api/events/<session_id>")
def stream_events(session_id: str):
    session = _session_or_error(session_id)
    last_event_value = request.headers.get("Last-Event-ID", request.args.get("last_event_id", "0"))
    try:
        last_event_id = max(0, int(last_event_value))
    except (TypeError, ValueError):
        raise ApiProblem("Last-Event-ID must be an integer")

    def generate():
        cursor = last_event_id
        while True:
            keepalive = False
            with session["condition"]:
                available = [event for event in session["events"] if event["id"] > cursor]
                if not available:
                    if session["status"] in TERMINAL_STATUSES:
                        return
                    session["condition"].wait(timeout=15)
                    available = [event for event in session["events"] if event["id"] > cursor]
                if not available:
                    keepalive = True
            if keepalive:
                # Never suspend the generator while holding the session lock;
                # a slow/disconnected client must not block the scan worker.
                yield ": keepalive\n\n"
                continue
            for event in available:
                cursor = event["id"]
                payload = {"type": event["type"], "data": event["data"]}
                yield f"id: {event['id']}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                if event["type"] in TERMINAL_EVENTS:
                    return

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/clusters/<session_id>")
def get_clusters(session_id: str):
    session = _session_or_error(session_id)
    # A refresh/reconciliation must not snapshot the session while a mark,
    # quarantine, or Undo action has released the state lock for filesystem I/O.
    # All mutating actions take action_lock before lock, so keep that order here.
    with session["action_lock"]:
        with session["lock"]:
            payload = {
                "status": session["status"],
                "progress": session["progress"],
                "message": session["message"],
                "clusters": copy.deepcopy(session["clusters"]),
                "marked_ids": sorted(session["marked"]),
                "marked": sorted(session["marked"]),
                "errors": copy.deepcopy(session["errors"]),
                "can_undo": _can_undo_locked(session),
            }
            payload.update(_recovery_payload_locked(session))
            return jsonify(payload)


@app.route("/api/mark", methods=["POST"])
def mark_result():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    result_id = _bounded_string(data.get("result_id"), "result_id", 256)
    marked = data.get("marked")
    if marked is not None and not isinstance(marked, bool):
        raise ApiProblem("marked must be a boolean when provided")
    with session["action_lock"]:
        with session["lock"]:
            _require_complete_locked(session)
            membership = _cluster_membership_locked(session)
            record = session["records"].get(result_id)
            if record is None or not record["active"] or result_id not in membership:
                raise ApiProblem("Unknown or inactive result ID", 404)
            proposed = set(session["marked"])
            if marked is None:
                marked = result_id not in proposed
            if marked:
                proposed.add(result_id)
            else:
                proposed.discard(result_id)
            _validate_marked_survivors_locked(session, proposed)
            session["marked"] = proposed
            return jsonify(_marked_response_locked(session))


@app.route("/api/mark-reset", methods=["POST"])
@app.route("/api/mark/reset", methods=["POST"])
def reset_marks():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    with session["action_lock"]:
        with session["lock"]:
            _require_complete_locked(session)
            session["marked"].clear()
            return jsonify(_marked_response_locked(session))


@app.route("/api/mark-exact", methods=["POST"])
@app.route("/api/mark/exact", methods=["POST"])
def auto_mark_exact():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    with session["action_lock"]:
        with session["lock"]:
            _require_complete_locked(session)
            membership = _cluster_membership_locked(session)
            exact_groups: Dict[str, List[str]] = defaultdict(list)
            for result_id in membership:
                record = session["records"][result_id]
                if record["active"]:
                    exact_groups[record["file_sha256"]].append(result_id)
            proposed = set(session["marked"])
            for ids in exact_groups.values():
                if len(ids) < 2:
                    continue
                ordered = sorted(
                    ids,
                    key=lambda item: (
                        session["records"][item]["relative_path"].casefold(),
                        session["records"][item]["relative_path"],
                        item,
                    ),
                )
                unmarked = [result_id for result_id in ordered if result_id not in proposed]
                if not unmarked:
                    # Every mark was manual. Preserve it rather than silently
                    # changing the user's selection; the cluster-level survivor
                    # guard still prevents selecting an entire review group.
                    continue
                keeper = unmarked[0]
                proposed.update(
                    result_id for result_id in ordered if result_id != keeper
                )
            _validate_marked_survivors_locked(session, proposed)
            session["marked"] = proposed
            response = _marked_response_locked(session)
            response["policy"] = (
                "existing manual marks preserved; each byte-exact SHA-256 group "
                "with an available unmarked member keeps one deterministic copy"
            )
            return jsonify(response)


@app.route("/api/quarantine/prepare", methods=["POST"])
def prepare_quarantine():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    result_ids = _parse_result_ids(data.get("result_ids"))
    with session["action_lock"]:
        with session["lock"]:
            _expire_pending_selections_locked(session)
            records = _preflight_selection_locked(session, result_ids)
            if set(result_ids) != set(session["marked"]):
                raise ApiProblem("Prepared IDs must exactly match the authoritative marked selection", 409)
            selection_token = secrets.token_urlsafe(32)
            expires_at = time.time() + SELECTION_TOKEN_TTL_SECONDS
            ordered_ids = tuple(result_ids)
            review = _selection_review_locked(session, ordered_ids)
            session["pending_selections"][selection_token] = {
                "result_ids": ordered_ids,
                "items": copy.deepcopy(review),
                "created_at": time.time(),
                "expires_at": expires_at,
            }
            response = {
                "selection_token": selection_token,
                "expires_at": expires_at,
                "items": review,
                "review": review,
                "can_undo": _can_undo_locked(session),
            }
            response.update(_recovery_payload_locked(session))
            return jsonify(response)


@app.route("/api/quarantine/commit", methods=["POST"])
def commit_quarantine():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    selection_token = _bounded_string(data.get("selection_token"), "selection_token", 256)

    with session["action_lock"], _file_operation():
        with session["lock"]:
            can_undo_before = _can_undo_locked(session)
            recovery_before = _recovery_payload_locked(session)
            _expire_pending_selections_locked(session)
            selection = session["pending_selections"].get(selection_token)
            if selection is None:
                raise ApiProblem(
                    "Invalid or expired selection token", 404,
                    can_undo=can_undo_before,
                    **recovery_before,
                )
            result_ids = tuple(selection["result_ids"])
            selection_items = copy.deepcopy(selection["items"])
            try:
                records = _preflight_selection_locked(session, result_ids)
            except ApiProblem as exc:
                exc.details.setdefault("can_undo", can_undo_before)
                for key, value in recovery_before.items():
                    exc.details.setdefault(key, value)
                raise
            if set(result_ids) != set(session["marked"]):
                raise ApiProblem(
                    "Marked selection changed after preparation", 409,
                    can_undo=can_undo_before,
                    **recovery_before,
                )
            root = session["root"]
            root_identity = session["root_identity"]
            pre_clusters = copy.deepcopy(session["clusters"])
            selected_ids = set(result_ids)
            survivor_records = []
            for cluster in session["clusters"]:
                cluster_ids = {member["id"] for member in cluster["members"]}
                if not selected_ids.intersection(cluster_ids):
                    continue
                survivor_records.extend(
                    session["records"][member["id"]]
                    for member in cluster["members"]
                    if member["id"] not in selected_ids
                    and session["records"][member["id"]]["active"]
                )
            active_after = {
                result_id for result_id, record in session["records"].items()
                if record["active"] and result_id not in result_ids
            }
            clusters_after = _build_clusters(
                session["id"], session["records"], session["edges"], active_after
            )

        preflight_failures = []
        root_problem = _directory_identity_problem(root, root_identity)
        if root_problem:
            preflight_failures.append({
                "result_id": None,
                "relative_path": ".",
                "role": "scan_root",
                "error": root_problem,
            })
        for record in records:
            problem = _identity_problem(record, root, require_hash=True)
            if problem:
                preflight_failures.append({
                    "result_id": record["id"],
                    "relative_path": record["relative_path"],
                    "role": "selected",
                    "error": problem,
                })
        for record in survivor_records:
            problem = _identity_problem(record, root, require_hash=True)
            if problem:
                preflight_failures.append({
                    "result_id": record["id"],
                    "relative_path": record["relative_path"],
                    "role": "required_survivor",
                    "error": problem,
                })
        if preflight_failures:
            return jsonify({
                "error": "Quarantine preflight failed; no files were moved",
                "failures": preflight_failures,
                "can_undo": can_undo_before,
                **recovery_before,
            }), 409

        operation_id = str(uuid.uuid4())
        try:
            root_problem = _directory_identity_problem(root, root_identity)
            if root_problem:
                raise ApiProblem(
                    "Scan root identity changed before quarantine preparation",
                    409,
                )
            quarantine_base, operation_dir, entries = _prepare_quarantine_paths(
                root, operation_id, records
            )
        except ApiProblem as exc:
            exc.details.setdefault("can_undo", can_undo_before)
            for key, value in recovery_before.items():
                exc.details.setdefault(key, value)
            raise
        except Exception:
            _log_local_exception("quarantine destination preparation failed")
            raise ApiProblem(
                "Quarantine destination could not be prepared safely", 409,
                can_undo=can_undo_before,
                **recovery_before,
            )

        manifest_path = operation_dir / "manifest.json"
        manifest = {
            "schema_version": 1,
            "operation_id": operation_id,
            "session_id": session["id"],
            "scan_root": str(root),
            "quarantine_directory": str(operation_dir),
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
            "state": "prepared",
            "entries": entries,
            "selection_snapshot": selection_items,
            "pre_operation_clusters": pre_clusters,
        }
        try:
            _write_manifest_atomic(manifest_path, manifest)
        except Exception:
            _log_local_exception("initial manifest write failed")
            raise ApiProblem(
                "Durable quarantine manifest could not be written", 500,
                can_undo=can_undo_before,
                **recovery_before,
            )

        moved_entries = []
        failure = None
        for survivor in survivor_records:
            root_problem = _directory_identity_problem(root, root_identity)
            if root_problem:
                failure = {
                    "result_id": None,
                    "role": "scan_root",
                    "error": root_problem,
                }
                break
            problem = _identity_problem(survivor, root, require_hash=True)
            if problem:
                failure = {
                    "result_id": survivor["id"],
                    "role": "required_survivor",
                    "error": problem,
                }
                break
        for entry in entries:
            if failure is not None:
                break
            source = Path(entry["original_path"])
            destination = Path(entry["quarantine_path"])
            record = session["records"][entry["result_id"]]
            root_problem = _directory_identity_problem(root, root_identity)
            if root_problem:
                failure = {
                    "result_id": None,
                    "role": "scan_root",
                    "error": root_problem,
                }
                break
            problem = _identity_problem(record, root, require_hash=True)
            if problem:
                failure = {"result_id": entry["result_id"], "error": problem}
                break
            try:
                _ensure_no_linklike_components(destination.parent, operation_dir)
                destination.parent.resolve(strict=True).relative_to(operation_dir)
                _move_file_no_overwrite(source, destination)
                entry["status"] = "quarantined"
                moved_entries.append(entry)
                moved_stat = destination.lstat()
                expected_identity = (
                    record["st_dev"], record["st_ino"], record["size"], record["mtime_ns"]
                )
                if (
                    not stat_module.S_ISREG(moved_stat.st_mode)
                    or _stable_stat_tuple(moved_stat) != expected_identity
                    or compute_file_sha256(destination) != record["file_sha256"]
                    or _stable_stat_tuple(destination.lstat()) != expected_identity
                ):
                    raise ValueError("moved source did not retain its scanned identity")
                manifest["state"] = "moving"
                manifest["updated_at"] = _utc_now()
                _write_manifest_atomic(manifest_path, manifest)
            except Exception as exc:
                _log_local_exception("quarantine move failed")
                failure = {
                    "result_id": entry["result_id"],
                    "error": "file move failed safely",
                }
                break

        if failure is None:
            for survivor in survivor_records:
                root_problem = _directory_identity_problem(root, root_identity)
                if root_problem:
                    failure = {
                        "result_id": None,
                        "role": "scan_root",
                        "error": root_problem,
                    }
                    break
                problem = _identity_problem(survivor, root, require_hash=True)
                if problem:
                    failure = {
                        "result_id": survivor["id"],
                        "role": "required_survivor",
                        "error": problem,
                    }
                    break

        if failure is None:
            committed_locations = _assess_operation_locations(
                session, entries, root, operation_dir
            )
            invalid_location = next(
                (
                    outcome for outcome in committed_locations
                    if outcome["location"] != "quarantine"
                ),
                None,
            )
            if invalid_location is not None:
                failure = {
                    "result_id": invalid_location["result_id"],
                    "error": "moved file location failed final identity validation",
                }

        if failure is None:
            manifest["state"] = "committed"
            manifest["updated_at"] = _utc_now()
            if not _try_write_manifest(
                manifest_path, manifest, "final quarantine manifest write failed"
            ):
                failure = {
                    "result_id": None,
                    "error": "final durable manifest update failed",
                }

        if failure is not None:
            rollback_failures = []
            for entry in reversed(moved_entries):
                original = Path(entry["original_path"])
                quarantined = Path(entry["quarantine_path"])
                try:
                    if original.exists() or original.is_symlink():
                        raise FileExistsError("original path is no longer empty")
                    if _directory_identity_problem(root, root_identity):
                        raise OSError("scan root identity changed")
                    _ensure_no_linklike_components(original.parent, root)
                    original.parent.resolve(strict=True).relative_to(root)
                    _ensure_no_linklike_components(quarantined, operation_dir)
                    quarantined.parent.resolve(strict=True).relative_to(operation_dir)
                    if compute_file_sha256(quarantined) != entry["file_sha256"]:
                        raise ValueError("quarantined content changed before rollback")
                    _move_file_no_overwrite(quarantined, original)
                    entry["status"] = "rolled_back"
                except Exception as exc:
                    _log_local_exception("quarantine rollback failed")
                    entry["status"] = "rollback_failed"
                    rollback_failures.append({
                        "result_id": entry["result_id"],
                        "error": "rollback failed; consult the durable manifest",
                    })
                manifest["updated_at"] = _utc_now()
                _try_write_manifest(
                    manifest_path, manifest, "quarantine rollback manifest update failed"
                )

            location_outcomes = _assess_operation_locations(
                session, entries, root, operation_dir
            )
            quarantined_ids = {
                outcome["result_id"]
                for outcome in location_outcomes
                if outcome["location"] == "quarantine"
            }
            unresolved = any(
                outcome["location"] in {"ambiguous_both", "missing_or_changed"}
                for outcome in location_outcomes
            )
            if unresolved:
                operation_state = "partial_failed"
                manifest_state = "partial_failed"
                operation_entries = copy.deepcopy(entries)
            elif quarantined_ids:
                operation_state = "committed"
                manifest_state = "partial_failed_recoverable"
                operation_entries = copy.deepcopy([
                    entry for entry in entries
                    if entry["result_id"] in quarantined_ids
                ])
            else:
                operation_state = "rolled_back"
                manifest_state = "rolled_back"
                operation_entries = copy.deepcopy(entries)

            manifest["state"] = manifest_state
            manifest["failure"] = failure
            manifest["rollback_failures"] = rollback_failures
            manifest["reconciliation"] = location_outcomes
            manifest["updated_at"] = _utc_now()
            _try_write_manifest(
                manifest_path, manifest, "final rollback manifest update failed"
            )
            with session["lock"]:
                response_clusters = _apply_location_outcomes_locked(
                    session, location_outcomes
                )
                session["operations"].append({
                    "operation_id": operation_id,
                    "state": operation_state,
                    "manifest_path": str(manifest_path),
                    "quarantine_directory": str(operation_dir),
                    "entries": operation_entries,
                    "selection_snapshot": selection_items,
                    "pre_clusters": pre_clusters,
                    "result_ids": [
                        entry["result_id"] for entry in operation_entries
                    ],
                })
                session["pending_selections"].clear()
                can_undo_after_failure = _can_undo_locked(session)
                recovery_after_failure = _recovery_payload_locked(session)
            _emit(session, "results_updated", {
                "reason": "quarantine_failed_reconciled",
                "clusters": response_clusters,
                "marked_ids": [],
                "marked": [],
                "can_undo": can_undo_after_failure,
                **recovery_after_failure,
            })
            return jsonify({
                "error": "Quarantine failed; rollback was attempted",
                "failure": failure,
                "rollback_failures": rollback_failures,
                "reconciliation": location_outcomes,
                "clusters": response_clusters,
                "marked_ids": [],
                "marked": [],
                "manifest_path": str(manifest_path),
                "quarantine_location": str(operation_dir),
                "can_undo": can_undo_after_failure,
                "recovery_available": operation_state == "committed",
                **recovery_after_failure,
            }), 409

        operation = {
            "operation_id": operation_id,
            "state": "committed",
            "manifest_path": str(manifest_path),
            "quarantine_directory": str(operation_dir),
            "entries": copy.deepcopy(entries),
            "selection_snapshot": selection_items,
            "pre_clusters": pre_clusters,
            "result_ids": list(result_ids),
        }
        with session["lock"]:
            for result_id in result_ids:
                session["records"][result_id]["active"] = False
            session["clusters"] = clusters_after
            session["marked"].clear()
            session["operations"].append(operation)
            session["pending_selections"].clear()
            response_clusters = copy.deepcopy(session["clusters"])
            recovery_after_commit = _recovery_payload_locked(session)
        _emit(session, "results_updated", {
            "reason": "quarantine_committed",
            "clusters": response_clusters,
            "marked_ids": [],
            "marked": [],
            "can_undo": True,
            **recovery_after_commit,
        })
        return jsonify({
            "quarantined": len(result_ids),
            "clusters": response_clusters,
            "marked_ids": [],
            "marked": [],
            "manifest_path": str(manifest_path),
            "quarantine_location": str(operation_dir),
            "can_undo": True,
            **recovery_after_commit,
        })


@app.route("/api/undo", methods=["POST"])
def undo_quarantine():
    data = _json_body()
    session = _session_or_error(data.get("session_id"))
    with session["action_lock"], _file_operation():
        with session["lock"]:
            _require_complete_locked(session)
            recovery_before = _recovery_payload_locked(session)
            operation = _latest_unrestored_operation_locked(session)
            if operation is None:
                raise ApiProblem(
                    "No committed quarantine operation is available to undo", 409,
                    can_undo=False,
                    **recovery_before,
                )
            entries = copy.deepcopy(operation["entries"])
            root = session["root"]
            root_identity = session["root_identity"]

        operation_dir = Path(operation["quarantine_directory"])
        try:
            if _directory_identity_problem(root, root_identity):
                raise ValueError("scan root identity changed")
            if _is_linklike(operation_dir) or operation_dir.resolve(strict=True) != operation_dir:
                raise ValueError("operation directory identity changed")
            manifest_path_check = Path(operation["manifest_path"]).resolve(strict=True)
            manifest_path_check.relative_to(operation_dir)
        except Exception:
            return _reconcile_undo_preflight_failure(
                session,
                operation,
                entries,
                root,
                operation_dir,
                "Undo preflight failed; quarantine operation directory is unsafe",
                [{
                    "result_id": None,
                    "relative_path": ".",
                    "role": "quarantine_operation",
                    "error": "quarantine operation directory failed safety validation",
                }],
            )

        failures = []
        root_problem = _directory_identity_problem(root, root_identity)
        if root_problem:
            failures.append({
                "result_id": None,
                "relative_path": ".",
                "role": "scan_root",
                "error": root_problem,
            })
        for entry in entries:
            original = Path(entry["original_path"])
            quarantined = Path(entry["quarantine_path"])
            try:
                relative = _safe_relative_path(entry["relative_path"])
                if original != root / relative:
                    raise ValueError("recorded original path mismatch")
                if quarantined != operation_dir / relative:
                    raise ValueError("recorded quarantine path mismatch")
                if original.exists() or original.is_symlink():
                    raise FileExistsError("original destination is occupied")
                original.parent.resolve(strict=True).relative_to(root)
                _ensure_no_linklike_components(original.parent, root)
                quarantined.resolve(strict=True).relative_to(operation_dir)
                _ensure_no_linklike_components(quarantined, operation_dir)
                if _is_linklike(quarantined):
                    raise ValueError("quarantined source is linked or a reparse point")
                if quarantined.resolve(strict=True) != quarantined:
                    raise ValueError("quarantined source path changed")
                if not quarantined.is_file():
                    raise ValueError("quarantined source is missing or not a regular file")
                if compute_file_sha256(quarantined) != entry["file_sha256"]:
                    raise ValueError("quarantined source content changed")
            except Exception as exc:
                failures.append({
                    "result_id": entry["result_id"],
                    "relative_path": entry["relative_path"],
                    "error": "quarantined or original path failed safety validation",
                })
        if failures:
            return _reconcile_undo_preflight_failure(
                session,
                operation,
                entries,
                root,
                operation_dir,
                "Undo preflight failed; no files were restored",
                failures,
            )

        manifest_path = Path(operation["manifest_path"])
        manifest = {
            "schema_version": 1,
            "operation_id": operation["operation_id"],
            "session_id": session["id"],
            "scan_root": str(root),
            "quarantine_directory": operation["quarantine_directory"],
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
            "state": "restoring",
            "entries": entries,
            "selection_snapshot": copy.deepcopy(
                operation.get("selection_snapshot", [])
            ),
            "pre_operation_clusters": operation["pre_clusters"],
        }
        try:
            _write_manifest_atomic(manifest_path, manifest)
        except Exception:
            _log_local_exception("undo manifest write failed")
            raise ApiProblem(
                "Undo manifest could not be updated safely", 500,
                can_undo=True,
                **recovery_before,
            )

        restored_entries = []
        failure = None
        for entry in entries:
            original = Path(entry["original_path"])
            quarantined = Path(entry["quarantine_path"])
            try:
                if original.exists() or original.is_symlink():
                    raise FileExistsError("original destination became occupied")
                if _directory_identity_problem(root, root_identity):
                    raise OSError("scan root identity changed")
                _ensure_no_linklike_components(original.parent, root)
                original.parent.resolve(strict=True).relative_to(root)
                _ensure_no_linklike_components(quarantined, operation_dir)
                quarantined.resolve(strict=True).relative_to(operation_dir)
                if compute_file_sha256(quarantined) != entry["file_sha256"]:
                    raise ValueError("quarantined source changed during undo")
                _move_file_no_overwrite(quarantined, original)
                entry["status"] = "restored"
                restored_entries.append(entry)
                if _identity_at_path_problem(
                    session["records"][entry["result_id"]],
                    original,
                    root,
                    require_hash=True,
                ):
                    raise ValueError("restored source failed scanned identity validation")
                manifest["updated_at"] = _utc_now()
                _write_manifest_atomic(manifest_path, manifest)
            except Exception as exc:
                _log_local_exception("quarantine restore failed")
                failure = {
                    "result_id": entry["result_id"],
                    "error": "restore failed safely",
                }
                break

        if failure is None:
            restored_locations = _assess_operation_locations(
                session, entries, root, operation_dir
            )
            invalid_location = next(
                (
                    outcome for outcome in restored_locations
                    if outcome["location"] != "original"
                ),
                None,
            )
            if invalid_location is not None:
                failure = {
                    "result_id": invalid_location["result_id"],
                    "error": "restored file location failed final identity validation",
                }

        if failure is None:
            manifest["state"] = "restored"
            manifest["updated_at"] = _utc_now()
            if not _try_write_manifest(
                manifest_path, manifest, "final undo manifest write failed"
            ):
                failure = {
                    "result_id": None,
                    "error": "final durable undo manifest update failed",
                }

        if failure is not None:
            rollback_failures = []
            for entry in reversed(restored_entries):
                original = Path(entry["original_path"])
                quarantined = Path(entry["quarantine_path"])
                try:
                    if quarantined.exists() or quarantined.is_symlink():
                        raise FileExistsError("quarantine destination became occupied")
                    if _directory_identity_problem(root, root_identity):
                        raise OSError("scan root identity changed")
                    _ensure_no_linklike_components(original, root)
                    original.resolve(strict=True).relative_to(root)
                    _ensure_no_linklike_components(quarantined.parent, operation_dir)
                    quarantined.parent.resolve(strict=True).relative_to(operation_dir)
                    if compute_file_sha256(original) != entry["file_sha256"]:
                        raise ValueError("restored content changed before rollback")
                    _move_file_no_overwrite(original, quarantined)
                    entry["status"] = "quarantined"
                except Exception as exc:
                    _log_local_exception("undo rollback failed")
                    entry["status"] = "undo_rollback_failed"
                    rollback_failures.append({
                        "result_id": entry["result_id"],
                        "error": "undo rollback failed; consult the durable manifest",
                    })
                manifest["updated_at"] = _utc_now()
                _try_write_manifest(
                    manifest_path, manifest, "undo rollback manifest update failed"
                )
            location_outcomes = _assess_operation_locations(
                session, entries, root, operation_dir
            )
            quarantined_ids = {
                outcome["result_id"]
                for outcome in location_outcomes
                if outcome["location"] == "quarantine"
            }
            unresolved = any(
                outcome["location"] in {"ambiguous_both", "missing_or_changed"}
                for outcome in location_outcomes
            )
            if unresolved:
                operation_state = "undo_partial_failed"
                manifest_state = "undo_partial_failed"
                operation_entries = copy.deepcopy(entries)
            elif quarantined_ids:
                operation_state = "committed"
                manifest_state = "undo_failed_recoverable"
                operation_entries = copy.deepcopy([
                    entry for entry in entries
                    if entry["result_id"] in quarantined_ids
                ])
            else:
                operation_state = "restored"
                manifest_state = "restored_with_warning"
                operation_entries = copy.deepcopy(entries)

            manifest["state"] = manifest_state
            manifest["undo_failure"] = failure
            manifest["undo_rollback_failures"] = rollback_failures
            manifest["reconciliation"] = location_outcomes
            manifest["updated_at"] = _utc_now()
            _try_write_manifest(
                manifest_path, manifest, "final undo rollback manifest update failed"
            )
            with session["lock"]:
                response_clusters = _apply_location_outcomes_locked(
                    session, location_outcomes
                )
                operation["state"] = operation_state
                operation["entries"] = operation_entries
                operation["result_ids"] = [
                    entry["result_id"] for entry in operation_entries
                ]
                if operation_state == "restored":
                    session["clusters"] = copy.deepcopy(operation["pre_clusters"])
                    response_clusters = copy.deepcopy(session["clusters"])
                can_undo_after_failure = _can_undo_locked(session)
                recovery_after_failure = _recovery_payload_locked(session)
            _emit(session, "results_updated", {
                "reason": "undo_failed_reconciled",
                "clusters": response_clusters,
                "marked_ids": [],
                "marked": [],
                "can_undo": can_undo_after_failure,
                **recovery_after_failure,
            })
            return jsonify({
                "error": "Undo failed; rollback was attempted",
                "failure": failure,
                "rollback_failures": rollback_failures,
                "reconciliation": location_outcomes,
                "clusters": response_clusters,
                "marked_ids": [],
                "marked": [],
                "manifest_path": str(manifest_path),
                "can_undo": can_undo_after_failure,
                "recovery_available": operation_state == "committed",
                **recovery_after_failure,
            }), 409

        with session["lock"]:
            for entry in entries:
                session["records"][entry["result_id"]]["active"] = True
            session["clusters"] = copy.deepcopy(operation["pre_clusters"])
            session["marked"].clear()
            session["pending_selections"].clear()
            operation["state"] = "restored"
            operation["entries"] = copy.deepcopy(entries)
            response_clusters = copy.deepcopy(session["clusters"])
            can_undo = _can_undo_locked(session)
            recovery_after_undo = _recovery_payload_locked(session)
        _emit(session, "results_updated", {
            "reason": "quarantine_undone",
            "clusters": response_clusters,
            "marked_ids": [],
            "marked": [],
            "can_undo": can_undo,
            **recovery_after_undo,
        })
        return jsonify({
            "restored": len(entries),
            "clusters": response_clusters,
            "marked_ids": [],
            "marked": [],
            "manifest_path": str(manifest_path),
            "can_undo": can_undo,
            **recovery_after_undo,
        })


@app.route("/api/thumbnail")
def get_thumbnail():
    session = _session_or_error(request.args.get("session_id"))
    result_id = _bounded_string(request.args.get("result_id"), "result_id", 256)
    size_value = request.args.get("size", "300")
    try:
        size = int(size_value)
    except (TypeError, ValueError):
        raise ApiProblem("size must be an integer")
    if not 32 <= size <= MAX_THUMBNAIL_SIZE:
        raise ApiProblem(f"size must be between 32 and {MAX_THUMBNAIL_SIZE}")

    with session["lock"]:
        _require_complete_locked(session)
        membership = _cluster_membership_locked(session)
        record = session["records"].get(result_id)
        if record is None or not record["active"] or result_id not in membership:
            raise ApiProblem("Unknown or inactive result ID", 404)
        path = record["_path"]
        root = session["root"]
        root_identity = session["root_identity"]
    root_problem = _directory_identity_problem(root, root_identity)
    if root_problem:
        raise ApiProblem(f"Thumbnail refused: {root_problem}", 409)
    problem = _identity_problem(record, root, require_hash=True)
    if problem:
        raise ApiProblem(f"Thumbnail refused: {problem}", 409)

    try:
        with Image.open(path) as image:
            image.seek(0)
            image = ImageOps.exif_transpose(image)
            has_alpha = "A" in image.getbands() or "transparency" in image.info
            image = image.convert("RGBA" if has_alpha else "RGB")
            image.thumbnail((size, size), RESAMPLE_LANCZOS)
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True)
        if (
            _directory_identity_problem(root, root_identity)
            or _identity_problem(record, root, require_hash=True)
        ):
            raise ApiProblem("Thumbnail refused because the file changed during rendering", 409)
    except ApiProblem:
        raise
    except Exception:
        _log_local_exception("thumbnail rendering failed")
        raise ApiProblem("Thumbnail could not be rendered", 500)
    return Response(output.getvalue(), mimetype="image/png")


def _open_result_record(data: dict) -> Tuple[dict, dict]:
    session = _session_or_error(data.get("session_id"))
    result_id = _bounded_string(data.get("result_id"), "result_id", 256)
    with session["lock"]:
        _require_complete_locked(session)
        membership = _cluster_membership_locked(session)
        record = session["records"].get(result_id)
        if record is None or not record["active"] or result_id not in membership:
            raise ApiProblem("Unknown or inactive result ID", 404)
        root = session["root"]
        root_identity = session["root_identity"]
    root_problem = _directory_identity_problem(root, root_identity)
    if root_problem:
        raise ApiProblem(f"Open action refused: {root_problem}", 409)
    problem = _identity_problem(record, root, require_hash=True)
    if problem:
        raise ApiProblem(f"Open action refused: {problem}", 409)
    return session, record


@app.route("/api/open-file", methods=["POST"])
def open_file():
    session, record = _open_result_record(_json_body())
    path = record["_path"]
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(path))
        elif sys.platform == "darwin":
            import subprocess
            subprocess.Popen(["open", str(path)])
        else:
            import subprocess
            subprocess.Popen(["xdg-open", str(path)])
    except Exception:
        _log_local_exception("open file failed")
        raise ApiProblem("The file could not be opened", 500)
    with session["lock"]:
        recovery = _recovery_payload_locked(session)
    return jsonify({"success": True, "result_id": record["id"], **recovery})


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    session, record = _open_result_record(_json_body())
    path = record["_path"]
    try:
        import subprocess
        if sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select,", str(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path.parent)])
    except Exception:
        _log_local_exception("open folder failed")
        raise ApiProblem("The containing folder could not be opened", 500)
    with session["lock"]:
        recovery = _recovery_payload_locked(session)
    return jsonify({"success": True, "result_id": record["id"], **recovery})


@app.route("/api/heartbeat", methods=["POST"])
def heartbeat():
    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ApiProblem("A JSON object is required")

    session_id = data.get("session_id")
    session_status = None
    if session_id is not None:
        session = _session_or_error(session_id)
        with session["lock"]:
            session_status = session["status"]

    _touch_server_activity()
    return jsonify({"status": "ok", "session_status": session_status})


@app.route("/api/shutdown", methods=["POST"])
def shutdown():
    stopped = _request_graceful_shutdown_if_idle()
    return jsonify({"status": "shutting_down" if stopped else "deferred_busy"}), (200 if stopped else 202)


def _idle_watcher() -> None:
    global shutdown_requested
    while True:
        time.sleep(5)
        _expire_registries()
        with server_state_lock:
            idle_elapsed = time.time() - last_server_activity
            if idle_elapsed > HEARTBEAT_TIMEOUT_SECONDS:
                shutdown_requested = True
            should_stop = shutdown_requested
            server = server_instance
        if should_stop and server is not None:
            _cancel_active_scans_for_shutdown()
            if not _server_has_active_work():
                server.shutdown()
                return


def main() -> None:
    global server_instance
    server = make_server(
        "127.0.0.1",
        5000,
        app,
        threaded=True,
        request_handler=TokenSafeRequestHandler,
    )
    with server_state_lock:
        server_instance = server
    threading.Thread(target=_idle_watcher, daemon=True, name="dupefinder-idle-watcher").start()
    webbrowser.open("http://127.0.0.1:5000")
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
