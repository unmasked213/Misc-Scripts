# ============================================================
# VIDEO PLAYLIST GENERATOR
# ============================================================
#
# Run in a folder of videos, or pass --path <folder>. Scans recursively and
# writes Horz.m3u, Vert.m3u and Dupes.m3u there, overwriting the last run.
# Entries carry #EXTINF duration and title; unknown duration writes -1.
#
# Sort: Name A-Z within folder groups; Size, Date modified, Duration and
# Quality sort globally (descending).
# Quality ranks resolution, then HDR/bit depth, codec-normalised bitrate per
# pixel per frame, frame rate, bitrate, size. Missing metadata never shares a
# scale with valid metadata. In accurate mode the bitrate-per-pixel term uses
# the detected active image area, so letterboxing is ranked on real content.
#
# Orientation. Fast is metadata only. Accurate decodes five interior samples
# in one bounded ffmpeg process per changed video, cached, and overrides the
# metadata default only on a stable opposite-orientation embedded frame
# (dark bars, solid-colour bars, full-span boundaries). Every readable video
# lands in exactly one of Horz/Vert, never both.
#
# Dupes.m3u needs ffprobe. Candidates pair on near-equal duration, then
# confirm on a perceptual fingerprint: two 64-bit gradient hashes per interior
# sample, compared frame-for-frame. Samples sit at fixed fractions of running
# time, so copies of one edit hit the same moments at any resolution, codec or
# size. Fingerprints are cached and come free from the accurate-orientation
# decode. Matches group by transitive closure and are written consecutively,
# best copy first, titled [Gnnn position/total label] under a comment line.
#
# ffprobe enables duration, quality and splitting. ffmpeg enables accurate
# orientation and fingerprinting.
#
# Cryptomator: Python may resolve mounted drive-letter paths back to backing
# UNC paths (\\cryptomator-vault\<id>\<name>\...), which players and Explorer
# do not expect. Playlist entries are translated to the mounted drive path
# (E:\folder\file.mp4), detected from mounted drive letters, no per-vault map.
#
# ============================================================

import difflib
import json
import math
import operator
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

os.environ["PYTHONUTF8"] = "1"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_TARGET_DIR = Path(__file__).parent.resolve()
TARGET_DIR = DEFAULT_TARGET_DIR
COUNTDOWN_SECS = 10
PROBE_TIMEOUT = 10
CACHE_SAVE_INTERVAL = 20.0
ORIENTATION_TIMEOUT = 15
ORIENTATION_MAX_DIMENSION = 320
ORIENTATION_MAX_WORKERS = 2
ORIENTATION_SAMPLE_FRACTIONS = (0.15, 0.325, 0.50, 0.675, 0.85)
ORIENTATION_CONTENT_RATIO = 1.05
ORIENTATION_PAD_SPREAD = 10
ORIENTATION_TIE_BREAK = "horizontal"

DUPLICATE_SCAN_ENABLED = True
DUPLICATE_HASH_SIZE = 8
DUPLICATE_MIN_SPREAD = 6.0
DUPLICATE_SIMILAR_DISTANCE = 28
DUPLICATE_IDENTICAL_DISTANCE = 10
DUPLICATE_MIN_FRAME_VOTES = 2
DUPLICATE_VOTE_FRACTION = 0.60
DUPLICATE_DURATION_FLOOR = 0.35
DUPLICATE_DURATION_RATIO = 0.015
DUPLICATE_IDENTICAL_DURATION_GAP = 0.12
DUPLICATE_METADATA_DURATION_GAP = 0.05
DUPLICATE_NAME_MATCH = 0.90
DUPLICATE_MAX_NEIGHBOURS = 60
DUPLICATE_MAX_PAIRS = 500_000
DUPLICATE_MAX_WORKERS = ORIENTATION_MAX_WORKERS

CACHE_FILE = TARGET_DIR / ".playlist_generator_cache.json"
CACHE_SCHEMA_VERSION = 1
# Bumped above both earlier implementations so stale orientation semantics
# cannot survive a classifier change.
PROBE_CACHE_VERSION = 5
ORIENTATION_CACHE_VERSION = 6
SIGNATURE_CACHE_VERSION = 1

VIDEO_EXTENSIONS = {
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".webm",
    ".m4v",
    ".ts",
    ".vob",
    ".mpg",
    ".mpeg",
    ".3gp",
    ".ogv",
}

SORT_OPTIONS = {"1": "Name", "2": "Size", "3": "Date modified", "4": "Duration", "5": "Quality"}

ORIENTATION_OPTIONS = {"1": "Fast (metadata only)", "2": "Accurate (cached content scan)"}

SORT_DESCENDING = {"1": False, "2": True, "3": True, "4": True, "5": True}

CODEC_WEIGHTS = {
    "h264": 1.00,
    "avc1": 1.00,
    "hevc": 1.50,
    "h265": 1.50,
    "av1": 1.80,
    "vp9": 1.40,
    "vp8": 0.85,
    "mpeg4": 0.65,
    "mpeg2video": 0.55,
    "mpeg1video": 0.45,
    "wmv3": 0.75,
    "wmv2": 0.65,
    "vc1": 0.90,
    "theora": 0.75,
    "prores": 1.00,
    "dnxhd": 1.00,
    "ffv1": 1.00,
    "huffyuv": 1.00,
    "rawvideo": 1.00,
}

RESOLUTION_TIERS = (
    (30_000_000, 8),
    (12_000_000, 7),
    (7_000_000, 6),
    (3_000_000, 5),
    (1_700_000, 4),
    (800_000, 3),
    (300_000, 2),
    (0, 1),
)

OUTPUT_NAMES = {"horizontal": "Horz.m3u", "vertical": "Vert.m3u", "duplicates": "Dupes.m3u"}

CRYPTOMATOR_UNC_PREFIX = "\\\\cryptomator-vault\\"

_CRYPTOMATOR_DRIVE_ROOTS = None
_CRYPTOMATOR_ROOT_CACHE = {}


class TargetDirectoryError(Exception):
    pass


def configure_target_directory(arguments):
    global TARGET_DIR
    global CACHE_FILE
    global _CRYPTOMATOR_DRIVE_ROOTS

    if not arguments:
        target = DEFAULT_TARGET_DIR
    elif len(arguments) == 2 and arguments[0] == "--path":
        target_text = arguments[1].strip()

        if not target_text:
            raise TargetDirectoryError("No target folder was supplied.")

        try:
            target = Path(target_text).expanduser().resolve()
        except (OSError, RuntimeError) as error:
            raise TargetDirectoryError(f"Cannot resolve target folder: {target_text}") from error
    else:
        raise TargetDirectoryError("Usage: playlist_generator.py [--path <folder>]")

    try:
        is_directory = target.is_dir()
    except (OSError, PermissionError):
        is_directory = False

    if not is_directory:
        raise TargetDirectoryError(f"Target folder does not exist or is not accessible: {target}")

    TARGET_DIR = target
    CACHE_FILE = TARGET_DIR / ".playlist_generator_cache.json"
    _CRYPTOMATOR_DRIVE_ROOTS = None
    _CRYPTOMATOR_ROOT_CACHE.clear()


def _strip_extended_windows_prefix(path_text):
    if path_text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path_text[8:]

    if re.match(r"^\\\\\?\\[A-Za-z]:\\", path_text):
        return path_text[4:]

    return path_text

def _windows_path_text(path):
    return _strip_extended_windows_prefix(str(path).replace("/", "\\"))

def _available_windows_drive_roots():
    if os.name != "nt":
        return []

    try:
        import ctypes
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    except Exception:
        return [f"{chr(code)}:\\" for code in range(ord("C"), ord("Z") + 1)]

    return [f"{chr(ord('A') + index)}:\\" for index in range(26) if bitmask & (1 << index)]

def _cryptomator_drive_roots():
    global _CRYPTOMATOR_DRIVE_ROOTS

    if _CRYPTOMATOR_DRIVE_ROOTS is not None:
        return _CRYPTOMATOR_DRIVE_ROOTS

    roots = []

    for drive_root in _available_windows_drive_roots():
        try:
            resolved_root = Path(drive_root).resolve()
        except (OSError, RuntimeError):
            continue

        resolved_text = _windows_path_text(resolved_root).rstrip("\\")
        lower_resolved = resolved_text.lower()

        if lower_resolved.startswith(CRYPTOMATOR_UNC_PREFIX.lower()):
            roots.append((resolved_text, drive_root))

    roots.sort(key=lambda item: len(item[0]), reverse=True)
    _CRYPTOMATOR_DRIVE_ROOTS = roots

    return roots

def _split_cryptomator_unc_path(path_text):
    normalized_path = _windows_path_text(path_text)
    lower_path = normalized_path.lower()
    lower_prefix = CRYPTOMATOR_UNC_PREFIX.lower()

    if not lower_path.startswith(lower_prefix):
        return None

    rest = normalized_path[len(CRYPTOMATOR_UNC_PREFIX) :]
    parts = rest.split("\\", 2)

    if len(parts) != 3:
        return None

    vault_id, vault_name, relative_path = parts

    if not vault_id or not vault_name or not relative_path:
        return None

    vault_root = CRYPTOMATOR_UNC_PREFIX + vault_id + "\\" + vault_name

    return (vault_root, relative_path)

def _same_existing_file(candidate_path, source_path):
    try:
        if not candidate_path.is_file():
            return False
    except (OSError, PermissionError):
        return False

    try:
        return candidate_path.stat().st_size == source_path.stat().st_size
    except (OSError, PermissionError):
        return True

def _resolve_cryptomator_by_existing_file(path_text):
    split_path = _split_cryptomator_unc_path(path_text)

    if split_path is None:
        return path_text

    vault_root, relative_path = split_path
    cache_key = vault_root.lower()
    if cache_key in _CRYPTOMATOR_ROOT_CACHE:
        cached_drive_root = _CRYPTOMATOR_ROOT_CACHE[cache_key]

        if cached_drive_root:
            return cached_drive_root + relative_path

        return path_text

    source_path = Path(path_text)

    for drive_root in _available_windows_drive_roots():
        candidate_text = drive_root + relative_path
        candidate_path = Path(candidate_text)

        if _same_existing_file(candidate_path, source_path):
            _CRYPTOMATOR_ROOT_CACHE[cache_key] = drive_root
            return candidate_text

    _CRYPTOMATOR_ROOT_CACHE[cache_key] = None

    return path_text

def playlist_path_text(path):
    path_text = _windows_path_text(path)
    lower_path = path_text.lower()

    for resolved_root, drive_root in _cryptomator_drive_roots():
        lower_root = resolved_root.lower()

        if lower_path == lower_root:
            return drive_root.rstrip("\\")

        if lower_path.startswith(lower_root + "\\"):
            suffix = path_text[len(resolved_root) :].lstrip("\\")
            return drive_root + suffix

    return _resolve_cryptomator_by_existing_file(path_text)

def _find_media_tool(name):
    executable = shutil.which(name)

    if not executable:
        return None

    try:
        result = subprocess.run(
            [executable, "-version"], capture_output=True, timeout=5, check=False
        )
        return executable if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None

FFPROBE_PATH = _find_media_tool("ffprobe")
FFMPEG_PATH = _find_media_tool("ffmpeg")
HAS_FFPROBE = FFPROBE_PATH is not None
HAS_FFMPEG = FFMPEG_PATH is not None

def _enable_ansi():
    if sys.platform != "win32":
        return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        std_output_handle = -11
        enable_virtual_terminal_processing = 0x0004
        handle = kernel32.GetStdHandle(std_output_handle)
        mode = ctypes.c_ulong()

        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | enable_virtual_terminal_processing)
            return True
    except Exception:
        pass

    return False

_ANSI = _enable_ansi()

if _ANSI:
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"
    CYAN = "\033[36m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    WHITE = "\033[37m"
    GREY = "\033[90m"
    MAGENTA = "\033[95m"
else:
    DIM = ""
    BOLD = ""
    RESET = ""
    CYAN = ""
    GREEN = ""
    YELLOW = ""
    RED = ""
    WHITE = ""
    GREY = ""
    MAGENTA = ""

BOX_TL = "\u256d"
BOX_TR = "\u256e"
BOX_BL = "\u2570"
BOX_BR = "\u256f"
PIPE = "\u2502"
DASH = "\u2500"

SPINNER = ["\u2838", "\u2834", "\u2826", "\u2807", "\u280b", "\u2819", "\u2830", "\u2838"]

_ANSI_RE = re.compile(r"\033\[[0-9;]*m")

def _visible_len(value):
    return len(_ANSI_RE.sub("", value))

def _con_box(lines, colour=CYAN):
    if not lines:
        return

    inner_width = max(_visible_len(line) for line in lines) + 2
    bar = DASH * inner_width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")

    for line in lines:
        padding = inner_width - _visible_len(line) - 1
        print(f"  {colour}{PIPE}{RESET} " f"{line}{' ' * padding}" f"{colour}{PIPE}{RESET}")

    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")

def _con_ok(message):
    print(f"  {GREEN}{PIPE}{RESET} {message}")

def _con_warn(message):
    print(f"  {RED}{PIPE}{RESET} {message}")

def _con_info(message):
    print(f"  {CYAN}{PIPE}{RESET} {message}")

def clear():
    if os.name == "nt":
        os.system("cls")
    elif os.environ.get("TERM"):
        os.system("clear")

def _progress(label, current, total):
    frame = SPINNER[current % len(SPINNER)]
    sys.stdout.write(
        f"\r  {CYAN}{frame}{RESET}  "
        f"{DIM}{label}{RESET} "
        f"{BOLD}{current}{RESET}"
        f"{DIM}/{total}{RESET}    "
    )
    sys.stdout.flush()

def _progress_done(label, total):
    sys.stdout.write(
        f"\r  {GREEN}{PIPE}{RESET} "
        f"{DIM}{label}{RESET} "
        f"{BOLD}{total}{RESET}                    \n"
    )
    sys.stdout.flush()

def _progress_open(label, current):
    frame = SPINNER[current % len(SPINNER)]
    sys.stdout.write(
        f"\r  {CYAN}{frame}{RESET}  "
        f"{DIM}{label}{RESET} "
        f"{BOLD}{current}{RESET}                    "
    )
    sys.stdout.flush()

def _countdown(seconds=COUNTDOWN_SECS):
    if sys.platform != "win32":
        input(f"\n  {DIM}Press Enter to close.{RESET}")
        return

    import msvcrt

    for remaining in range(seconds, 0, -1):
        sys.stdout.write(
            f"\r  {CYAN}{PIPE}{RESET} "
            f"{DIM}Closing in {RESET}"
            f"{BOLD}{MAGENTA}{remaining}{RESET}"
            f"{DIM}..{RESET}  "
            f"{DIM}(press any key){RESET}  "
        )
        sys.stdout.flush()
        deadline = time.monotonic() + 1.0

        while time.monotonic() < deadline:
            if msvcrt.kbhit():
                msvcrt.getwch()
                sys.stdout.write("\r" + " " * 60 + "\r")
                sys.stdout.flush()
                return

            time.sleep(0.05)

    sys.stdout.write("\r" + " " * 60 + "\r")
    sys.stdout.flush()

def _con_prompt(valid):
    if sys.platform != "win32":
        sys.stdout.write(f"  {YELLOW}{PIPE}{RESET} Choice: ")
        sys.stdout.flush()

        while True:
            choice = input("").strip().lower()

            if choice in valid:
                return choice

            options = ", ".join(sorted(valid))
            sys.stdout.write(f"  {RED}{PIPE}{RESET} " f"{DIM}Invalid. Choose: {options}{RESET}\n")
            sys.stdout.write(f"  {YELLOW}{PIPE}{RESET} Choice: ")
            sys.stdout.flush()

    import msvcrt
    sys.stdout.write(f"  {YELLOW}{PIPE}{RESET} Choice: ")
    sys.stdout.flush()

    while True:
        choice = msvcrt.getwch().lower()

        if choice in valid:
            sys.stdout.write(f"{BOLD}{choice}{RESET}\n")
            sys.stdout.flush()
            return choice

def _format_age(seconds):
    if seconds < 60:
        return f"{int(seconds)}s ago"

    if seconds < 3600:
        return f"{int(seconds / 60)}m ago"

    if seconds < 86400:
        return f"{int(seconds / 3600)}h ago"

    if seconds < 604800:
        return f"{int(seconds / 86400)}d ago"

    return f"{int(seconds / 604800)}w ago"

def _previous_run_age():
    timestamps = []

    for name in OUTPUT_NAMES.values():
        path = TARGET_DIR / name

        if path.exists():
            try:
                timestamps.append(path.stat().st_mtime)
            except OSError:
                pass

    if not timestamps:
        return None

    return time.time() - max(timestamps)

def _header_lines(include_previous=True):
    lines = [f"{BOLD}{WHITE}{TARGET_DIR}{RESET}"]
    extras = []

    if include_previous:
        age = _previous_run_age()

        if age is not None:
            extras.append(f"{DIM}Previous run{RESET}  " f"{_format_age(age)}")

    if not HAS_FFPROBE:
        extras.append(
            f"{RED}ffprobe not found{RESET}  "
            f"{DIM}duration and video quality use file size; "
            f"videos are not split{RESET}"
        )
    elif not HAS_FFMPEG:
        extras.append(
            f"{YELLOW}ffmpeg not found{RESET}  " f"{DIM}accurate orientation is unavailable{RESET}"
        )

    if extras:
        lines.append("")
        lines.extend(extras)

    return lines

def _render_summary(answered):
    if not answered:
        return

    key_width = max(len(key) for key in answered)

    for key, value in answered.items():
        print(
            f"  {GREY}{PIPE}{RESET} " f"{DIM}{key:<{key_width}}{RESET}   " f"{WHITE}{value}{RESET}"
        )

def render_screen(answered):
    clear()
    print()
    _con_box(_header_lines(), colour=CYAN)
    print()

    if answered:
        _render_summary(answered)
        print()

def _print_question(label, options):
    print(f"  {YELLOW}{PIPE}{RESET} " f"{BOLD}{WHITE}{label}{RESET}")
    print(f"  {YELLOW}{PIPE}{RESET}")

    for key, option_label in options.items():
        print(f"  {YELLOW}{PIPE}{RESET}   " f"{DIM}{key}{RESET}  " f"{option_label}")

    print(f"  {YELLOW}{PIPE}{RESET}")

_LAST_CACHE_SAVE = 0.0

def prune_cache(cache, entries):
    """Drop records for files that are gone. Deleting duplicates is the point."""
    live = {_cache_key(path) for path in entries}
    stale = [
        key
        for key in cache["files"]
        if key not in live and not (TARGET_DIR / key).exists()
    ]

    for key in stale:
        del cache["files"][key]

    if stale:
        cache["dirty"] = True

    return len(stale)

_CACHE_PAYLOADS = (
    ("probe_version", "probe"),
    ("orientation_version", "content_orientation"),
    ("signature_version", "signature"),
)

def _read_cache_file(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None

    if not isinstance(data, dict) or data.get("schema") != CACHE_SCHEMA_VERSION:
        return None

    files = data.get("files")

    return files if isinstance(files, dict) else None

def _adopt_record(cache, key, incoming, live):
    """Take a sub-folder record, or fill gaps in the one already held."""
    existing = cache["files"].get(key)

    if (
        isinstance(existing, dict)
        and existing.get("size") == live[0]
        and existing.get("modified_ns") == live[1]
    ):
        filled = False

        for version_key, payload_key in _CACHE_PAYLOADS:
            if payload_key in existing or payload_key not in incoming:
                continue

            existing[version_key] = incoming.get(version_key)
            existing[payload_key] = incoming[payload_key]
            filled = True

        return filled

    cache["files"][key] = incoming

    return True

def import_nested_caches(cache, cache_paths, entries):
    """Reuse probe, orientation and fingerprint work from sub-folder runs."""
    by_key = {}

    for path in entries:
        by_key.setdefault(_cache_key(path), path)

    imported = 0
    used = 0

    for cache_path in cache_paths:
        files = _read_cache_file(cache_path)

        if not files:
            continue

        try:
            prefix = cache_path.parent.relative_to(TARGET_DIR).as_posix()
        except ValueError:
            continue

        adopted = 0

        for key, record in files.items():
            if not isinstance(record, dict):
                continue

            merged_key = key if prefix == "." else f"{prefix}/{key}"
            path = by_key.get(merged_key)

            if path is None:
                continue

            live = _file_signature(path)

            if (
                live is None
                or record.get("size") != live[0]
                or record.get("modified_ns") != live[1]
            ):
                continue

            if _adopt_record(cache, merged_key, record, live):
                adopted += 1

        if adopted:
            used += 1
            imported += adopted

    if imported:
        cache["dirty"] = True

    return imported, used

def _new_cache():
    return {"schema": CACHE_SCHEMA_VERSION, "files": {}, "dirty": False}

def load_cache():
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return _new_cache()

    if not isinstance(data, dict):
        return _new_cache()

    if data.get("schema") != CACHE_SCHEMA_VERSION:
        return _new_cache()

    if not isinstance(data.get("files"), dict):
        return _new_cache()

    return {"schema": CACHE_SCHEMA_VERSION, "files": data["files"], "dirty": False}

def save_cache(cache, force=True):
    if not cache.get("dirty"):
        return

    global _LAST_CACHE_SAVE
    now = time.monotonic()

    if not force and now - _LAST_CACHE_SAVE < CACHE_SAVE_INTERVAL:
        return

    payload = {"schema": CACHE_SCHEMA_VERSION, "files": cache.get("files", {})}
    temporary_path = CACHE_FILE.with_suffix(CACHE_FILE.suffix + ".tmp")

    try:
        temporary_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        os.replace(temporary_path, CACHE_FILE)
        cache["dirty"] = False
        _LAST_CACHE_SAVE = now
    except OSError:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass

def _cache_key(path):
    try:
        relative = path.relative_to(TARGET_DIR)
    except ValueError:
        relative = path

    return relative.as_posix()

def _file_signature(path):
    try:
        stat = path.stat()
    except (OSError, PermissionError):
        return None

    return stat.st_size, stat.st_mtime_ns

def _matching_cache_record(cache, path):
    signature = _file_signature(path)

    if signature is None:
        return None

    size, modified_ns = signature
    record = cache["files"].get(_cache_key(path))

    if not isinstance(record, dict):
        return None

    if record.get("size") != size:
        return None

    if record.get("modified_ns") != modified_ns:
        return None

    return record

def _cache_record(cache, path):
    signature = _file_signature(path)

    if signature is None:
        return None

    size, modified_ns = signature
    key = _cache_key(path)
    record = cache["files"].get(key)

    if (
        not isinstance(record, dict)
        or record.get("size") != size
        or record.get("modified_ns") != modified_ns
    ):
        record = {"size": size, "modified_ns": modified_ns}
        cache["files"][key] = record
        cache["dirty"] = True

    return record

def load_cached_probes(entries, cache):
    results = {}

    for path in entries:
        record = _matching_cache_record(cache, path)

        if (
            record is not None
            and record.get("probe_version") == PROBE_CACHE_VERSION
            and "probe" in record
        ):
            cached_probe = record.get("probe")
            results[path] = dict(cached_probe) if isinstance(cached_probe, dict) else cached_probe

    return results

def _to_float(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None

def _positive_float(value):
    number = _to_float(value)

    if number is not None and number > 0:
        return number

    return None

def _positive_int(value):
    number = _positive_float(value)

    if number is not None:
        return int(number)

    return None

def _parse_ratio(value):
    if value is None:
        return None

    text = str(value).strip()

    if not text or text.upper() == "N/A":
        return None

    for separator in ("/", ":"):
        if separator not in text:
            continue

        numerator_text, denominator_text = text.split(separator, 1)
        numerator = _to_float(numerator_text)
        denominator = _to_float(denominator_text)

        if numerator is None or denominator in (None, 0):
            return None

        ratio = numerator / denominator

        if ratio > 0 and math.isfinite(ratio):
            return ratio

        return None

    return _positive_float(text)

def _stream_bitrate(stream):
    bitrate = _positive_int(stream.get("bit_rate"))

    if bitrate:
        return bitrate

    tags = stream.get("tags") or {}

    for key in ("BPS", "BPS-eng", "BPS_ENG", "bps"):
        bitrate = _positive_int(tags.get(key))

        if bitrate:
            return bitrate

    return None

def _select_video_stream(streams):
    candidates = []

    for stream in streams:
        if stream.get("codec_type") != "video":
            continue

        disposition = stream.get("disposition") or {}

        if disposition.get("attached_pic"):
            continue

        candidates.append(stream)

    if not candidates:
        return None

    for stream in candidates:
        disposition = stream.get("disposition") or {}

        if disposition.get("default"):
            return stream

    return candidates[0]

def _extract_rotation(video_stream, format_data):
    stream_tags = video_stream.get("tags") or {}
    format_tags = format_data.get("tags") or {}

    for raw_value in (stream_tags.get("rotate"), format_tags.get("rotate")):
        rotation = _to_float(raw_value)

        if rotation is not None:
            return rotation

    for side_data in video_stream.get("side_data_list") or []:
        rotation = _to_float(side_data.get("rotation"))

        if rotation is not None:
            return rotation

    return 0.0

def _normalise_rotation(rotation):
    return int(round(rotation / 90.0) * 90) % 360

def _bit_depth(video_stream):
    for key in ("bits_per_raw_sample", "bits_per_sample"):
        value = _positive_int(video_stream.get(key))

        if value:
            return value

    pixel_format = str(video_stream.get("pix_fmt") or "").lower()
    planar_match = re.search(r"p(9|10|12|14|16)(?:le|be)?$", pixel_format)

    if planar_match:
        return int(planar_match.group(1))

    semi_planar_match = re.fullmatch(r"p[024](10|12|14|16)(?:le|be)?", pixel_format)

    if semi_planar_match:
        return int(semi_planar_match.group(1))

    grayscale_match = re.fullmatch(r"gray(9|10|12|14|16)(?:le|be)?", pixel_format)

    if grayscale_match:
        return int(grayscale_match.group(1))

    if re.fullmatch(
        r"(?:v210|y210(?:le|be)?|r210|" r"x2rgb10(?:le|be)?|x2bgr10(?:le|be)?)", pixel_format
    ):
        return 10

    return 8

def _hdr_score(video_stream):
    transfer = str(video_stream.get("color_transfer") or "").lower()
    primaries = str(video_stream.get("color_primaries") or "").lower()
    colour_space = str(video_stream.get("color_space") or "").lower()

    if transfer in {"smpte2084", "arib-std-b67"}:
        return 2

    if primaries == "bt2020" or colour_space.startswith("bt2020"):
        return 1

    return 0

def _classify_ratio(ratio):
    ratio_value = _positive_float(ratio)

    if ratio_value is None:
        return None

    if ratio_value > 1.0:
        return "horizontal"

    if ratio_value < 1.0:
        return "vertical"

    return ORIENTATION_TIE_BREAK

def _median(values):
    if not values:
        return None

    ordered = sorted(values)
    midpoint = len(ordered) // 2

    if len(ordered) % 2:
        return ordered[midpoint]

    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0

def probe_file(path):
    result = {
        "orientation": None,
        "orientation_source": None,
        "duration": None,
        "bitrate": None,
        "bitrate_source": None,
        "width": None,
        "height": None,
        "display_ratio": None,
        "rotation": 0,
        "codec": None,
        "fps": None,
        "bit_depth": None,
        "hdr_score": 0,
        "stream_index": None,
        "active_area_fraction": None,
    }

    try:
        completed = subprocess.run(
            [
                FFPROBE_PATH,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

        if completed.returncode != 0 or not completed.stdout:
            return None

        data = json.loads(completed.stdout)
        format_data = data.get("format") or {}
        streams = data.get("streams") or []
        result["duration"] = _positive_float(format_data.get("duration"))
        format_bitrate = _positive_int(format_data.get("bit_rate"))
        video_stream = _select_video_stream(streams)

        if not video_stream:
            return result

        stream_duration = _positive_float(video_stream.get("duration"))

        if result["duration"] is None and stream_duration:
            result["duration"] = stream_duration

        stream_index = video_stream.get("index")

        try:
            result["stream_index"] = int(stream_index)
        except (TypeError, ValueError):
            pass

        codec = video_stream.get("codec_name")

        if codec:
            result["codec"] = str(codec).lower()

        raw_width = _positive_int(video_stream.get("width"))
        raw_height = _positive_int(video_stream.get("height"))

        if not raw_width or not raw_height:
            return result

        video_bitrate = _stream_bitrate(video_stream)

        if video_bitrate:
            result["bitrate"] = video_bitrate
            result["bitrate_source"] = "stream"
        else:
            total_bitrate = format_bitrate
            source = "format" if total_bitrate else None

            if not total_bitrate and result["duration"]:
                try:
                    total_bitrate = int(path.stat().st_size * 8 / result["duration"])
                    source = "estimated"
                except (OSError, ZeroDivisionError):
                    total_bitrate = None

            audio_bitrate = sum(
                bitrate
                for bitrate in (
                    _stream_bitrate(stream)
                    for stream in streams
                    if stream.get("codec_type") == "audio"
                )
                if bitrate
            )

            if total_bitrate:
                if audio_bitrate and total_bitrate > audio_bitrate:
                    total_bitrate -= audio_bitrate
                    source = "estimated"

                result["bitrate"] = total_bitrate
                result["bitrate_source"] = source or "estimated"

        frame_rate = _parse_ratio(video_stream.get("avg_frame_rate")) or _parse_ratio(
            video_stream.get("r_frame_rate")
        )

        if frame_rate and frame_rate <= 240:
            result["fps"] = frame_rate

        result["bit_depth"] = _bit_depth(video_stream)
        result["hdr_score"] = _hdr_score(video_stream)
        rotation = _normalise_rotation(_extract_rotation(video_stream, format_data))
        result["rotation"] = rotation
        sample_aspect_ratio = _parse_ratio(video_stream.get("sample_aspect_ratio")) or 1.0
        display_ratio = _parse_ratio(video_stream.get("display_aspect_ratio"))

        if display_ratio is None:
            display_ratio = raw_width * sample_aspect_ratio / raw_height

        if rotation in (90, 270):
            effective_width = raw_height
            effective_height = raw_width
            display_ratio = 1.0 / display_ratio
        else:
            effective_width = raw_width
            effective_height = raw_height

        result["width"] = effective_width
        result["height"] = effective_height
        result["display_ratio"] = display_ratio
        result["orientation"] = _classify_ratio(display_ratio)
        result["orientation_source"] = "metadata"

        return result

    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
        ZeroDivisionError,
    ):
        return None

def probe_all(entries, cache):
    if not entries:
        return {}

    results = {}
    pending = []
    cached_count = 0

    for path in entries:
        record = _matching_cache_record(cache, path)

        if (
            record is not None
            and record.get("probe_version") == PROBE_CACHE_VERSION
            and "probe" in record
        ):
            cached_probe = record.get("probe")
            results[path] = dict(cached_probe) if isinstance(cached_probe, dict) else cached_probe
            cached_count += 1
        else:
            pending.append(path)

    if cached_count:
        _con_ok(f"Metadata cache  " f"{BOLD}{cached_count}{RESET} files")

    if not pending:
        return results

    total = len(pending)
    workers = min(total, max((os.cpu_count() or 4) * 2, 8), 32)
    _con_info(f"Probing metadata  " f"{DIM}({total} files, " f"{workers} threads){RESET}")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {executor.submit(probe_file, path): path for path in pending}

        for index, future in enumerate(as_completed(future_map), 1):
            path = future_map[future]

            try:
                result = future.result()
            except Exception:
                result = None

            results[path] = result
            record = _cache_record(cache, path)

            if record is not None:
                record["probe_version"] = PROBE_CACHE_VERSION
                record["probe"] = dict(result) if isinstance(result, dict) else result
                record.pop("orientation_version", None)
                record.pop("content_orientation", None)
                record.pop("signature_version", None)
                record.pop("signature", None)
                cache["dirty"] = True

            if index % 25 == 0 or index == total:
                _progress("Probed", index, total)
                save_cache(cache, force=False)

    _progress_done("Probed", total)
    save_cache(cache)

    return results

def _orientation_sample_times(probe):
    duration = _positive_float(probe.get("duration"))

    if duration is None:
        return [0.5]

    if duration <= 0.08:
        return [max(0.0, duration * 0.5)]

    fps = _positive_float(probe.get("fps"))
    end_guard = max(0.04, 1.05 / fps) if fps else min(0.20, max(0.04, duration * 0.04))
    maximum = max(0.0, duration - end_guard)
    minimum = min(maximum, max(0.02, min(0.20, duration * 0.04)))
    samples = []

    for fraction in ORIENTATION_SAMPLE_FRACTIONS:
        timestamp = min(max(duration * fraction, minimum), maximum)

        if not any(abs(timestamp - existing) < 0.025 for existing in samples):
            samples.append(timestamp)

    if not samples:
        samples.append(min(max(duration * 0.5, 0.0), maximum))

    return samples

def _orientation_scale_filter():
    dimension = ORIENTATION_MAX_DIMENSION

    return (
        "scale="
        f"w='if(gte(dar,1),{dimension},"
        f"max(2,trunc({dimension}*dar/2)*2))':"
        f"h='if(gte(dar,1),"
        f"max(2,trunc({dimension}/dar/2)*2),"
        f"{dimension})':"
        "flags=area,"
        "setsar=1,"
        f"pad={dimension}:{dimension}:"
        "(ow-iw)/2:(oh-ih)/2:"
        "color=0x7F7F7F,"
        "format=gray,"
        "setpts=PTS-STARTPTS"
    )

def _decode_orientation_frames(path, probe):
    """Decode all samples in one bounded ffmpeg process. No retry cascade."""
    timestamps = _orientation_sample_times(probe)

    if not timestamps:
        return None

    stream_index = probe.get("stream_index")
    stream_specifier = str(stream_index) if stream_index is not None else "v:0"
    dimension = ORIENTATION_MAX_DIMENSION
    command = [FFMPEG_PATH, "-hide_banner", "-loglevel", "error", "-nostdin"]

    for timestamp in timestamps:
        command.extend(["-ss", f"{timestamp:.3f}", "-i", str(path)])

    filter_parts = []
    output_labels = []
    scale_filter = _orientation_scale_filter()

    for index in range(len(timestamps)):
        output_label = f"sample{index}"
        filter_parts.append(f"[{index}:{stream_specifier}]" f"{scale_filter}[{output_label}]")
        output_labels.append(f"[{output_label}]")

    if len(output_labels) == 1:
        filter_parts.append(f"{output_labels[0]}null[out]")
    else:
        filter_parts.append("".join(output_labels) + f"hstack=inputs={len(output_labels)}[out]")

    command.extend(
        [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[out]",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ]
    )

    try:
        completed = subprocess.run(
            command, capture_output=True, timeout=ORIENTATION_TIMEOUT, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None

    sample_count = len(timestamps)
    stack_width = dimension * sample_count
    expected_size = stack_width * dimension

    if completed.returncode != 0:
        return None

    if len(completed.stdout) < expected_size:
        return None

    raw_frame = completed.stdout[:expected_size]
    frames = []

    for sample_index in range(sample_count):
        left = sample_index * dimension
        rows = []

        for row_index in range(dimension):
            row_start = row_index * stack_width + left
            rows.append(raw_frame[row_start : row_start + dimension])

        frames.append(b"".join(rows))

    return timestamps, frames

def _expected_analysis_geometry(probe):
    dimension = ORIENTATION_MAX_DIMENSION
    ratio = _positive_float(probe.get("display_ratio"))

    if ratio is None:
        width = _positive_float(probe.get("width"))
        height = _positive_float(probe.get("height"))

        if not width or not height:
            return None

        ratio = width / height

    if ratio >= 1.0:
        content_width = dimension
        content_height = max(2, int(dimension / ratio / 2) * 2)
    else:
        content_height = dimension
        content_width = max(2, int(dimension * ratio / 2) * 2)

    return content_width, content_height

def _crop_plane(plane, left, top, right, bottom):
    dimension = ORIENTATION_MAX_DIMENSION

    return b"".join(
        plane[row * dimension + left : row * dimension + right] for row in range(top, bottom)
    )

def _region_is_uniform(values):
    if not values:
        return True

    return max(values) - min(values) <= ORIENTATION_PAD_SPREAD

def _pad_band_values(plane, left, top, right, bottom, step):
    dimension = ORIENTATION_MAX_DIMENSION

    return [
        plane[row * dimension + column]
        for row in range(top, bottom, step)
        for column in range(left, right, step)
    ]

def _strip_decode_padding(frame, expected):
    dimension = ORIENTATION_MAX_DIMENSION

    if expected is None:
        return None

    content_width, content_height = expected

    if content_width >= dimension and content_height >= dimension:
        return frame, dimension, dimension

    left = (dimension - content_width) // 2
    top = (dimension - content_height) // 2
    right = left + content_width
    bottom = top + content_height
    step = max(1, dimension // 64)
    margin = 1
    bands = []

    if top - margin > 0:
        bands.append((0, 0, dimension, top - margin))

    if dimension - (bottom + margin) > 0:
        bands.append((0, bottom + margin, dimension, dimension))

    if left - margin > 0:
        bands.append((0, top, left - margin, bottom))

    if dimension - (right + margin) > 0:
        bands.append((right + margin, top, dimension, bottom))

    observed = []

    for band_left, band_top, band_right, band_bottom in bands:
        values = _pad_band_values(frame, band_left, band_top, band_right, band_bottom, step)

        if not _region_is_uniform(values):
            return None

        observed.extend(values)

    if observed and not _region_is_uniform(observed):
        return None

    return (_crop_plane(frame, left, top, right, bottom), content_width, content_height)

def _extract_decoded_content(frame, expected):
    stripped = _strip_decode_padding(frame, expected)

    if stripped is not None:
        return (*stripped, False)

    if expected is not None:
        transposed = (expected[1], expected[0])

        if transposed != expected:
            stripped = _strip_decode_padding(frame, transposed)

            if stripped is not None:
                return (*stripped, True)

    return None

def _frame_is_usable(frame):
    if not frame:
        return False

    step = max(1, len(frame) // 4096)
    samples = sorted(frame[::step])

    if not samples:
        return False

    low = samples[int((len(samples) - 1) * 0.05)]
    high = samples[int((len(samples) - 1) * 0.95)]

    if high < 24:
        return False

    if high - low < 8:
        return False

    return True

def _is_dark_line(values):
    if not values:
        return False

    dark_count = sum(1 for value in values if value <= 42)
    average = sum(values) / len(values)

    return dark_count / len(values) >= 0.90 and average <= 36

def _dark_row_flags(frame, width, height):
    step = max(1, width // 160)

    return [
        _is_dark_line(frame[row_index * width : (row_index + 1) * width : step])
        for row_index in range(height)
    ]

def _dark_column_flags(frame, width, height):
    stride = width * max(1, height // 160)

    return [_is_dark_line(frame[column_index::stride]) for column_index in range(width)]

def _edge_extent(flags):
    if not flags:
        return 0

    initial = flags[: min(3, len(flags))]

    if sum(initial) < max(1, math.ceil(len(initial) * 0.67)):
        return 0

    extent = 0
    false_run = 0

    for index, matches in enumerate(flags):
        if matches:
            extent = index + 1
            false_run = 0
        else:
            false_run += 1

            if false_run >= 3:
                break

    return extent

def _validated_bar_pair(first, second, dimension, symmetry=0.35):
    minimum_side = max(2, int(dimension * 0.015))
    minimum_total = max(4, int(dimension * 0.06))

    if first < minimum_side or second < minimum_side:
        return 0, 0

    if first + second < minimum_total:
        return 0, 0

    if min(first, second) / max(first, second) < symmetry:
        return 0, 0

    if dimension - first - second < dimension * 0.15:
        return 0, 0

    return first, second

def _detect_dark_crop(frame, width, height):
    row_flags = _dark_row_flags(frame, width, height)
    column_flags = _dark_column_flags(frame, width, height)
    top = _edge_extent(row_flags)
    bottom = _edge_extent(list(reversed(row_flags)))
    left = _edge_extent(column_flags)
    right = _edge_extent(list(reversed(column_flags)))
    top, bottom = _validated_bar_pair(top, bottom, height)
    left, right = _validated_bar_pair(left, right, width)

    if not (top or bottom or left or right):
        return None

    active_width = width - left - right
    active_height = height - top - bottom

    if active_width <= 0 or active_height <= 0:
        return None

    return {
        "left": left,
        "top": top,
        "width": active_width,
        "height": active_height,
        "confidence": 0.99,
        "method": "dark",
    }

def _line_uniform_stats(values):
    if not values:
        return False, 0.0

    ordered = sorted(values)
    low = ordered[int((len(ordered) - 1) * 0.10)]
    high = ordered[int((len(ordered) - 1) * 0.90)]
    mean = sum(values) / len(values)
    return high - low <= 12, mean

def _uniform_row_data(frame, width, height):
    step = max(1, width // 160)
    flags = []
    means = []

    for row in range(height):
        values = frame[row * width : (row + 1) * width : step]
        flag, mean = _line_uniform_stats(values)
        flags.append(flag)
        means.append(mean)

    return flags, means

def _uniform_column_data(frame, width, height):
    stride = width * max(1, height // 160)
    flags = []
    means = []

    for column in range(width):
        values = frame[column::stride]
        flag, mean = _line_uniform_stats(values)
        flags.append(flag)
        means.append(mean)

    return flags, means

def _mean_or_none(values):
    return sum(values) / len(values) if values else None

def _uniform_pair_candidates(frame, width, height):
    candidates = []
    row_flags, row_means = _uniform_row_data(frame, width, height)
    col_flags, col_means = _uniform_column_data(frame, width, height)
    top = _edge_extent(row_flags)
    bottom = _edge_extent(list(reversed(row_flags)))
    top, bottom = _validated_bar_pair(top, bottom, height, symmetry=0.55)

    if top and bottom:
        first_mean = _mean_or_none(row_means[:top])
        second_mean = _mean_or_none(row_means[height - bottom :])

        if (
            first_mean is not None
            and second_mean is not None
            and abs(first_mean - second_mean) <= 18
        ):
            candidates.append(
                {
                    "left": 0,
                    "top": top,
                    "width": width,
                    "height": height - top - bottom,
                    "confidence": 0.965,
                    "method": "uniform",
                }
            )

    left = _edge_extent(col_flags)
    right = _edge_extent(list(reversed(col_flags)))
    left, right = _validated_bar_pair(left, right, width, symmetry=0.55)

    if left and right:
        first_mean = _mean_or_none(col_means[:left])
        second_mean = _mean_or_none(col_means[width - right :])

        if (
            first_mean is not None
            and second_mean is not None
            and abs(first_mean - second_mean) <= 18
        ):
            candidates.append(
                {
                    "left": left,
                    "top": 0,
                    "width": width - left - right,
                    "height": height,
                    "confidence": 0.965,
                    "method": "uniform",
                }
            )

    return candidates

def _mean_absolute_difference(first, second):
    return sum(map(abs, map(operator.sub, first, second))) / len(first)

def _axis_boundary_profile(frame, width, height, canvas_orientation):
    if canvas_orientation == "horizontal":
        stride = width * max(1, height // 120)
        return [
            _mean_absolute_difference(frame[column::stride], frame[column - 1 :: stride])
            for column in range(1, width)
        ]

    step = max(1, width // 120)
    return [
        _mean_absolute_difference(
            frame[row * width : (row + 1) * width : step],
            frame[(row - 1) * width : row * width : step],
        )
        for row in range(1, height)
    ]

def _prefix_sums(values):
    result = [0.0]
    total = 0.0

    for value in values:
        total += value
        result.append(total)

    return result

def _range_mean(prefix, start, end):
    if end <= start:
        return 0.0

    return (prefix[end] - prefix[start]) / (end - start)

def _detect_embedded_boundary(frame, width, height, canvas_orientation):
    """Detect a hard full-span embedded-frame boundary on a soft background.

    This is deliberately stricter than a generic "centre is more detailed"
    detector: both opposing boundaries must be strong across the whole axis,
    which avoids treating an ordinary centred subject as a nested video.
    """
    profile = _axis_boundary_profile(frame, width, height, canvas_orientation)

    if len(profile) < 16:
        return None

    ordered = sorted(profile)
    median_value = ordered[len(ordered) // 2]
    p80 = ordered[int((len(ordered) - 1) * 0.80)]
    prefix = _prefix_sums(profile)

    if canvas_orientation == "horizontal":
        dimension = width
        cross_dimension = height
    else:
        dimension = height
        cross_dimension = width

    maximum_active = min(int(cross_dimension / ORIENTATION_CONTENT_RATIO), int(dimension * 0.68))
    minimum_active = max(12, int(dimension * 0.20))

    if maximum_active < minimum_active:
        return None

    best = None

    for active_size in range(minimum_active, maximum_active + 1):
        for offset_fraction in (-0.10, -0.06, -0.03, 0.0, 0.03, 0.06, 0.10):
            start = (dimension - active_size) // 2
            start += int(round(offset_fraction * dimension))
            end = start + active_size
            margin = max(4, int(dimension * 0.04))

            if start < margin or dimension - end < margin:
                continue

            first_boundary = profile[start - 1]
            second_boundary = profile[end - 1]
            minimum_boundary = min(first_boundary, second_boundary)
            maximum_boundary = max(first_boundary, second_boundary)
            threshold = max(8.0, p80 * 1.70, median_value * 2.40)

            if minimum_boundary < threshold:
                continue

            if minimum_boundary / max(maximum_boundary, 0.001) < 0.55:
                continue

            first_background = _range_mean(prefix, 0, max(1, start - 1))
            active_detail = _range_mean(
                prefix,
                min(len(profile), start + 1),
                max(min(len(profile), start + 2), min(len(profile), end - 1)),
            )
            second_background = _range_mean(prefix, min(len(profile), end + 1), len(profile))
            background_detail = (first_background + second_background) / 2.0
            detail_ratio = (active_detail + 1.0) / (background_detail + 1.0)
            background_balance = (min(first_background, second_background) + 1.0) / (
                max(first_background, second_background) + 1.0
            )

            if detail_ratio < 1.20:
                continue

            if background_balance < 0.42:
                continue

            boundary_ratio = minimum_boundary / max(p80, 1.0)
            confidence = min(
                0.995,
                0.90
                + min(0.055, max(0.0, boundary_ratio - 1.70) * 0.035)
                + min(0.040, max(0.0, detail_ratio - 1.20) * 0.050),
            )

            if confidence < 0.94:
                continue

            candidate = (confidence, start, end)

            if best is None or candidate[0] > best[0]:
                best = candidate

    if best is None:
        return None

    confidence, start, end = best

    if canvas_orientation == "horizontal":
        return {
            "left": start,
            "top": 0,
            "width": end - start,
            "height": height,
            "confidence": confidence,
            "method": "boundary",
        }

    return {
        "left": 0,
        "top": start,
        "width": width,
        "height": end - start,
        "confidence": confidence,
        "method": "boundary",
    }

def _opposite_crop_orientation(crop, canvas_orientation):
    ratio = crop["width"] / crop["height"]

    if canvas_orientation == "horizontal" and ratio <= 1.0 / ORIENTATION_CONTENT_RATIO:
        return "vertical"

    if canvas_orientation == "vertical" and ratio >= ORIENTATION_CONTENT_RATIO:
        return "horizontal"

    return None

def _normalised_crop_geometry(crop, width, height, canvas_orientation):
    if canvas_orientation == "horizontal":
        centre = (crop["left"] + crop["width"] / 2.0) / width
        size = crop["width"] / width
    else:
        centre = (crop["top"] + crop["height"] / 2.0) / height
        size = crop["height"] / height

    return centre, size

def _analyse_orientation_frame(frame, expected):
    extracted = _extract_decoded_content(frame, expected)

    if extracted is None:
        return None

    frame, width, height, geometry_transposed = extracted

    if not _frame_is_usable(frame):
        return None

    canvas_orientation = _classify_ratio(width / height)
    candidate = None
    active_crop = None
    dark_crop = _detect_dark_crop(frame, width, height)

    if dark_crop is not None:
        active_crop = dark_crop
        candidate_orientation = _opposite_crop_orientation(dark_crop, canvas_orientation)

        if candidate_orientation:
            candidate = dict(dark_crop)
            candidate["orientation"] = candidate_orientation

    if candidate is None:
        for uniform_crop in _uniform_pair_candidates(frame, width, height):
            candidate_orientation = _opposite_crop_orientation(uniform_crop, canvas_orientation)

            if candidate_orientation:
                candidate = dict(uniform_crop)
                candidate["orientation"] = candidate_orientation
                active_crop = uniform_crop
                break

    if candidate is None:
        boundary_crop = _detect_embedded_boundary(frame, width, height, canvas_orientation)

        if boundary_crop is not None:
            candidate_orientation = _opposite_crop_orientation(boundary_crop, canvas_orientation)

            if candidate_orientation:
                candidate = dict(boundary_crop)
                candidate["orientation"] = candidate_orientation
                active_crop = boundary_crop

    active_area_fraction = (
        active_crop["width"] * active_crop["height"] / (width * height)
        if active_crop is not None
        else 1.0
    )
    result = {
        "canvas_orientation": canvas_orientation,
        "canvas_ratio": width / height,
        "geometry_transposed": geometry_transposed,
        "active_area_fraction": active_area_fraction,
        "candidate": None,
    }

    if candidate is not None:
        centre, size = _normalised_crop_geometry(candidate, width, height, canvas_orientation)
        result["candidate"] = {
            "orientation": candidate["orientation"],
            "confidence": candidate["confidence"],
            "method": candidate["method"],
            "centre": centre,
            "size": size,
        }

    return result

def _median_absolute_deviation(values):
    median_value = _median(values)

    if median_value is None:
        return None

    return _median([abs(value - median_value) for value in values])

def _candidate_stability(candidates):
    if not candidates:
        return 0.0

    centres = [candidate["centre"] for candidate in candidates]
    sizes = [candidate["size"] for candidate in candidates]
    centre_mad = _median_absolute_deviation(centres) or 0.0
    size_mad = _median_absolute_deviation(sizes) or 0.0

    return max(0.0, min(1.0, 1.0 - 0.5 * centre_mad / 0.07 - 0.5 * size_mad / 0.09))

def _fallback_content_analysis(probe, status):
    orientation = probe.get("orientation")

    if orientation not in {"horizontal", "vertical"}:
        orientation = _classify_ratio(probe.get("display_ratio"))

    return {
        "orientation": orientation,
        "decision_source": "metadata",
        "active_area_fraction": None,
        "sample_count": 0,
        "usable_samples": 0,
        "candidate_votes": 0,
        "candidate_methods": {},
        "status": status,
    }

_BIT_COUNT = getattr(int, "bit_count", None)

def _popcount(value):
    if _BIT_COUNT is not None:
        return value.bit_count()

    return bin(value).count("1")

def _sample_positions(start, stop, count):
    span = stop - start

    if span <= count:
        return list(range(start, stop))

    return [start + (index * span) // count for index in range(count)]

def _grid_means(plane, width, height, cells, samples=8):
    if width <= 0 or height <= 0:
        return None

    if len(plane) < width * height:
        return None

    row_bands = [
        _sample_positions(
            index * height // cells,
            max(index * height // cells + 1, (index + 1) * height // cells),
            samples,
        )
        for index in range(cells)
    ]
    column_bands = [
        _sample_positions(
            index * width // cells,
            max(index * width // cells + 1, (index + 1) * width // cells),
            samples,
        )
        for index in range(cells)
    ]
    means = []

    for rows in row_bands:
        offsets = [row * width for row in rows]

        for columns in column_bands:
            total = 0

            for offset in offsets:
                for column in columns:
                    total += plane[offset + column]

            means.append(total / (len(offsets) * len(columns)))

    return means

def _frame_hash_pair(plane, width, height):
    """Two 64-bit gradient hashes from one 9x9 mean grid."""
    cells = DUPLICATE_HASH_SIZE + 1
    means = _grid_means(plane, width, height, cells)

    if means is None:
        return None

    if max(means) - min(means) < DUPLICATE_MIN_SPREAD:
        return None

    horizontal = 0
    vertical = 0
    bit = 0

    for row in range(DUPLICATE_HASH_SIZE):
        base = row * cells

        for column in range(DUPLICATE_HASH_SIZE):
            if means[base + column + 1] > means[base + column]:
                horizontal |= 1 << bit

            bit += 1

    bit = 0

    for column in range(DUPLICATE_HASH_SIZE):
        for row in range(DUPLICATE_HASH_SIZE):
            if means[(row + 1) * cells + column] > means[row * cells + column]:
                vertical |= 1 << bit

            bit += 1

    return horizontal, vertical

def _signature_from_frames(frames, probe):
    """Positional hashes for fraction-sampled frames. None marks a skip."""
    expected = _expected_analysis_geometry(probe)
    encoded = []
    usable = 0

    for frame in frames:
        extracted = _extract_decoded_content(frame, expected)

        if extracted is None:
            encoded.append(None)
            continue

        plane, width, height = extracted[0], extracted[1], extracted[2]

        if not _frame_is_usable(plane):
            encoded.append(None)
            continue

        pair = _frame_hash_pair(plane, width, height)

        if pair is None:
            encoded.append(None)
            continue

        encoded.append(f"{pair[0]:016x}{pair[1]:016x}")
        usable += 1

    if not usable:
        return None

    return {"frames": encoded, "usable": usable}

def compute_signature(path, probe):
    decoded = _decode_orientation_frames(path, probe)

    if decoded is None:
        return None

    return _signature_from_frames(decoded[1], probe)

def _decode_signature(signature):
    frames = (signature or {}).get("frames")

    if not isinstance(frames, list):
        return None

    decoded = []

    for item in frames:
        if not isinstance(item, str) or len(item) != 32:
            decoded.append(None)
            continue

        try:
            decoded.append((int(item[:16], 16), int(item[16:], 16)))
        except ValueError:
            decoded.append(None)

    if not any(item is not None for item in decoded):
        return None

    return decoded

def _hash_distance(first, second):
    return _popcount(first[0] ^ second[0]) + _popcount(first[1] ^ second[1])

def _compare_signatures(first, second):
    """Frame-aligned comparison. Returns (median distance, votes, compared)."""
    distances = [
        _hash_distance(left, right)
        for left, right in zip(first, second)
        if left is not None and right is not None
    ]

    if not distances:
        return None

    votes = sum(1 for distance in distances if distance <= DUPLICATE_SIMILAR_DISTANCE)
    needed = max(
        min(DUPLICATE_MIN_FRAME_VOTES, len(distances)),
        math.ceil(len(distances) * DUPLICATE_VOTE_FRACTION),
    )

    if votes < needed:
        return None

    median = _median(distances)

    if median is None or median > DUPLICATE_SIMILAR_DISTANCE:
        return None

    return median, votes, len(distances)

def analyse_content_orientation(path, probe):
    decoded = _decode_orientation_frames(path, probe)

    if decoded is None:
        return _fallback_content_analysis(probe, "failed")

    timestamps, frames = decoded
    expected = _expected_analysis_geometry(probe)
    frame_results = []

    for frame in frames:
        result = _analyse_orientation_frame(frame, expected)

        if result is not None:
            frame_results.append(result)

    if not frame_results:
        return _fallback_content_analysis(probe, "unusable")

    metadata_orientation = probe.get("orientation")

    if metadata_orientation not in {"horizontal", "vertical"}:
        metadata_orientation = _classify_ratio(probe.get("display_ratio"))

    usable_samples = len(frame_results)
    base_orientation = metadata_orientation
    base_source = "metadata"
    canvas_orientations = [result["canvas_orientation"] for result in frame_results]
    horizontal_canvas = canvas_orientations.count("horizontal")
    vertical_canvas = canvas_orientations.count("vertical")
    decoded_canvas = (
        "horizontal"
        if horizontal_canvas > vertical_canvas
        else "vertical" if vertical_canvas > horizontal_canvas else metadata_orientation
    )
    transposed_votes = sum(1 for result in frame_results if result.get("geometry_transposed"))
    display_ratio = _positive_float(probe.get("display_ratio"))
    decoded_ratio = _median([result["canvas_ratio"] for result in frame_results])

    # A decoded-canvas correction is allowed only when the square-pad geometry
    # itself validates as transposed on nearly every usable sample and the
    # decoded ratio is the reciprocal of the probed display ratio. This is a
    # narrow rotation/autorotation correction, not a content vote.
    if (
        usable_samples >= 3
        and decoded_canvas in {"horizontal", "vertical"}
        and decoded_canvas != metadata_orientation
        and transposed_votes >= math.ceil(usable_samples * 0.80)
        and display_ratio
        and decoded_ratio
        and abs(math.log(decoded_ratio * display_ratio)) <= math.log(1.08)
    ):
        base_orientation = decoded_canvas
        base_source = "decoded_canvas"

    candidates = [
        result["candidate"]
        for result in frame_results
        if result.get("candidate") and result["candidate"].get("orientation") != base_orientation
    ]
    candidate_orientations = [candidate["orientation"] for candidate in candidates]
    horizontal_candidates = candidate_orientations.count("horizontal")
    vertical_candidates = candidate_orientations.count("vertical")
    dominant_candidate_orientation = (
        "horizontal"
        if horizontal_candidates > vertical_candidates
        else "vertical" if vertical_candidates > horizontal_candidates else None
    )
    supporting = [
        candidate
        for candidate in candidates
        if candidate["orientation"] == dominant_candidate_orientation
    ]
    method_counts = {}

    for candidate in supporting:
        method = candidate["method"]
        method_counts[method] = method_counts.get(method, 0) + 1

    candidate_votes = len(supporting)
    support_fraction = candidate_votes / usable_samples
    stability = _candidate_stability(supporting)
    median_confidence = _median([candidate["confidence"] for candidate in supporting]) or 0.0
    strong_bar_votes = method_counts.get("dark", 0) + method_counts.get("uniform", 0)
    boundary_votes = method_counts.get("boundary", 0)
    content_override = False

    if dominant_candidate_orientation:
        if usable_samples <= 2:
            bar_votes_needed = usable_samples
        elif usable_samples == 3:
            bar_votes_needed = 2
        else:
            bar_votes_needed = 3

        if strong_bar_votes >= bar_votes_needed:
            content_override = (
                support_fraction >= 0.58 and median_confidence >= 0.95 and stability >= 0.55
            )
        elif boundary_votes >= max(3, math.ceil(usable_samples * 0.75)):
            content_override = (
                support_fraction >= 0.75 and median_confidence >= 0.94 and stability >= 0.75
            )

    if content_override:
        orientation = dominant_candidate_orientation
        dominant_method = max(method_counts, key=method_counts.get)
        decision_source = f"content_{dominant_method}"
    else:
        orientation = base_orientation
        decision_source = base_source

    active_area_fraction = _median([result["active_area_fraction"] for result in frame_results])

    return {
        "orientation": orientation,
        "decision_source": decision_source,
        "active_area_fraction": active_area_fraction,
        "sample_count": len(timestamps),
        "usable_samples": usable_samples,
        "candidate_votes": candidate_votes,
        "candidate_methods": method_counts,
        "candidate_stability": stability,
        "status": "ok",
        "signature": _signature_from_frames(frames, probe),
    }

def _apply_content_analysis(probe, analysis, apply_orientation):
    if not probe or not analysis:
        return

    active_area_fraction = _positive_float(analysis.get("active_area_fraction"))

    if active_area_fraction is not None:
        probe["active_area_fraction"] = min(max(active_area_fraction, 0.05), 1.0)

    if not apply_orientation:
        return

    orientation = analysis.get("orientation")

    if orientation not in {"horizontal", "vertical"}:
        return

    probe["orientation"] = orientation
    probe["orientation_source"] = analysis.get("decision_source") or "metadata"
    probe["orientation_samples"] = int(analysis.get("sample_count") or 0)
    probe["usable_orientation_samples"] = int(analysis.get("usable_samples") or 0)
    probe["orientation_candidate_votes"] = int(analysis.get("candidate_votes") or 0)
    probe["orientation_candidate_methods"] = analysis.get("candidate_methods") or {}

def apply_cached_content_metrics(entries, probe_cache, cache):
    if not probe_cache:
        return

    for path in entries:
        probe = probe_cache.get(path)

        if not probe:
            continue

        record = _matching_cache_record(cache, path)

        if (
            record is None
            or record.get("orientation_version") != ORIENTATION_CACHE_VERSION
            or "content_orientation" not in record
        ):
            continue

        _apply_content_analysis(probe, record.get("content_orientation"), apply_orientation=False)

def analyse_all_orientations(entries, probe_cache, cache):
    pending = []
    cached_count = 0

    for path in entries:
        probe = (probe_cache or {}).get(path)

        if not probe or not probe.get("width") or not probe.get("height"):
            continue

        record = _matching_cache_record(cache, path)

        if (
            record is not None
            and record.get("orientation_version") == ORIENTATION_CACHE_VERSION
            and "content_orientation" in record
        ):
            analysis = record.get("content_orientation")
            _apply_content_analysis(probe, analysis, apply_orientation=True)
            cached_count += 1
        else:
            pending.append(path)

    if cached_count:
        _con_ok(f"Orientation cache  " f"{BOLD}{cached_count}{RESET} files")

    if not pending:
        return probe_cache

    total = len(pending)
    workers = min(total, max(1, min(ORIENTATION_MAX_WORKERS, os.cpu_count() or 1)))
    _con_info(
        f"Analysing content  "
        f"{DIM}({total} changed files, "
        f"{workers} workers, "
        f"{len(ORIENTATION_SAMPLE_FRACTIONS)} interior samples each, "
        f"one bounded pass per file){RESET}"
    )
    completed_since_save = 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(analyse_content_orientation, path, probe_cache[path]): path
            for path in pending
        }

        for index, future in enumerate(as_completed(future_map), 1):
            path = future_map[future]

            try:
                analysis = future.result()
            except Exception:
                analysis = _fallback_content_analysis(probe_cache.get(path) or {}, "failed")

            _apply_content_analysis(probe_cache.get(path), analysis, apply_orientation=True)
            signature = analysis.pop("signature", None)
            record = _cache_record(cache, path)

            if record is not None:
                record["orientation_version"] = ORIENTATION_CACHE_VERSION
                record["content_orientation"] = analysis

                if signature or analysis.get("status") == "ok":
                    record["signature_version"] = SIGNATURE_CACHE_VERSION
                    record["signature"] = signature or {"frames": [], "usable": 0}

                cache["dirty"] = True
                completed_since_save += 1

            _progress("Analysed", index, total)

            if completed_since_save >= 10:
                save_cache(cache, force=False)
                completed_since_save = 0

    _progress_done("Analysed", total)
    save_cache(cache)

    return probe_cache

_NAME_NOISE = re.compile(r"[^a-z0-9]+")

def _normalised_stem(path):
    return _NAME_NOISE.sub("", path.stem.casefold())

def _name_similarity(first, second):
    if not first or not second:
        return 0.0

    return difflib.SequenceMatcher(None, first, second).ratio()

def _duplicate_records(entries, probe_cache):
    records = []

    for path in entries:
        probe = (probe_cache or {}).get(path)

        if not probe:
            continue

        duration = _positive_float(probe.get("duration"))

        if duration is None:
            continue

        records.append(
            {
                "path": path,
                "duration": duration,
                "size": _file_size(path),
                "stem": _normalised_stem(path),
            }
        )

    return records

def _duplicate_candidate_pairs(records):
    """Duration-ordered sliding window. Bounded per file and overall."""
    ordered = sorted(records, key=lambda record: record["duration"])
    total = len(ordered)
    pairs = []
    truncated = False

    for index in range(total):
        record = ordered[index]
        tolerance = max(DUPLICATE_DURATION_FLOOR, record["duration"] * DUPLICATE_DURATION_RATIO)
        neighbours = 0

        for other_index in range(index + 1, total):
            other = ordered[other_index]

            if other["duration"] - record["duration"] > tolerance:
                break

            pairs.append((record, other))
            neighbours += 1

            if neighbours >= DUPLICATE_MAX_NEIGHBOURS:
                truncated = True
                break

        if len(pairs) >= DUPLICATE_MAX_PAIRS:
            truncated = True
            break

    return pairs, truncated

def _ensure_signatures(paths, probe_cache, cache):
    signatures = {}
    pending = []

    for path in paths:
        record = _matching_cache_record(cache, path)

        if (
            record is not None
            and record.get("signature_version") == SIGNATURE_CACHE_VERSION
            and "signature" in record
        ):
            decoded = _decode_signature(record.get("signature"))

            if decoded is not None:
                signatures[path] = decoded

            continue

        if HAS_FFMPEG:
            pending.append(path)

    if not pending:
        return signatures

    total = len(pending)
    workers = min(total, max(1, min(DUPLICATE_MAX_WORKERS, os.cpu_count() or 1)))
    _con_info(
        f"Fingerprinting  "
        f"{DIM}({total} candidates, {workers} workers, "
        f"one bounded pass per file){RESET}"
    )
    completed_since_save = 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(compute_signature, path, probe_cache[path]): path for path in pending
        }

        for index, future in enumerate(as_completed(future_map), 1):
            path = future_map[future]

            try:
                signature = future.result()
            except Exception:
                signature = None

            record = _cache_record(cache, path)

            if record is not None:
                record["signature_version"] = SIGNATURE_CACHE_VERSION
                record["signature"] = signature or {"frames": [], "usable": 0}
                cache["dirty"] = True
                completed_since_save += 1

            if signature:
                decoded = _decode_signature(signature)

                if decoded is not None:
                    signatures[path] = decoded

            _progress("Fingerprinted", index, total)

            if completed_since_save >= 10:
                save_cache(cache, force=False)
                completed_since_save = 0

    _progress_done("Fingerprinted", total)
    save_cache(cache)

    return signatures

def _duplicate_verdict(first, second, signatures):
    left = signatures.get(first["path"])
    right = signatures.get(second["path"])
    gap = abs(first["duration"] - second["duration"])

    if left is not None and right is not None:
        comparison = _compare_signatures(left, right)

        if comparison is None:
            return None

        if (
            comparison[0] <= DUPLICATE_IDENTICAL_DISTANCE
            and gap <= DUPLICATE_IDENTICAL_DURATION_GAP
        ):
            return "identical"

        return "similar"

    # No content fingerprint on one side: metadata alone must be decisive.
    if gap > DUPLICATE_METADATA_DURATION_GAP:
        return None

    if first["size"] and first["size"] == second["size"]:
        return "identical"

    if _name_similarity(first["stem"], second["stem"]) >= DUPLICATE_NAME_MATCH:
        return "similar"

    return None

def _union_root(parents, item):
    root = item

    while parents[root] != root:
        root = parents[root]

    while parents[item] != root:
        parents[item], item = root, parents[item]

    return root

def find_duplicate_groups(entries, probe_cache, cache):
    records = _duplicate_records(entries, probe_cache)

    if len(records) < 2:
        return []

    pairs, truncated = _duplicate_candidate_pairs(records)

    if not pairs:
        _con_ok(f"Duplicate scan  {BOLD}0{RESET} " f"{DIM}candidate pairs{RESET}")
        return []

    candidate_paths = []
    seen = set()

    for first, second in pairs:
        for record in (first, second):
            if record["path"] not in seen:
                seen.add(record["path"])
                candidate_paths.append(record["path"])

    _con_info(
        f"Duplicate scan  "
        f"{DIM}{len(pairs)} candidate pairs across "
        f"{len(candidate_paths)} files"
        f"{', window truncated' if truncated else ''}{RESET}"
    )
    signatures = _ensure_signatures(candidate_paths, probe_cache, cache)
    parents = {path: path for path in candidate_paths}
    verdicts = {}

    for first, second in pairs:
        verdict = _duplicate_verdict(first, second, signatures)

        if verdict is None:
            continue

        left = _union_root(parents, first["path"])
        right = _union_root(parents, second["path"])
        verdicts[(first["path"], second["path"])] = verdict

        if left != right:
            parents[left] = right

    if not verdicts:
        _con_ok(f"Duplicate scan  {BOLD}0{RESET} " f"{DIM}suspected duplicates{RESET}")
        return []

    members = {}

    for path in candidate_paths:
        root = _union_root(parents, path)
        members.setdefault(root, set()).add(path)

    labels = {}

    for (left, _), verdict in verdicts.items():
        root = _union_root(parents, left)
        labels.setdefault(root, set()).add(verdict)

    key_cache = {}

    def quality_key(path):
        if path not in key_cache:
            key_cache[path] = _quality_key(path, probe_cache)

        return key_cache[path]

    groups = []

    for root, paths in members.items():
        if len(paths) < 2 or root not in labels:
            continue

        ordered = sorted(paths, key=lambda path: str(path).casefold())
        ordered.sort(key=quality_key, reverse=True)
        groups.append(
            {
                "members": ordered,
                "label": ("identical" if labels[root] == {"identical"} else "similar"),
            }
        )

    groups.sort(
        key=lambda group: (
            0 if group["label"] == "identical" else 1,
            -len(group["members"]),
            str(group["members"][0]).casefold(),
        )
    )
    flagged = sum(len(group["members"]) for group in groups)
    identical = sum(1 for group in groups if group["label"] == "identical")
    _con_ok(
        f"{BOLD}{len(groups)}{RESET} duplicate groups, "
        f"{BOLD}{flagged}{RESET} files "
        f"{DIM}({identical} identical, "
        f"{len(groups) - identical} similar){RESET}"
    )

    return groups

def build_duplicate_playlist(groups):
    entries = []
    title_map = {}
    comment_map = {}

    for index, group in enumerate(groups, 1):
        members = group["members"]
        label = group["label"]
        total = len(members)

        for position, path in enumerate(members, 1):
            if position == 1:
                comment_map[path] = f"Group {index:03d}  {label}  " f"{total} entries"

            title_map[path] = (
                f"[G{index:03d} {position}/{total} {label}] " f"{_playlist_title(path)}"
            )
            entries.append(path)

    return entries, title_map, comment_map

def scan():
    _con_info("Scanning")
    results = []
    nested_caches = []

    for path in TARGET_DIR.rglob("*"):
        try:
            if not path.is_file():
                continue

            if path.suffix.lower() in VIDEO_EXTENSIONS:
                results.append(path)

                if len(results) % 25 == 0:
                    _progress_open("Found", len(results))
            elif path.name == CACHE_FILE.name and path != CACHE_FILE:
                nested_caches.append(path)
        except (OSError, PermissionError):
            continue

    _progress_done("Found", len(results))

    return results, nested_caches

def _playlist_duration(path, probe_cache):
    probe = (probe_cache or {}).get(path)
    duration = _positive_float(probe.get("duration")) if probe else None

    if duration is None:
        return -1

    return max(0, int(round(duration)))

def _playlist_title(path):
    return path.name.replace("\r", " ").replace("\n", " ")

def save_playlist(path, entries, probe_cache=None, title_map=None, comment_map=None):
    lines = ["#EXTM3U"]

    for entry in entries:
        comment = (comment_map or {}).get(entry)

        if comment:
            lines.append(f"# {comment}")

        duration = _playlist_duration(entry, probe_cache)
        title = (title_map or {}).get(entry) or _playlist_title(entry)
        lines.append(f"#EXTINF:{duration},{title}")
        lines.append(playlist_path_text(entry))

    content = "\n".join(lines) + "\n"

    try:
        path.write_text(content, encoding="utf-8")
        return True
    except (OSError, PermissionError) as error:
        _con_warn(f"Failed to save " f"{path.name}: {error}")
        return False

def delete_stale_outputs(keep_names):
    for name in OUTPUT_NAMES.values():
        if name in keep_names:
            continue

        path = TARGET_DIR / name

        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass

def _file_size(path):
    try:
        return path.stat().st_size
    except (OSError, PermissionError):
        return 0

def _resolution_tier(pixel_count):
    for minimum_pixels, tier in RESOLUTION_TIERS:
        if pixel_count >= minimum_pixels:
            return tier

    return 0

def _duration_key(path, probe_cache):
    file_size = _file_size(path)
    probe = (probe_cache or {}).get(path)
    duration = _positive_float(probe.get("duration")) if probe else None

    if duration is not None:
        return (1, duration, file_size)

    return (0, 0.0, file_size)

def _quality_key(path, probe_cache):
    file_size = _file_size(path)
    probe = (probe_cache or {}).get(path)

    if not probe:
        return (0, 0, 0, 0, 0, 0, 0.0, 0.0, 0, 0, file_size)

    width = _positive_int(probe.get("width"))
    height = _positive_int(probe.get("height"))

    if not width or not height:
        return (0, 0, 0, 0, 0, 0, 0.0, 0.0, 0, 0, file_size)

    pixel_count = width * height
    bitrate = _positive_int(probe.get("bitrate")) or 0
    fps = _positive_float(probe.get("fps")) or 0.0
    normalisation_fps = fps or 30.0
    codec = str(probe.get("codec") or "").lower()
    codec_weight = CODEC_WEIGHTS.get(codec, 1.0)
    active_area_fraction = _positive_float(probe.get("active_area_fraction")) or 1.0
    active_area_fraction = min(max(active_area_fraction, 0.05), 1.0)
    active_pixel_count = max(1.0, pixel_count * active_area_fraction)

    if bitrate:
        normalised_bpppf = bitrate * codec_weight / (active_pixel_count * normalisation_fps)
        normalised_bpppf = min(normalised_bpppf, 10.0)
    else:
        normalised_bpppf = 0.0

    bitrate_source_rank = {"stream": 2, "format": 1, "estimated": 1}.get(
        probe.get("bitrate_source"), 0
    )

    return (
        1,
        _resolution_tier(pixel_count),
        int(probe.get("hdr_score") or 0),
        int(probe.get("bit_depth") or 8),
        pixel_count,
        1 if bitrate else 0,
        round(normalised_bpppf, 9),
        round(fps, 3),
        bitrate_source_rank,
        bitrate,
        file_size,
    )

def _name_key(path):
    """Keep containing folders together, then sort filenames A-Z within each."""
    try:
        relative = path.relative_to(TARGET_DIR)
    except ValueError:
        relative = path

    folder_key = tuple(part.casefold() for part in relative.parent.parts)

    return (folder_key, relative.name.casefold())


def get_sort_key(mode, path, probe_cache=None):
    try:
        if mode == "1":
            return _name_key(path)

        stat = path.stat()

        if mode == "2":
            return stat.st_size

        if mode == "3":
            return stat.st_mtime

        if mode == "4":
            return _duration_key(path, probe_cache)

        if mode == "5":
            return _quality_key(path, probe_cache)

    except (OSError, PermissionError, TypeError, ValueError):
        pass

    if mode == "1":
        return ((), "")

    if mode == "4":
        return (0, 0.0, 0)

    if mode == "5":
        return (0, 0, 0, 0, 0, 0, 0.0, 0.0, 0, 0, 0)

    return 0

def sort_entries(entries, mode, probe_cache=None):
    key_cache = {}
    total = len(entries)
    _con_info("Sorting")

    for index, entry in enumerate(entries, 1):
        if index % 50 == 0 or index == total:
            _progress("Keyed", index, total)

        key_cache[entry] = get_sort_key(mode, entry, probe_cache)

    _progress_done("Keyed", total)

    return sorted(entries, key=key_cache.get, reverse=SORT_DESCENDING[mode])

def split_by_orientation(entries, probe_cache):
    horizontal = []
    vertical = []
    dropped = 0
    source_counts = {}

    for path in entries:
        probe = probe_cache.get(path) or {}
        orientation = probe.get("orientation")

        if orientation not in {"horizontal", "vertical"}:
            orientation = _classify_ratio(probe.get("display_ratio"))

        if orientation == "horizontal":
            horizontal.append(path)
        elif orientation == "vertical":
            vertical.append(path)
        else:
            dropped += 1
            continue

        source = str(probe.get("orientation_source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1

    overrides = sum(
        count for source, count in source_counts.items() if source.startswith("content_")
    )
    _con_ok(
        f"{BOLD}{len(horizontal)}{RESET} landscape, "
        f"{BOLD}{len(vertical)}{RESET} portrait, "
        f"{BOLD}{overrides}{RESET} {DIM}content overrides, {RESET}"
        f"{BOLD}{dropped}{RESET} {DIM}unreadable; playlists are exclusive{RESET}"
    )

    return (horizontal, vertical, dropped)

def ask_sort(answered):
    render_screen(answered)
    _print_question("Sort by", SORT_OPTIONS)

    return _con_prompt(valid=set(SORT_OPTIONS))

def ask_orientation(answered):
    render_screen(answered)
    _print_question("Orientation analysis", ORIENTATION_OPTIONS)

    return _con_prompt(valid=set(ORIENTATION_OPTIONS))

def _run():
    answered = {}
    cache = load_cache()
    sort_choice = ask_sort(answered)
    answered["Sort by"] = SORT_OPTIONS[sort_choice]
    orientation_choice = "1"

    if HAS_FFPROBE and HAS_FFMPEG:
        orientation_choice = ask_orientation(answered)
        answered["Orientation"] = ORIENTATION_OPTIONS[orientation_choice]
    elif HAS_FFPROBE:
        answered["Orientation"] = ORIENTATION_OPTIONS["1"]

    render_screen(answered)
    entries, nested_caches = scan()

    if not entries:
        print()
        _con_box([f"{BOLD}{WHITE}NO OUTPUT{RESET}", "", "No videos found."], colour=YELLOW)
        print()
        return

    removed = prune_cache(cache, entries)

    if removed:
        _con_ok(f"Cache pruned  {BOLD}{removed}{RESET} {DIM}records for missing files{RESET}")

    if nested_caches:
        imported, used = import_nested_caches(cache, nested_caches, entries)

        if imported:
            _con_ok(
                f"Nested caches  {BOLD}{imported}{RESET} records "
                f"{DIM}reused from {used} sub-folder "
                f"cache{'' if used == 1 else 's'}{RESET}"
            )

    if HAS_FFPROBE:
        probe_cache = probe_all(entries, cache)
    else:
        probe_cache = load_cached_probes(entries, cache)

    if HAS_FFPROBE and orientation_choice == "2":
        probe_cache = analyse_all_orientations(entries, probe_cache, cache)
    else:
        apply_cached_content_metrics(entries, probe_cache, cache)

    entries = sort_entries(entries, sort_choice, probe_cache=probe_cache)
    print()
    _con_info("Writing")
    written = []
    dropped = 0
    keep = set()

    def write(name_key, playlist_entries, **extra):
        if not playlist_entries:
            return

        path = TARGET_DIR / OUTPUT_NAMES[name_key]

        if save_playlist(path, playlist_entries, probe_cache, **extra):
            written.append((path, len(playlist_entries)))
            keep.add(path.name)

    if HAS_FFPROBE:
        horizontal, vertical, dropped = split_by_orientation(entries, probe_cache)
        write("horizontal", horizontal)
        write("vertical", vertical)

        if DUPLICATE_SCAN_ENABLED:
            print()
            groups = find_duplicate_groups(entries, probe_cache, cache)

            if groups:
                duplicate_entries, title_map, comment_map = build_duplicate_playlist(groups)
                write(
                    "duplicates",
                    duplicate_entries,
                    title_map=title_map,
                    comment_map=comment_map,
                )

    else:
        write("horizontal", entries)

    delete_stale_outputs(keep)
    save_cache(cache)
    clear()
    print()
    _con_box(_header_lines(include_previous=False), colour=CYAN)
    print()
    _render_summary(answered)
    print()

    if written:
        lines = [f"{BOLD}{WHITE}DONE{RESET}", ""]

        for index, (path, count) in enumerate(written):
            if index > 0:
                lines.append("")

            lines.append(f"{DIM}Playlist{RESET}  " f"{BOLD}{path.name}{RESET}")
            lines.append(f"{DIM}Entries {RESET}  " f"{BOLD}{count}{RESET}")

        if dropped:
            lines.append("")
            lines.append(
                f"{DIM}Dropped {RESET}  "
                f"{dropped}  "
                f"{DIM}(unreadable or no "
                f"video stream){RESET}"
            )

        _con_box(lines, colour=GREEN)
    else:
        _con_box([f"{BOLD}{WHITE}NO OUTPUT{RESET}", "", "No files written."], colour=YELLOW)

    print()

def main(arguments=None):
    try:
        configure_target_directory(sys.argv[1:] if arguments is None else arguments)
        _run()

    except TargetDirectoryError as error:
        print()
        _con_warn(str(error))

    except KeyboardInterrupt:
        print()
        _con_warn(f"{DIM}Cancelled.{RESET}")

    except Exception:
        print()
        _con_warn("Unhandled error:")
        import traceback
        traceback.print_exc()

    finally:
        _countdown()

if __name__ == "__main__":
    main()