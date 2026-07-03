# ============================================================
# PLAYLIST GENERATOR
# ============================================================
#
# Drop this script into any folder containing media files.
# Run it to scan recursively and produce one or more .m3u
# playlists in the same folder, overwriting any previous run.
#
# Output filenames are fixed:
#   - Videos -> Horz.m3u and Vert.m3u
#   - Images -> Images.m3u
#   - Audio  -> Audio.m3u
#
# Each playlist carries #EXTINF duration and title lines. Players
# that read them (such as mpv) surface the title; players that do
# not (such as IrfanView) ignore the comment lines. Duration is
# taken from metadata already collected; entries without known
# duration are written as -1.
#
# Sort options: Name (A-Z), Size (largest first),
# Date modified (newest first), Duration (longest first),
# Quality (highest first).
#
# Video quality is ranked from metadata already collected by
# ffprobe. Resolution is primary, followed by HDR/bit depth,
# codec-normalised bitrate per pixel per frame, frame rate,
# bitrate, and file size. Missing metadata never shares a score
# scale with valid metadata. In accurate mode the bitrate-per-
# pixel term is measured over the detected active image area, so
# letterboxed video is ranked on real content rather than padding.
#
# Video orientation has two modes:
#   1. Fast: metadata only. Similar speed to the original script.
#   2. Accurate: three low-resolution content samples in one
#      ffmpeg process per changed video. Results are cached.
#
# Accurate mode detects common black-bar and mixed-orientation
# cases. The first accurate run is slower; unchanged files use
# the persistent cache on later runs.
#
# ffprobe in PATH enables Duration, video Quality, and splitting.
# ffmpeg in PATH enables Accurate orientation.
#
# Cryptomator note:
#   Python may resolve mounted Cryptomator drive-letter paths into backing
#   UNC paths like:
#     \\cryptomator-vault\<vault-id>\<vault-name>\folder\file.mp4
#
#   Those paths can work internally, but they are not the paths most players or
#   Explorer expect. Playlist entries are therefore translated back to the
#   mounted drive path, for example:
#     E:\folder\file.mp4
#
#   This is detected dynamically from mounted drive letters, so no per-vault
#   mapping is required.
#
# ============================================================


import json
import math
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

SCRIPT_DIR = Path(__file__).parent.resolve()
COUNTDOWN_SECS = 10
FILE_TYPE_TIMEOUT = 10
PROBE_TIMEOUT = 10
ORIENTATION_TIMEOUT = 15
ORIENTATION_MAX_DIMENSION = 320
ORIENTATION_MAX_WORKERS = 2
ORIENTATION_SQUARE_RATIO = 1.08

CACHE_FILE = SCRIPT_DIR / ".playlist_generator_cache.json"
CACHE_SCHEMA_VERSION = 1
PROBE_CACHE_VERSION = 3
ORIENTATION_CACHE_VERSION = 2

EXTENSIONS = {
    "1": {
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
    },
    "2": {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".bmp",
        ".tiff",
        ".tif",
        ".webp",
        ".heic",
        ".heif",
        ".avif",
        ".jxl",
    },
    "3": {
        ".mp3",
        ".flac",
        ".wav",
        ".aac",
        ".ogg",
        ".opus",
        ".m4a",
        ".wma",
    },
}

FILE_TYPE_LABELS = {
    "1": "Videos",
    "2": "Images",
    "3": "Audio",
}

SORT_OPTIONS = {
    "1": "Name",
    "2": "Size",
    "3": "Date modified",
    "4": "Duration",
    "5": "Quality",
}

ORIENTATION_OPTIONS = {
    "1": "Fast (metadata only)",
    "2": "Accurate (cached content scan)",
}

SORT_DESCENDING = {
    "1": False,
    "2": True,
    "3": True,
    "4": True,
    "5": True,
}

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

OUTPUT_NAMES = {
    "horizontal": "Horz.m3u",
    "vertical": "Vert.m3u",
    "images": "Images.m3u",
    "audio": "Audio.m3u",
}


CRYPTOMATOR_UNC_PREFIX = "\\\\cryptomator-vault\\"

_CRYPTOMATOR_DRIVE_ROOTS = None
_CRYPTOMATOR_ROOT_CACHE = {}


def _strip_extended_windows_prefix(path_text):
    if path_text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path_text[8:]

    if re.match(r"^\\\\\?\\[A-Za-z]:\\", path_text):
        return path_text[4:]

    return path_text


def _windows_path_text(path):
    return _strip_extended_windows_prefix(
        str(path).replace("/", "\\")
    )


def _available_windows_drive_roots():
    if os.name != "nt":
        return []

    try:
        import ctypes

        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    except Exception:
        return [
            f"{chr(code)}:\\"
            for code in range(
                ord("C"),
                ord("Z") + 1,
            )
        ]

    return [
        f"{chr(ord('A') + index)}:\\"
        for index in range(26)
        if bitmask & (1 << index)
    ]


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

        resolved_text = _windows_path_text(
            resolved_root
        ).rstrip("\\")
        lower_resolved = resolved_text.lower()

        if lower_resolved.startswith(
            CRYPTOMATOR_UNC_PREFIX.lower()
        ):
            roots.append(
                (
                    resolved_text,
                    drive_root,
                )
            )

    roots.sort(
        key=lambda item: len(item[0]),
        reverse=True,
    )

    _CRYPTOMATOR_DRIVE_ROOTS = roots

    return roots


def _split_cryptomator_unc_path(path_text):
    normalized_path = _windows_path_text(path_text)
    lower_path = normalized_path.lower()
    lower_prefix = CRYPTOMATOR_UNC_PREFIX.lower()

    if not lower_path.startswith(lower_prefix):
        return None

    rest = normalized_path[len(CRYPTOMATOR_UNC_PREFIX):]
    parts = rest.split("\\", 2)

    if len(parts) != 3:
        return None

    vault_id, vault_name, relative_path = parts

    if not vault_id or not vault_name or not relative_path:
        return None

    vault_root = (
        CRYPTOMATOR_UNC_PREFIX
        + vault_id
        + "\\"
        + vault_name
    )

    return (
        vault_root,
        relative_path,
    )


def _same_existing_file(candidate_path, source_path):
    try:
        if not candidate_path.is_file():
            return False
    except (OSError, PermissionError):
        return False

    try:
        return (
            candidate_path.stat().st_size
            == source_path.stat().st_size
        )
    except (OSError, PermissionError):
        return True


def _resolve_cryptomator_by_existing_file(path_text):
    split_path = _split_cryptomator_unc_path(path_text)

    if split_path is None:
        return path_text

    vault_root, relative_path = split_path
    cache_key = vault_root.lower()
    if cache_key in _CRYPTOMATOR_ROOT_CACHE:
        cached_drive_root = _CRYPTOMATOR_ROOT_CACHE[
            cache_key
        ]

        if cached_drive_root:
            return cached_drive_root + relative_path

        return path_text

    source_path = Path(path_text)

    for drive_root in _available_windows_drive_roots():
        candidate_text = drive_root + relative_path
        candidate_path = Path(candidate_text)

        if _same_existing_file(
            candidate_path,
            source_path,
        ):
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
            suffix = path_text[len(resolved_root):].lstrip("\\")
            return drive_root + suffix

    return _resolve_cryptomator_by_existing_file(path_text)


def _find_media_tool(name):
    executable = shutil.which(name)

    if not executable:
        return None

    try:
        result = subprocess.run(
            [executable, "-version"],
            capture_output=True,
            timeout=5,
            check=False,
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
            kernel32.SetConsoleMode(
                handle,
                mode.value | enable_virtual_terminal_processing,
            )
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

SPINNER = [
    "\u2838",
    "\u2834",
    "\u2826",
    "\u2807",
    "\u280b",
    "\u2819",
    "\u2830",
    "\u2838",
]

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
        print(
            f"  {colour}{PIPE}{RESET} "
            f"{line}{' ' * padding}"
            f"{colour}{PIPE}{RESET}"
        )

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
            sys.stdout.write(
                f"  {RED}{PIPE}{RESET} "
                f"{DIM}Invalid. Choose: {options}{RESET}\n"
            )
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


def _con_prompt_timed_numbered(
    valid,
    default,
    timeout=FILE_TYPE_TIMEOUT,
):
    if sys.platform != "win32":
        while True:
            choice = input(
                f"  {YELLOW}{PIPE}{RESET} Choice: "
            ).strip().lower()

            if not choice:
                return default

            if choice in valid:
                return choice

            options = ", ".join(sorted(valid))
            print(
                f"  {RED}{PIPE}{RESET} "
                f"{DIM}Invalid. Choose: {options}{RESET}"
            )

    import msvcrt

    def _draw(seconds):
        line = (
            f"  {YELLOW}{PIPE}{RESET} Choice: "
            f"{BOLD}{default}{RESET} "
            f"({BOLD}{MAGENTA}{seconds}{RESET})"
        )
        sys.stdout.write(f"\r{line}                    ")
        sys.stdout.flush()

    def _finalise(choice):
        sys.stdout.write(
            f"\r  {YELLOW}{PIPE}{RESET} Choice: "
            f"{BOLD}{choice}{RESET}                    \n"
        )
        sys.stdout.flush()

    remaining = timeout
    _draw(remaining)
    last_tick = time.monotonic()

    while remaining > 0:
        if msvcrt.kbhit():
            choice = msvcrt.getwch().lower()

            if choice in valid:
                _finalise(choice)
                return choice

            if choice in ("\r", "\n"):
                _finalise(default)
                return default

        now = time.monotonic()

        if now - last_tick >= 1.0:
            remaining -= 1
            last_tick = now
            _draw(remaining)

        time.sleep(0.05)

    _finalise(default)
    return default


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
        path = SCRIPT_DIR / name

        if path.exists():
            try:
                timestamps.append(path.stat().st_mtime)
            except OSError:
                pass

    if not timestamps:
        return None

    return time.time() - max(timestamps)


def _header_lines(include_previous=True):
    lines = [f"{BOLD}{WHITE}{SCRIPT_DIR}{RESET}"]
    extras = []

    if include_previous:
        age = _previous_run_age()

        if age is not None:
            extras.append(
                f"{DIM}Previous run{RESET}  "
                f"{_format_age(age)}"
            )

    if not HAS_FFPROBE:
        extras.append(
            f"{RED}ffprobe not found{RESET}  "
            f"{DIM}duration and video quality use file size; "
            f"videos are not split{RESET}"
        )
    elif not HAS_FFMPEG:
        extras.append(
            f"{YELLOW}ffmpeg not found{RESET}  "
            f"{DIM}accurate orientation is unavailable{RESET}"
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
            f"  {GREY}{PIPE}{RESET} "
            f"{DIM}{key:<{key_width}}{RESET}   "
            f"{WHITE}{value}{RESET}"
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
    print(
        f"  {YELLOW}{PIPE}{RESET} "
        f"{BOLD}{WHITE}{label}{RESET}"
    )
    print(f"  {YELLOW}{PIPE}{RESET}")

    for key, option_label in options.items():
        print(
            f"  {YELLOW}{PIPE}{RESET}   "
            f"{DIM}{key}{RESET}  "
            f"{option_label}"
        )

    print(f"  {YELLOW}{PIPE}{RESET}")


def _new_cache():
    return {
        "schema": CACHE_SCHEMA_VERSION,
        "files": {},
        "dirty": False,
    }


def load_cache():
    try:
        data = json.loads(
            CACHE_FILE.read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError, TypeError):
        return _new_cache()

    if not isinstance(data, dict):
        return _new_cache()

    if data.get("schema") != CACHE_SCHEMA_VERSION:
        return _new_cache()

    if not isinstance(data.get("files"), dict):
        return _new_cache()

    return {
        "schema": CACHE_SCHEMA_VERSION,
        "files": data["files"],
        "dirty": False,
    }


def save_cache(cache):
    if not cache.get("dirty"):
        return

    payload = {
        "schema": CACHE_SCHEMA_VERSION,
        "files": cache.get("files", {}),
    }
    temporary_path = CACHE_FILE.with_suffix(
        CACHE_FILE.suffix + ".tmp"
    )

    try:
        temporary_path.write_text(
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        os.replace(temporary_path, CACHE_FILE)
        cache["dirty"] = False
    except OSError:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass


def _cache_key(path):
    try:
        relative = path.relative_to(SCRIPT_DIR)
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
        record = {
            "size": size,
            "modified_ns": modified_ns,
        }
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
            results[path] = (
                dict(cached_probe)
                if isinstance(cached_probe, dict)
                else cached_probe
            )

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

        numerator_text, denominator_text = text.split(
            separator,
            1,
        )
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

    for raw_value in (
        stream_tags.get("rotate"),
        format_tags.get("rotate"),
    ):
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

    pixel_format = str(
        video_stream.get("pix_fmt") or ""
    ).lower()

    planar_match = re.search(
        r"p(9|10|12|14|16)(?:le|be)?$",
        pixel_format,
    )

    if planar_match:
        return int(planar_match.group(1))

    semi_planar_match = re.fullmatch(
        r"p[024](10|12|14|16)(?:le|be)?",
        pixel_format,
    )

    if semi_planar_match:
        return int(semi_planar_match.group(1))

    grayscale_match = re.fullmatch(
        r"gray(9|10|12|14|16)(?:le|be)?",
        pixel_format,
    )

    if grayscale_match:
        return int(grayscale_match.group(1))

    if re.fullmatch(
        r"(?:v210|y210(?:le|be)?|r210|"
        r"x2rgb10(?:le|be)?|x2bgr10(?:le|be)?)",
        pixel_format,
    ):
        return 10

    return 8


def _hdr_score(video_stream):
    transfer = str(
        video_stream.get("color_transfer") or ""
    ).lower()
    primaries = str(
        video_stream.get("color_primaries") or ""
    ).lower()
    colour_space = str(
        video_stream.get("color_space") or ""
    ).lower()

    if transfer in {"smpte2084", "arib-std-b67"}:
        return 2

    if (
        primaries == "bt2020"
        or colour_space.startswith("bt2020")
    ):
        return 1

    return 0


def _classify_ratio(ratio):
    ratio_value = _positive_float(ratio)

    if ratio_value is None:
        return None

    if ratio_value >= ORIENTATION_SQUARE_RATIO:
        return "horizontal"

    if ratio_value <= 1.0 / ORIENTATION_SQUARE_RATIO:
        return "vertical"

    return "square"


def _median(values):
    if not values:
        return None

    ordered = sorted(values)
    midpoint = len(ordered) // 2

    if len(ordered) % 2:
        return ordered[midpoint]

    return (
        ordered[midpoint - 1] + ordered[midpoint]
    ) / 2.0


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

        result["duration"] = _positive_float(
            format_data.get("duration")
        )
        format_bitrate = _positive_int(
            format_data.get("bit_rate")
        )

        video_stream = _select_video_stream(streams)

        if not video_stream:
            return result

        stream_duration = _positive_float(
            video_stream.get("duration")
        )

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

        raw_width = _positive_int(
            video_stream.get("width")
        )
        raw_height = _positive_int(
            video_stream.get("height")
        )

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
                    total_bitrate = int(
                        path.stat().st_size
                        * 8
                        / result["duration"]
                    )
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
                if (
                    audio_bitrate
                    and total_bitrate > audio_bitrate
                ):
                    total_bitrate -= audio_bitrate
                    source = "estimated"

                result["bitrate"] = total_bitrate
                result["bitrate_source"] = (
                    source or "estimated"
                )

        frame_rate = (
            _parse_ratio(
                video_stream.get("avg_frame_rate")
            )
            or _parse_ratio(
                video_stream.get("r_frame_rate")
            )
        )

        if frame_rate and frame_rate <= 240:
            result["fps"] = frame_rate

        result["bit_depth"] = _bit_depth(video_stream)
        result["hdr_score"] = _hdr_score(video_stream)

        rotation = _normalise_rotation(
            _extract_rotation(
                video_stream,
                format_data,
            )
        )
        result["rotation"] = rotation

        sample_aspect_ratio = (
            _parse_ratio(
                video_stream.get("sample_aspect_ratio")
            )
            or 1.0
        )
        display_ratio = _parse_ratio(
            video_stream.get("display_aspect_ratio")
        )

        if display_ratio is None:
            display_ratio = (
                raw_width
                * sample_aspect_ratio
                / raw_height
            )

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
        result["orientation"] = _classify_ratio(
            display_ratio
        )
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
            results[path] = (
                dict(cached_probe)
                if isinstance(cached_probe, dict)
                else cached_probe
            )
            cached_count += 1
        else:
            pending.append(path)

    if cached_count:
        _con_ok(
            f"Metadata cache  "
            f"{BOLD}{cached_count}{RESET} files"
        )

    if not pending:
        return results

    total = len(pending)
    workers = min(
        total,
        max((os.cpu_count() or 4) * 2, 8),
        32,
    )

    _con_info(
        f"Probing metadata  "
        f"{DIM}({total} files, "
        f"{workers} threads){RESET}"
    )

    with ThreadPoolExecutor(
        max_workers=workers
    ) as executor:
        future_map = {
            executor.submit(probe_file, path): path
            for path in pending
        }

        for index, future in enumerate(
            as_completed(future_map),
            1,
        ):
            path = future_map[future]

            try:
                result = future.result()
            except Exception:
                result = None

            results[path] = result
            record = _cache_record(cache, path)

            if record is not None:
                record["probe_version"] = (
                    PROBE_CACHE_VERSION
                )
                record["probe"] = (
                    dict(result)
                    if isinstance(result, dict)
                    else result
                )
                record.pop("orientation_version", None)
                record.pop("content_orientation", None)
                cache["dirty"] = True

            if index % 25 == 0 or index == total:
                _progress("Probed", index, total)

    _progress_done("Probed", total)
    save_cache(cache)

    return results


def _even_dimension(value):
    dimension = max(2, int(round(value)))

    if dimension % 2:
        dimension = (
            dimension - 1
            if dimension > 2
            else 2
        )

    return dimension


def _orientation_dimensions(probe):
    ratio = _positive_float(
        probe.get("display_ratio")
    )

    if ratio is None:
        width = _positive_float(
            probe.get("width")
        )
        height = _positive_float(
            probe.get("height")
        )

        if width is None or height is None:
            return None

        ratio = width / height

    if ratio >= 1.0:
        width = ORIENTATION_MAX_DIMENSION
        height = max(32, round(width / ratio))
    else:
        height = ORIENTATION_MAX_DIMENSION
        width = max(32, round(height * ratio))

    return (
        _even_dimension(width),
        _even_dimension(height),
    )


def _orientation_sample_times(duration):
    duration_value = _positive_float(duration)

    if duration_value is None:
        return [0.5]

    if duration_value <= 1.0:
        candidates = [
            duration_value * 0.15,
            duration_value * 0.50,
            duration_value * 0.85,
        ]
    else:
        edge = min(
            0.5,
            max(0.15, duration_value * 0.01),
        )
        candidates = [
            edge,
            duration_value * 0.50,
            max(edge, duration_value - edge),
        ]

    maximum = max(
        0.0,
        duration_value - 0.02,
    )
    samples = []

    for candidate in candidates:
        timestamp = min(
            max(candidate, 0.0),
            maximum,
        )

        if not any(
            abs(timestamp - existing) < 0.05
            for existing in samples
        ):
            samples.append(timestamp)

    return samples or [0.0]


def _decode_orientation_frames(path, probe):
    dimensions = _orientation_dimensions(probe)

    if dimensions is None:
        return None

    frame_width, frame_height = dimensions
    timestamps = _orientation_sample_times(
        probe.get("duration")
    )
    stream_index = probe.get("stream_index")
    stream_specifier = (
        str(stream_index)
        if stream_index is not None
        else "v:0"
    )

    command = [
        FFMPEG_PATH,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
    ]

    for timestamp in timestamps:
        command.extend(
            [
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(path),
            ]
        )

    filter_parts = []
    output_labels = []

    for index in range(len(timestamps)):
        output_label = f"sample{index}"

        filter_parts.append(
            f"[{index}:{stream_specifier}]"
            f"scale={frame_width}:{frame_height}:"
            f"flags=fast_bilinear,"
            f"setsar=1,"
            f"format=gray,"
            f"setpts=PTS-STARTPTS"
            f"[{output_label}]"
        )
        output_labels.append(f"[{output_label}]")

    if len(output_labels) == 1:
        filter_parts.append(
            f"{output_labels[0]}null[out]"
        )
    else:
        filter_parts.append(
            "".join(output_labels)
            + f"hstack=inputs={len(output_labels)}[out]"
        )

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
            command,
            capture_output=True,
            timeout=ORIENTATION_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    sample_count = len(timestamps)
    stack_width = frame_width * sample_count
    expected_size = stack_width * frame_height

    if completed.returncode != 0:
        return None

    if len(completed.stdout) < expected_size:
        return None

    raw_frame = completed.stdout[:expected_size]
    frames = []

    for sample_index in range(sample_count):
        left = sample_index * frame_width
        rows = []

        for row_index in range(frame_height):
            row_start = (
                row_index * stack_width + left
            )
            rows.append(
                raw_frame[
                    row_start:
                    row_start + frame_width
                ]
            )

        frames.append(b"".join(rows))

    return frame_width, frame_height, frames


def _frame_is_usable(frame):
    if not frame:
        return False

    step = max(1, len(frame) // 4096)
    samples = sorted(frame[::step])

    if not samples:
        return False

    low = samples[
        int((len(samples) - 1) * 0.05)
    ]
    high = samples[
        int((len(samples) - 1) * 0.95)
    ]

    if high < 24:
        return False

    if high - low < 8:
        return False

    return True


def _is_dark_line(values):
    dark_count = 0
    total = 0
    value_sum = 0

    for value in values:
        total += 1
        value_sum += value

        if value <= 40:
            dark_count += 1

    if total == 0:
        return False

    return (
        dark_count / total >= 0.90
        and value_sum / total <= 34
    )


def _dark_row_flags(frame, width, height):
    step = max(1, width // 160)
    flags = []

    for row_index in range(height):
        start = row_index * width
        row = frame[
            start:
            start + width:
            step
        ]
        flags.append(_is_dark_line(row))

    return flags


def _dark_column_flags(frame, width, height):
    step = max(1, height // 160)
    flags = []

    for column_index in range(width):
        values = (
            frame[
                row_index * width + column_index
            ]
            for row_index in range(
                0,
                height,
                step,
            )
        )
        flags.append(_is_dark_line(values))

    return flags


def _edge_dark_extent(flags):
    if not flags:
        return 0

    initial = flags[:min(3, len(flags))]

    if (
        sum(initial)
        < max(
            1,
            math.ceil(len(initial) * 0.67),
        )
    ):
        return 0

    extent = 0
    non_dark_run = 0

    for index, is_dark in enumerate(flags):
        if is_dark:
            extent = index + 1
            non_dark_run = 0
        else:
            non_dark_run += 1

            if non_dark_run >= 3:
                break

    return extent


def _validated_bar_pair(
    first,
    second,
    dimension,
):
    minimum_side = max(
        2,
        int(dimension * 0.015),
    )
    minimum_total = max(
        4,
        int(dimension * 0.06),
    )

    if first < minimum_side or second < minimum_side:
        return 0, 0

    if first + second < minimum_total:
        return 0, 0

    if (
        min(first, second)
        / max(first, second)
        < 0.45
    ):
        return 0, 0

    if (
        dimension - first - second
        < dimension * 0.15
    ):
        return 0, 0

    return first, second


def _classify_content_frame(
    frame,
    width,
    height,
):
    if not _frame_is_usable(frame):
        return None

    row_flags = _dark_row_flags(
        frame,
        width,
        height,
    )
    column_flags = _dark_column_flags(
        frame,
        width,
        height,
    )

    top = _edge_dark_extent(row_flags)
    bottom = _edge_dark_extent(
        list(reversed(row_flags))
    )
    left = _edge_dark_extent(column_flags)
    right = _edge_dark_extent(
        list(reversed(column_flags))
    )

    top, bottom = _validated_bar_pair(
        top,
        bottom,
        height,
    )
    left, right = _validated_bar_pair(
        left,
        right,
        width,
    )

    active_width = width - left - right
    active_height = height - top - bottom

    if active_width <= 0 or active_height <= 0:
        return None

    full_area = width * height
    active_area_fraction = (
        active_width
        * active_height
        / full_area
    )

    return {
        "orientation": _classify_ratio(
            active_width / active_height
        ),
        "cropped": bool(
            top or bottom or left or right
        ),
        "active_area_fraction": (
            active_area_fraction
        ),
    }


def analyse_content_orientation(path, probe):
    decoded = _decode_orientation_frames(
        path,
        probe,
    )

    if decoded is None:
        return {
            "orientation": None,
            "samples": [],
            "cropped_samples": 0,
            "active_area_fraction": None,
            "status": "failed",
        }

    width, height, frames = decoded
    samples = []
    cropped_samples = 0
    active_area_fractions = []

    for frame in frames:
        result = _classify_content_frame(
            frame,
            width,
            height,
        )

        if (
            not result
            or not result.get("orientation")
        ):
            continue

        samples.append(result["orientation"])
        active_area_fractions.append(
            result["active_area_fraction"]
        )

        if result.get("cropped"):
            cropped_samples += 1

    if not samples:
        return {
            "orientation": None,
            "samples": [],
            "cropped_samples": 0,
            "active_area_fraction": None,
            "status": "unusable",
        }

    metadata_orientation = probe.get(
        "orientation"
    )
    horizontal_count = samples.count(
        "horizontal"
    )
    vertical_count = samples.count(
        "vertical"
    )
    square_count = samples.count("square")

    if horizontal_count and vertical_count:
        orientation = "mixed"
    elif square_count and (
        horizontal_count or vertical_count
    ):
        orientation = "mixed"
    elif square_count:
        orientation = "square"
    elif horizontal_count:
        orientation = "horizontal"
    else:
        orientation = "vertical"

    if (
        len(samples) == 1
        and orientation != metadata_orientation
    ):
        orientation = "mixed"

    return {
        "orientation": orientation,
        "samples": samples,
        "cropped_samples": cropped_samples,
        "active_area_fraction": _median(
            active_area_fractions
        ),
        "status": "ok",
    }


def _apply_content_analysis(
    probe,
    analysis,
    apply_orientation,
):
    if not probe or not analysis:
        return

    active_area_fraction = _positive_float(
        analysis.get("active_area_fraction")
    )

    if active_area_fraction is not None:
        probe["active_area_fraction"] = min(
            max(active_area_fraction, 0.05),
            1.0,
        )

    if not apply_orientation:
        return

    orientation = analysis.get("orientation")

    if orientation:
        probe["orientation"] = orientation
        probe["orientation_source"] = "content"
        probe["orientation_samples"] = (
            analysis.get("samples", [])
        )
        probe["cropped_samples"] = (
            analysis.get(
                "cropped_samples",
                0,
            )
        )


def apply_cached_content_metrics(
    entries,
    probe_cache,
    cache,
):
    if not probe_cache:
        return

    for path in entries:
        probe = probe_cache.get(path)

        if not probe:
            continue

        record = _matching_cache_record(
            cache,
            path,
        )

        if (
            record is None
            or record.get("orientation_version")
            != ORIENTATION_CACHE_VERSION
            or "content_orientation" not in record
        ):
            continue

        _apply_content_analysis(
            probe,
            record.get("content_orientation"),
            apply_orientation=False,
        )


def analyse_all_orientations(
    entries,
    probe_cache,
    cache,
):
    pending = []
    cached_count = 0

    for path in entries:
        probe = (probe_cache or {}).get(path)

        if (
            not probe
            or not probe.get("width")
            or not probe.get("height")
        ):
            continue

        record = _matching_cache_record(
            cache,
            path,
        )

        if (
            record is not None
            and record.get("orientation_version")
            == ORIENTATION_CACHE_VERSION
            and "content_orientation" in record
        ):
            analysis = record.get(
                "content_orientation"
            )
            _apply_content_analysis(
                probe,
                analysis,
                apply_orientation=True,
            )
            cached_count += 1
        else:
            pending.append(path)

    if cached_count:
        _con_ok(
            f"Orientation cache  "
            f"{BOLD}{cached_count}{RESET} files"
        )

    if not pending:
        return probe_cache

    total = len(pending)
    workers = min(
        total,
        max(
            1,
            min(
                ORIENTATION_MAX_WORKERS,
                os.cpu_count() or 1,
            ),
        ),
    )

    _con_info(
        f"Analysing content  "
        f"{DIM}({total} changed files, "
        f"{workers} workers, "
        f"3 samples each){RESET}"
    )

    with ThreadPoolExecutor(
        max_workers=workers
    ) as executor:
        future_map = {
            executor.submit(
                analyse_content_orientation,
                path,
                probe_cache[path],
            ): path
            for path in pending
        }

        for index, future in enumerate(
            as_completed(future_map),
            1,
        ):
            path = future_map[future]

            try:
                analysis = future.result()
            except Exception:
                analysis = {
                    "orientation": None,
                    "samples": [],
                    "cropped_samples": 0,
                    "active_area_fraction": None,
                    "status": "failed",
                }

            _apply_content_analysis(
                probe_cache.get(path),
                analysis,
                apply_orientation=True,
            )
            record = _cache_record(
                cache,
                path,
            )

            if record is not None:
                record["orientation_version"] = (
                    ORIENTATION_CACHE_VERSION
                )
                record["content_orientation"] = (
                    analysis
                )
                cache["dirty"] = True

            if index % 10 == 0 or index == total:
                _progress(
                    "Analysed",
                    index,
                    total,
                )

    _progress_done("Analysed", total)
    save_cache(cache)

    return probe_cache


def scan(mode):
    _con_info("Scanning")

    extensions = EXTENSIONS[mode]
    results = []

    for path in SCRIPT_DIR.rglob("*"):
        try:
            if (
                path.is_file()
                and path.suffix.lower() in extensions
            ):
                results.append(path)

                if len(results) % 25 == 0:
                    _progress_open(
                        "Found",
                        len(results),
                    )
        except (OSError, PermissionError):
            continue

    _progress_done("Found", len(results))

    return results


def _playlist_duration(path, probe_cache):
    probe = (probe_cache or {}).get(path)
    duration = (
        _positive_float(
            probe.get("duration")
        )
        if probe
        else None
    )

    if duration is None:
        return -1

    return max(0, int(round(duration)))


def _playlist_title(path):
    return (
        path.name
        .replace("\r", " ")
        .replace("\n", " ")
    )


def save_playlist(
    path,
    entries,
    probe_cache=None,
):
    lines = ["#EXTM3U"]

    for entry in entries:
        duration = _playlist_duration(
            entry,
            probe_cache,
        )
        title = _playlist_title(entry)

        lines.append(
            f"#EXTINF:{duration},{title}"
        )
        lines.append(playlist_path_text(entry))

    content = "\n".join(lines) + "\n"

    try:
        path.write_text(
            content,
            encoding="utf-8",
        )
        return True
    except (OSError, PermissionError) as error:
        _con_warn(
            f"Failed to save "
            f"{path.name}: {error}"
        )
        return False


def delete_stale_outputs(keep_names):
    for name in OUTPUT_NAMES.values():
        if name in keep_names:
            continue

        path = SCRIPT_DIR / name

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
    duration = (
        _positive_float(
            probe.get("duration")
        )
        if probe
        else None
    )

    if duration is not None:
        return (
            1,
            duration,
            file_size,
        )

    return (
        0,
        0.0,
        file_size,
    )


def _quality_key(
    path,
    file_type,
    probe_cache,
):
    file_size = _file_size(path)

    if file_type != "1":
        return (file_size,)

    probe = (probe_cache or {}).get(path)

    if not probe:
        return (
            0,
            0,
            0,
            0,
            0,
            0,
            0.0,
            0.0,
            0,
            0,
            file_size,
        )

    width = _positive_int(
        probe.get("width")
    )
    height = _positive_int(
        probe.get("height")
    )

    if not width or not height:
        return (
            0,
            0,
            0,
            0,
            0,
            0,
            0.0,
            0.0,
            0,
            0,
            file_size,
        )

    pixel_count = width * height
    bitrate = (
        _positive_int(
            probe.get("bitrate")
        )
        or 0
    )
    fps = (
        _positive_float(
            probe.get("fps")
        )
        or 0.0
    )
    normalisation_fps = fps or 30.0
    codec = str(
        probe.get("codec") or ""
    ).lower()
    codec_weight = CODEC_WEIGHTS.get(
        codec,
        1.0,
    )

    active_area_fraction = (
        _positive_float(
            probe.get(
                "active_area_fraction"
            )
        )
        or 1.0
    )
    active_area_fraction = min(
        max(active_area_fraction, 0.05),
        1.0,
    )
    active_pixel_count = max(
        1.0,
        pixel_count * active_area_fraction,
    )

    if bitrate:
        normalised_bpppf = (
            bitrate
            * codec_weight
            / (
                active_pixel_count
                * normalisation_fps
            )
        )
        normalised_bpppf = min(
            normalised_bpppf,
            10.0,
        )
    else:
        normalised_bpppf = 0.0

    bitrate_source_rank = {
        "stream": 2,
        "format": 1,
        "estimated": 1,
    }.get(
        probe.get("bitrate_source"),
        0,
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


def get_sort_key(
    mode,
    path,
    file_type,
    probe_cache=None,
):
    try:
        if mode == "1":
            return str(path).casefold()

        stat = path.stat()

        if mode == "2":
            return stat.st_size

        if mode == "3":
            return stat.st_mtime

        if mode == "4":
            return _duration_key(
                path,
                probe_cache,
            )

        if mode == "5":
            return _quality_key(
                path,
                file_type,
                probe_cache,
            )

    except (
        OSError,
        PermissionError,
        TypeError,
        ValueError,
    ):
        pass

    if mode == "1":
        return ""

    if mode == "4":
        return (
            0,
            0.0,
            0,
        )

    if mode == "5" and file_type == "1":
        return (
            0,
            0,
            0,
            0,
            0,
            0,
            0.0,
            0.0,
            0,
            0,
            0,
        )

    if mode == "5":
        return (0,)

    return 0


def sort_entries(
    entries,
    mode,
    file_type,
    probe_cache=None,
):
    key_cache = {}
    total = len(entries)

    _con_info("Sorting")

    for index, entry in enumerate(
        entries,
        1,
    ):
        if index % 50 == 0 or index == total:
            _progress(
                "Keyed",
                index,
                total,
            )

        key_cache[entry] = get_sort_key(
            mode,
            entry,
            file_type,
            probe_cache,
        )

    _progress_done("Keyed", total)

    return sorted(
        entries,
        key=key_cache.get,
        reverse=SORT_DESCENDING[mode],
    )


def split_by_orientation(
    entries,
    probe_cache,
):
    horizontal = []
    vertical = []
    square_count = 0
    mixed_count = 0
    dropped = 0

    for path in entries:
        orientation = (
            (
                probe_cache.get(path)
                or {}
            ).get("orientation")
        )

        if orientation == "horizontal":
            horizontal.append(path)

        elif orientation == "vertical":
            vertical.append(path)

        elif orientation == "square":
            horizontal.append(path)
            vertical.append(path)
            square_count += 1

        elif orientation == "mixed":
            horizontal.append(path)
            vertical.append(path)
            mixed_count += 1

        else:
            dropped += 1

    horizontal_only = (
        len(horizontal)
        - square_count
        - mixed_count
    )
    vertical_only = (
        len(vertical)
        - square_count
        - mixed_count
    )

    _con_ok(
        f"{BOLD}{horizontal_only}{RESET} "
        f"landscape, "
        f"{BOLD}{vertical_only}{RESET} "
        f"portrait, "
        f"{BOLD}{square_count}{RESET} "
        f"{DIM}square (in both){RESET}, "
        f"{BOLD}{mixed_count}{RESET} "
        f"{DIM}mixed (in both){RESET}, "
        f"{BOLD}{dropped}{RESET} "
        f"{DIM}unreadable{RESET}"
    )

    return (
        horizontal,
        vertical,
        dropped,
    )


def ask_file_type(answered):
    render_screen(answered)
    _print_question(
        "File type",
        FILE_TYPE_LABELS,
    )

    return _con_prompt_timed_numbered(
        valid=set(FILE_TYPE_LABELS),
        default="1",
        timeout=FILE_TYPE_TIMEOUT,
    )


def ask_sort(answered):
    render_screen(answered)
    _print_question(
        "Sort by",
        SORT_OPTIONS,
    )

    return _con_prompt(
        valid=set(SORT_OPTIONS)
    )


def ask_orientation(answered):
    render_screen(answered)
    _print_question(
        "Orientation analysis",
        ORIENTATION_OPTIONS,
    )

    return _con_prompt(
        valid=set(ORIENTATION_OPTIONS)
    )


def _run():
    answered = {}
    cache = load_cache()

    file_type = ask_file_type(answered)
    answered["File type"] = (
        FILE_TYPE_LABELS[file_type]
    )

    sort_choice = ask_sort(answered)
    answered["Sort by"] = (
        SORT_OPTIONS[sort_choice]
    )

    orientation_choice = "1"

    if (
        file_type == "1"
        and HAS_FFPROBE
        and HAS_FFMPEG
    ):
        orientation_choice = (
            ask_orientation(answered)
        )
        answered["Orientation"] = (
            ORIENTATION_OPTIONS[
                orientation_choice
            ]
        )
    elif file_type == "1" and HAS_FFPROBE:
        answered["Orientation"] = (
            ORIENTATION_OPTIONS["1"]
        )

    render_screen(answered)

    entries = scan(file_type)

    if not entries:
        print()
        _con_box(
            [
                f"{BOLD}{WHITE}NO OUTPUT{RESET}",
                "",
                "No matching files found.",
            ],
            colour=YELLOW,
        )
        print()
        return

    is_video = file_type == "1"
    will_split = (
        is_video
        and HAS_FFPROBE
    )
    needs_probe = (
        will_split
        or (
            sort_choice == "4"
            and HAS_FFPROBE
        )
        or (
            sort_choice == "5"
            and is_video
            and HAS_FFPROBE
        )
    )

    if needs_probe:
        probe_cache = probe_all(
            entries,
            cache,
        )
    else:
        probe_cache = load_cached_probes(
            entries,
            cache,
        )

    if (
        will_split
        and orientation_choice == "2"
    ):
        probe_cache = analyse_all_orientations(
            entries,
            probe_cache,
            cache,
        )
    else:
        apply_cached_content_metrics(
            entries,
            probe_cache,
            cache,
        )

    entries = sort_entries(
        entries,
        sort_choice,
        file_type,
        probe_cache=probe_cache,
    )

    print()
    _con_info("Writing")

    written = []
    dropped = 0
    keep = set()

    if will_split:
        (
            horizontal,
            vertical,
            dropped,
        ) = split_by_orientation(
            entries,
            probe_cache,
        )

        if horizontal:
            path = (
                SCRIPT_DIR
                / OUTPUT_NAMES["horizontal"]
            )

            if save_playlist(
                path,
                horizontal,
                probe_cache,
            ):
                written.append(
                    (path, len(horizontal))
                )
                keep.add(path.name)

        if vertical:
            path = (
                SCRIPT_DIR
                / OUTPUT_NAMES["vertical"]
            )

            if save_playlist(
                path,
                vertical,
                probe_cache,
            ):
                written.append(
                    (path, len(vertical))
                )
                keep.add(path.name)

    else:
        if file_type == "1":
            name_key = "horizontal"
        elif file_type == "2":
            name_key = "images"
        else:
            name_key = "audio"

        path = (
            SCRIPT_DIR
            / OUTPUT_NAMES[name_key]
        )

        if save_playlist(
            path,
            entries,
            probe_cache,
        ):
            written.append(
                (path, len(entries))
            )
            keep.add(path.name)

    delete_stale_outputs(keep)
    save_cache(cache)

    clear()
    print()
    _con_box(
        _header_lines(
            include_previous=False
        ),
        colour=CYAN,
    )
    print()
    _render_summary(answered)
    print()

    if written:
        lines = [
            f"{BOLD}{WHITE}DONE{RESET}",
            "",
        ]

        for index, (
            path,
            count,
        ) in enumerate(written):
            if index > 0:
                lines.append("")

            lines.append(
                f"{DIM}Playlist{RESET}  "
                f"{BOLD}{path.name}{RESET}"
            )
            lines.append(
                f"{DIM}Entries {RESET}  "
                f"{BOLD}{count}{RESET}"
            )

        if dropped:
            lines.append("")
            lines.append(
                f"{DIM}Dropped {RESET}  "
                f"{dropped}  "
                f"{DIM}(unreadable or no "
                f"video stream){RESET}"
            )

        _con_box(
            lines,
            colour=GREEN,
        )
    else:
        _con_box(
            [
                f"{BOLD}{WHITE}NO OUTPUT{RESET}",
                "",
                "No files written.",
            ],
            colour=YELLOW,
        )

    print()


def main():
    try:
        _run()

    except KeyboardInterrupt:
        print()
        _con_warn(
            f"{DIM}Cancelled.{RESET}"
        )

    except Exception:
        print()
        _con_warn("Unhandled error:")

        import traceback

        traceback.print_exc()

    finally:
        _countdown()


if __name__ == "__main__":
    main()




