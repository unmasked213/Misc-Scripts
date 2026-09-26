# ============================================================
# PLAYLIST BUILDER AUTOMATION AND MERGING
# ============================================================
#
# Reads the persistent config at:
#   %APPDATA%\PlaylistBuilder\playlist_builder.json
#
# In watcher mode it:
# - monitors configured roots with native Windows directory notifications;
# - debounces bursts and runs playlist_generator.py headlessly;
# - reconciles each root periodically to catch missed virtual-filesystem events;
# - rebuilds configured merged playlists when source playlists change;
# - preserves last-good outputs while a root, vault or source is unavailable.
#
# No third-party Python packages are required.
#
# ============================================================

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import logging.handlers
import ntpath
import os
import queue
import re
import signal
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

APP_NAME = "PlaylistBuilder"
SCHEMA_VERSION = 1
STATE_SCHEMA_VERSION = 1
GENERATION_POLICY_VERSION = 1

INSTALL_DIR = Path(__file__).resolve().parent
GENERATOR_PATH = INSTALL_DIR / "playlist_generator.py"
STATE_PATH = INSTALL_DIR / "automation_state.json"
LOG_PATH = INSTALL_DIR / "automation.log"
LOCK_PATH = INSTALL_DIR / "automation.lock"
PID_PATH = INSTALL_DIR / "automation.pid"
STOP_PATH = INSTALL_DIR / "automation.stop"

DEFAULT_CONFIG_DIR = Path(os.environ.get("APPDATA") or Path.home()) / APP_NAME
DEFAULT_CONFIG_PATH = DEFAULT_CONFIG_DIR / "playlist_builder.json"

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

MANAGED_OUTPUTS = ("Horz.m3u", "Vert.m3u", "Dupes.m3u")

GENERATED_NAMES = {
    "horz.m3u",
    "vert.m3u",
    "dupes.m3u",
    ".playlist_generator_cache.json",
    ".playlist_generator_cache.json.tmp",
}

SORT_ALIASES = {
    "name": "name",
    "1": "name",
    "size": "size",
    "2": "size",
    "date": "date_modified",
    "date_modified": "date_modified",
    "date-modified": "date_modified",
    "modified": "date_modified",
    "3": "date_modified",
    "duration": "duration",
    "4": "duration",
    "quality": "quality",
    "5": "quality",
    "random": "random",
    "shuffle": "random",
    "6": "random",
}

ORIENTATION_ALIASES = {
    "fast": "fast",
    "metadata": "fast",
    "1": "fast",
    "accurate": "accurate",
    "content": "accurate",
    "2": "accurate",
}

URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class RootConfig:
    path: Path
    enabled: bool
    sort: str
    orientation: str

    @property
    def key(self) -> str:
        return path_key(self.path)


@dataclass(frozen=True)
class MergeConfig:
    name: str
    enabled: bool
    output: Path
    sources: tuple[Path, ...]
    deduplicate: bool
    allow_partial: bool

    @property
    def key(self) -> str:
        material = f"{self.name}\0{path_key(self.output)}"
        return hashlib.sha256(material.encode("utf-8", errors="surrogatepass")).hexdigest()


@dataclass(frozen=True)
class AutomationSettings:
    enabled: bool
    debounce_seconds: float
    reconciliation_interval_seconds: float
    source_poll_interval_seconds: float
    config_poll_interval_seconds: float
    watcher_retry_seconds: float


@dataclass(frozen=True)
class AppConfig:
    settings: AutomationSettings
    default_sort: str
    default_orientation: str
    roots: tuple[RootConfig, ...]
    merges: tuple[MergeConfig, ...]


@dataclass(frozen=True)
class PlaylistEntry:
    comments: tuple[str, ...]
    location: str


def clamp_float(value, default, minimum, maximum):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        number = default

    return max(minimum, min(maximum, number))


def expand_path(value, base_directory: Path | None = None) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError("Paths must be non-empty strings.")

    expanded = os.path.expandvars(os.path.expanduser(value.strip()))
    candidate = Path(expanded)

    if not candidate.is_absolute() and not ntpath.isabs(expanded):
        candidate = (base_directory or Path.cwd()) / candidate

    return candidate


def path_key(path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def normalise_sort(value) -> str:
    key = str(value).strip().lower()

    if key not in SORT_ALIASES:
        raise ConfigError(
            f"Invalid sort value {value!r}. Use name, size, date_modified, "
            "duration, quality or random."
        )

    return SORT_ALIASES[key]


def normalise_orientation(value) -> str:
    key = str(value).strip().lower()

    if key not in ORIENTATION_ALIASES:
        raise ConfigError(f"Invalid orientation value {value!r}. Use fast or accurate.")

    return ORIENTATION_ALIASES[key]


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as error:
        raise ConfigError(f"Configuration file does not exist: {path}") from error
    except PermissionError as error:
        raise ConfigError(f"Configuration file is not readable: {path}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(
            f"Invalid JSON in {path} at line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error


def load_config(path: Path) -> AppConfig:
    data = load_json(path)

    if not isinstance(data, dict):
        raise ConfigError("The configuration root must be a JSON object.")

    schema_version = data.get("schema_version", SCHEMA_VERSION)

    if schema_version != SCHEMA_VERSION:
        raise ConfigError(
            f"Unsupported schema_version {schema_version!r}; expected {SCHEMA_VERSION}."
        )

    defaults = data.get("defaults") or {}

    if not isinstance(defaults, dict):
        raise ConfigError("defaults must be a JSON object.")

    default_sort = normalise_sort(defaults.get("sort", "date_modified"))
    default_orientation = normalise_orientation(defaults.get("orientation", "accurate"))

    automation = data.get("automation") or {}

    if not isinstance(automation, dict):
        raise ConfigError("automation must be a JSON object.")

    settings = AutomationSettings(
        enabled=bool(automation.get("enabled", True)),
        debounce_seconds=clamp_float(automation.get("debounce_seconds"), 5.0, 1.0, 300.0),
        reconciliation_interval_seconds=clamp_float(
            automation.get("reconciliation_interval_seconds"), 900.0, 30.0, 86400.0
        ),
        source_poll_interval_seconds=clamp_float(
            automation.get("source_poll_interval_seconds"), 5.0, 1.0, 3600.0
        ),
        config_poll_interval_seconds=clamp_float(
            automation.get("config_poll_interval_seconds"), 2.0, 0.5, 300.0
        ),
        watcher_retry_seconds=clamp_float(
            automation.get("watcher_retry_seconds"), 30.0, 5.0, 3600.0
        ),
    )

    raw_roots = data.get("watched_roots") or []

    if not isinstance(raw_roots, list):
        raise ConfigError("watched_roots must be a JSON array.")

    config_directory = path.parent
    roots = []
    root_keys = set()

    for index, item in enumerate(raw_roots):
        if isinstance(item, str):
            item = {"path": item}

        if not isinstance(item, dict):
            raise ConfigError(f"watched_roots[{index}] must be a string or object.")

        root = RootConfig(
            path=expand_path(item.get("path"), config_directory),
            enabled=bool(item.get("enabled", True)),
            sort=normalise_sort(item.get("sort", default_sort)),
            orientation=normalise_orientation(item.get("orientation", default_orientation)),
        )

        if root.key in root_keys:
            raise ConfigError(f"Duplicate watched root: {root.path}")

        root_keys.add(root.key)
        roots.append(root)

    raw_merges = data.get("merged_playlists") or []

    if not isinstance(raw_merges, list):
        raise ConfigError("merged_playlists must be a JSON array.")

    merges = []
    merge_keys = set()
    merge_names = set()
    merge_outputs = set()

    for index, item in enumerate(raw_merges):
        if not isinstance(item, dict):
            raise ConfigError(f"merged_playlists[{index}] must be an object.")

        name = str(item.get("name") or "").strip()

        if not name:
            raise ConfigError(f"merged_playlists[{index}].name is required.")

        raw_sources = item.get("sources") or []

        if not isinstance(raw_sources, list) or not raw_sources:
            raise ConfigError(f"merged_playlists[{index}].sources must contain at least one path.")

        merge = MergeConfig(
            name=name,
            enabled=bool(item.get("enabled", True)),
            output=expand_path(item.get("output"), config_directory),
            sources=tuple(
                expand_path(source, config_directory) for source in raw_sources
            ),
            deduplicate=bool(item.get("deduplicate", True)),
            allow_partial=bool(item.get("allow_partial", False)),
        )

        name_key = name.casefold()
        output_key = path_key(merge.output)

        if merge.key in merge_keys or name_key in merge_names:
            raise ConfigError(f"Duplicate merged playlist name: {name}")

        if output_key in merge_outputs:
            raise ConfigError(f"Multiple merged playlists cannot write to: {merge.output}")

        if any(path_key(source) == output_key for source in merge.sources):
            raise ConfigError(f"Merged playlist {name!r} cannot use its own output as a source.")

        merge_keys.add(merge.key)
        merge_names.add(name_key)
        merge_outputs.add(output_key)
        merges.append(merge)

    return AppConfig(
        settings=settings,
        default_sort=default_sort,
        default_orientation=default_orientation,
        roots=tuple(roots),
        merges=tuple(merges),
    )


def atomic_write_text(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")

    try:
        temporary.write_text(content, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def atomic_write_json(path: Path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(path, content)


def read_playlist_text(path: Path) -> str:
    raw = path.read_bytes()

    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def is_url(location: str) -> bool:
    return bool(URL_RE.match(location))


def resolve_playlist_location(source: Path, location: str) -> str:
    location = location.strip()

    if not location or is_url(location):
        return location

    if ntpath.isabs(location):
        return ntpath.normpath(location)

    if os.path.isabs(location):
        return os.path.normpath(location)

    source_parent = str(source.parent)
    windows_like_base = bool(re.match(r"^[A-Za-z]:", source_parent)) or "\\" in source_parent

    if windows_like_base:
        return ntpath.normpath(ntpath.join(source_parent, location))

    return os.path.normpath(os.path.join(source_parent, location))


def playlist_entry_key(location: str) -> str:
    if is_url(location):
        return "url:" + location

    if ntpath.isabs(location) or re.match(r"^[A-Za-z]:", location) or location.startswith("\\\\"):
        return "path:" + ntpath.normcase(ntpath.normpath(location))

    return "path:" + os.path.normcase(os.path.normpath(location))


def parse_playlist(path: Path) -> list[PlaylistEntry]:
    text = read_playlist_text(path)
    pending_comments = []
    entries = []

    for raw_line in text.splitlines():
        line = raw_line.strip()

        if not line:
            continue

        if line.upper() == "#EXTM3U":
            continue

        if line.startswith("#"):
            pending_comments.append(line)
            continue

        entries.append(
            PlaylistEntry(
                comments=tuple(pending_comments),
                location=resolve_playlist_location(path, line),
            )
        )
        pending_comments.clear()

    return entries


def merge_playlist(definition: MergeConfig, logger: logging.Logger) -> bool:
    missing = []
    readable_sources = []

    for source in definition.sources:
        try:
            available = source.is_file()
        except (OSError, PermissionError):
            available = False

        if available:
            readable_sources.append(source)
        else:
            missing.append(source)

    if missing and not definition.allow_partial:
        logger.warning(
            "Merge %s preserved its last-good output; unavailable sources: %s",
            definition.name,
            "; ".join(str(path) for path in missing),
        )
        return False

    if not readable_sources:
        logger.warning("Merge %s has no readable sources; output was not changed.", definition.name)
        return False

    merged = []
    seen = set()

    try:
        for source in readable_sources:
            for entry in parse_playlist(source):
                key = playlist_entry_key(entry.location)

                if definition.deduplicate and key in seen:
                    continue

                seen.add(key)
                merged.append(entry)
    except (OSError, PermissionError) as error:
        logger.warning(
            "Merge %s preserved its last-good output; source read failed: %s",
            definition.name,
            error,
        )
        return False

    lines = ["#EXTM3U", f"# Merged playlist: {definition.name}"]

    for source in readable_sources:
        lines.append(f"# Source: {source}")

    if missing:
        for source in missing:
            lines.append(f"# Unavailable source omitted: {source}")

    for entry in merged:
        lines.extend(entry.comments)
        lines.append(entry.location)

    content = "\n".join(lines) + "\n"

    try:
        atomic_write_text(definition.output, content)
    except (OSError, PermissionError) as error:
        logger.warning(
            "Merge %s could not write %s; existing output was preserved: %s",
            definition.name,
            definition.output,
            error,
        )
        return False

    logger.info(
        "Merged %s: %d entries from %d source(s) -> %s",
        definition.name,
        len(merged),
        len(readable_sources),
        definition.output,
    )
    return True


def generator_fingerprint():
    try:
        stat = GENERATOR_PATH.stat()
        return f"{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return "missing"


def calculate_root_snapshot(root: Path, sort_mode: str, orientation_mode: str):
    try:
        if not root.is_dir():
            return None
    except (OSError, PermissionError):
        return None

    digest = hashlib.sha256()
    digest.update(
        (
            f"policy={GENERATION_POLICY_VERSION}|sort={sort_mode}|"
            f"orientation={orientation_mode}|generator={generator_fingerprint()}\n"
        ).encode("utf-8")
    )
    count = 0

    try:
        walker = os.walk(root)

        for directory, subdirectories, filenames in walker:
            subdirectories.sort(key=str.casefold)
            filenames.sort(key=str.casefold)

            for filename in filenames:
                if Path(filename).suffix.lower() not in VIDEO_EXTENSIONS:
                    continue

                path = Path(directory) / filename

                try:
                    stat = path.stat()
                    relative = os.path.relpath(path, root).replace(os.sep, "/")
                except (OSError, PermissionError, ValueError):
                    continue

                digest.update(relative.casefold().encode("utf-8", errors="surrogatepass"))
                digest.update(b"\0")
                digest.update(str(stat.st_size).encode("ascii"))
                digest.update(b"\0")
                digest.update(str(stat.st_mtime_ns).encode("ascii"))
                digest.update(b"\n")
                count += 1
    except (OSError, PermissionError):
        return None

    outputs = []

    for name in MANAGED_OUTPUTS:
        try:
            if (root / name).is_file():
                outputs.append(name)
        except (OSError, PermissionError):
            pass

    return {"digest": digest.hexdigest(), "count": count, "outputs": outputs}


def source_signature(definition: MergeConfig) -> str:
    records = []

    for source in definition.sources:
        record = {"path": path_key(source), "available": False}

        try:
            stat = source.stat()

            if source.is_file():
                record.update(
                    {
                        "available": True,
                        "size": stat.st_size,
                        "modified_ns": stat.st_mtime_ns,
                    }
                )
        except (OSError, PermissionError):
            pass

        records.append(record)

    material = {
        "name": definition.name,
        "output": path_key(definition.output),
        "deduplicate": definition.deduplicate,
        "allow_partial": definition.allow_partial,
        "sources": records,
    }
    encoded = json.dumps(
        material, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(encoded.encode("utf-8", errors="surrogatepass")).hexdigest()


def load_state():
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "root_snapshots": {},
            "merge_source_signatures": {},
        }

    if not isinstance(data, dict) or data.get("schema_version") != STATE_SCHEMA_VERSION:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "root_snapshots": {},
            "merge_source_signatures": {},
        }

    roots = data.get("root_snapshots")
    merges = data.get("merge_source_signatures")

    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "root_snapshots": roots if isinstance(roots, dict) else {},
        "merge_source_signatures": merges if isinstance(merges, dict) else {},
    }


def save_state(state, logger):
    try:
        atomic_write_json(STATE_PATH, state)
    except OSError as error:
        logger.warning("Could not save automation state: %s", error)


def config_file_signature(path: Path):
    try:
        stat = path.stat()
        return (stat.st_size, stat.st_mtime_ns)
    except (OSError, PermissionError):
        return None


def event_should_be_ignored(relative_path: str) -> bool:
    normalised = relative_path.replace("/", "\\")
    name = ntpath.basename(normalised).casefold()

    if name in GENERATED_NAMES:
        return True

    if (
        name.endswith(".m3u")
        or name.endswith(".m3u8")
        or ".m3u.tmp" in name
        or ".m3u8.tmp" in name
    ):
        return True

    if name.startswith(".playlist_generator_cache.json"):
        return True

    return False


class DirectoryEventWatcher(threading.Thread):
    """Dependency-free recursive Windows directory watcher."""

    def __init__(self, root: Path, callback, logger):
        super().__init__(name=f"PlaylistWatcher:{root}", daemon=True)
        self.root = root
        self.callback = callback
        self.logger = logger
        self.stop_requested = threading.Event()
        self.handle = None

    def stop(self):
        self.stop_requested.set()

        if os.name == "nt" and self.handle:
            try:
                import ctypes

                from ctypes import wintypes

                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.CancelIoEx.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
                kernel32.CancelIoEx.restype = wintypes.BOOL
                kernel32.CancelIoEx(self.handle, None)
            except Exception:
                pass

    def run(self):
        if os.name != "nt":
            return

        import ctypes
        from ctypes import wintypes

        FILE_LIST_DIRECTORY = 0x0001
        FILE_SHARE_READ = 0x00000001
        FILE_SHARE_WRITE = 0x00000002
        FILE_SHARE_DELETE = 0x00000004
        OPEN_EXISTING = 3
        FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
        FILE_NOTIFY_CHANGE_FILE_NAME = 0x00000001
        FILE_NOTIFY_CHANGE_DIR_NAME = 0x00000002
        FILE_NOTIFY_CHANGE_SIZE = 0x00000008
        FILE_NOTIFY_CHANGE_LAST_WRITE = 0x00000010
        ERROR_OPERATION_ABORTED = 995
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.ReadDirectoryChangesW.argtypes = [
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            wintypes.LPVOID,
            wintypes.LPVOID,
        ]
        kernel32.ReadDirectoryChangesW.restype = wintypes.BOOL
        kernel32.CancelIoEx.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        kernel32.CancelIoEx.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.CreateFileW(
            str(self.root),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )

        if handle == INVALID_HANDLE_VALUE:
            error = ctypes.get_last_error()
            self.logger.warning("Could not watch %s (Windows error %s).", self.root, error)
            return

        self.handle = handle
        notify_filter = (
            FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_SIZE
            | FILE_NOTIFY_CHANGE_LAST_WRITE
        )

        self.logger.info("Watching root: %s", self.root)

        try:
            while not self.stop_requested.is_set():
                buffer = ctypes.create_string_buffer(65536)
                bytes_returned = wintypes.DWORD()
                success = kernel32.ReadDirectoryChangesW(
                    handle,
                    buffer,
                    len(buffer),
                    True,
                    notify_filter,
                    ctypes.byref(bytes_returned),
                    None,
                    None,
                )

                if not success:
                    error = ctypes.get_last_error()

                    if self.stop_requested.is_set() or error == ERROR_OPERATION_ABORTED:
                        break

                    self.logger.warning("Watcher stopped for %s (Windows error %s).", self.root, error)
                    break

                data = buffer.raw[: bytes_returned.value]

                if not data:
                    self.callback(self.root, "", 0)
                    continue

                offset = 0

                while offset + 12 <= len(data):
                    next_offset, action, name_length = struct.unpack_from("<III", data, offset)
                    start = offset + 12
                    end = start + name_length
                    relative = data[start:end].decode("utf-16-le", errors="replace")
                    self.callback(self.root, relative, action)

                    if next_offset == 0:
                        break

                    offset += next_offset
        finally:
            self.handle = None
            kernel32.CloseHandle(handle)
            self.logger.info("Stopped watching root: %s", self.root)


class SingleInstance:
    def __init__(self):
        self.handle = None
        self.file = None

    def acquire(self) -> bool:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            ERROR_ALREADY_EXISTS = 183
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
            kernel32.CreateMutexW.restype = wintypes.HANDLE
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            self.handle = kernel32.CreateMutexW(
                None, True, "Local\\PlaylistBuilderAutomation"
            )

            if not self.handle:
                return False

            if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
                kernel32.CloseHandle(self.handle)
                self.handle = None
                return False

            return True

        try:
            import fcntl

            LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
            self.file = LOCK_PATH.open("a+b")
            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (ImportError, OSError):
            return False

    def release(self):
        if os.name == "nt" and self.handle:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
            kernel32.ReleaseMutex.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            kernel32.ReleaseMutex(self.handle)
            kernel32.CloseHandle(self.handle)
            self.handle = None
        elif self.file:
            try:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass

            self.file.close()
            self.file = None


class AutomationService:
    def __init__(self, config_path: Path, logger: logging.Logger):
        self.config_path = config_path
        self.logger = logger
        self.config = None
        self.config_signature = None
        self.state = load_state()
        self.watchers = {}
        self.events = queue.Queue()
        self.pending_roots = {}
        self.pending_merges = {}
        self.merge_last_attempt = {}
        self.failed_merges = set()
        self.unavailable_roots = set()
        self.stop_requested = threading.Event()
        self.next_config_poll = 0.0
        self.next_source_poll = 0.0
        self.next_reconciliation = 0.0
        self.next_watcher_refresh = 0.0

    def request_stop(self, *_):
        self.stop_requested.set()

    def on_directory_event(self, root: Path, relative: str, action: int):
        self.events.put((path_key(root), relative, action))

    def schedule_root(self, root_key: str, delay=None, reason="change"):
        if not self.config or not self.config.settings.enabled:
            return

        if delay is None:
            delay = self.config.settings.debounce_seconds

        due = time.monotonic() + max(0.0, delay)
        current = self.pending_roots.get(root_key)

        if current is None:
            self.pending_roots[root_key] = {"due": due, "reasons": {reason}}
        else:
            current["due"] = max(current["due"], due)
            current["reasons"].add(reason)

    def schedule_merge(self, merge_key: str, delay=0.5, reason="source change"):
        if not self.config or not self.config.settings.enabled:
            return

        due = time.monotonic() + max(0.0, delay)
        current = self.pending_merges.get(merge_key)

        if current is None:
            self.pending_merges[merge_key] = {"due": due, "reasons": {reason}}
        else:
            current["due"] = max(current["due"], due)
            current["reasons"].add(reason)

    def reload_config(self, force=False):
        signature = config_file_signature(self.config_path)

        if not force and signature == self.config_signature:
            return False

        try:
            new_config = load_config(self.config_path)
        except ConfigError as error:
            self.logger.error("Configuration reload failed; retaining last-good config: %s", error)
            self.config_signature = signature
            return False

        old_config = self.config
        self.config = new_config
        self.config_signature = signature
        self.logger.info(
            "Loaded config: %d watched root(s), %d merged playlist(s), automation %s",
            len(new_config.roots),
            len(new_config.merges),
            "enabled" if new_config.settings.enabled else "disabled",
        )

        if not new_config.settings.enabled:
            self.pending_roots.clear()
            self.pending_merges.clear()
            self.stop_watchers()
            return True

        old_root_keys = {root.key for root in old_config.roots} if old_config else set()

        for root in new_config.roots:
            if not root.enabled:
                continue

            if root.key not in old_root_keys and root.key not in self.state["root_snapshots"]:
                self.schedule_root(root.key, delay=0.0, reason="new configuration")

        old_merge_keys = {merge.key for merge in old_config.merges} if old_config else set()

        for merge in new_config.merges:
            if not merge.enabled:
                continue

            if merge.key not in old_merge_keys or not merge.output.exists():
                self.schedule_merge(merge.key, delay=0.0, reason="new configuration")

        self.refresh_watchers(force=True)
        self.next_source_poll = 0.0
        self.next_reconciliation = 0.0
        return True

    def root_map(self):
        if not self.config:
            return {}

        return {root.key: root for root in self.config.roots if root.enabled}

    def merge_map(self):
        if not self.config:
            return {}

        return {merge.key: merge for merge in self.config.merges if merge.enabled}

    def stop_watchers(self):
        watchers = list(self.watchers.values())
        self.watchers.clear()

        for watcher in watchers:
            watcher.stop()

        for watcher in watchers:
            watcher.join(timeout=2.0)

    def refresh_watchers(self, force=False):
        if not self.config or not self.config.settings.enabled:
            self.stop_watchers()
            return

        roots = self.root_map()

        for root_key, watcher in list(self.watchers.items()):
            root = roots.get(root_key)

            if root is None or not watcher.is_alive():
                watcher.stop()
                watcher.join(timeout=1.0)
                self.watchers.pop(root_key, None)

        if os.name != "nt":
            return

        for root_key, root in roots.items():
            if root_key in self.watchers:
                continue

            try:
                available = root.path.is_dir()
            except (OSError, PermissionError):
                available = False

            if not available:
                self.unavailable_roots.add(root_key)
                continue

            became_available = root_key in self.unavailable_roots
            self.unavailable_roots.discard(root_key)
            watcher = DirectoryEventWatcher(root.path, self.on_directory_event, self.logger)
            watcher.start()
            self.watchers[root_key] = watcher

            if became_available or root_key not in self.state["root_snapshots"]:
                self.schedule_root(root_key, delay=0.0, reason="root became available")

    def drain_events(self):
        while True:
            try:
                root_key, relative, action = self.events.get_nowait()
            except queue.Empty:
                break

            if relative and event_should_be_ignored(relative):
                continue

            self.schedule_root(root_key, reason=f"filesystem event {action}")

    def reconcile_roots(self):
        for root in self.root_map().values():
            snapshot = calculate_root_snapshot(root.path, root.sort, root.orientation)

            if snapshot is None:
                self.logger.info("Reconciliation skipped unavailable root: %s", root.path)
                continue

            previous = self.state["root_snapshots"].get(root.key)

            if previous != snapshot:
                self.schedule_root(root.key, delay=0.0, reason="reconciliation")

    def poll_merge_sources(self):
        state_changed = False
        now = time.monotonic()

        for merge in self.merge_map().values():
            signature = source_signature(merge)
            previous = self.state["merge_source_signatures"].get(merge.key)
            last_attempt = self.merge_last_attempt.get(merge.key, 0.0)
            retry_due = (
                merge.key in self.failed_merges
                and now - last_attempt >= self.config.settings.reconciliation_interval_seconds
            )
            output_missing_retry = (
                not merge.output.exists()
                and now - last_attempt >= self.config.settings.reconciliation_interval_seconds
            )

            if previous != signature or retry_due or output_missing_retry:
                self.schedule_merge(merge.key, reason="source playlist change")

            if previous != signature:
                self.state["merge_source_signatures"][merge.key] = signature
                state_changed = True

        if state_changed:
            save_state(self.state, self.logger)

    def run_generator(self, root: RootConfig) -> bool:
        if not GENERATOR_PATH.is_file():
            self.logger.error("Generator is missing: %s", GENERATOR_PATH)
            return False

        try:
            available = root.path.is_dir()
        except (OSError, PermissionError):
            available = False

        if not available:
            self.logger.warning("Root unavailable; existing playlists preserved: %s", root.path)
            return False

        command = [
            sys.executable,
            str(GENERATOR_PATH),
            "--path",
            str(root.path),
            "--headless",
            "--sort",
            root.sort,
            "--orientation",
            root.orientation,
            "--no-close",
        ]
        creation_flags = 0x08000000 if os.name == "nt" else 0
        self.logger.info(
            "Regenerating %s (sort=%s, orientation=%s)",
            root.path,
            root.sort,
            root.orientation,
        )

        try:
            completed = subprocess.run(
                command,
                cwd=INSTALL_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
                creationflags=creation_flags,
            )
        except OSError as error:
            self.logger.error("Could not start generator for %s: %s", root.path, error)
            return False

        output = completed.stdout.strip()

        if output:
            for line in output.splitlines():
                self.logger.debug("generator[%s] %s", root.path, line)

        if completed.returncode != 0:
            self.logger.error(
                "Generator failed for %s with exit code %d.", root.path, completed.returncode
            )
            return False

        snapshot = calculate_root_snapshot(root.path, root.sort, root.orientation)

        if snapshot is not None:
            self.state["root_snapshots"][root.key] = snapshot
            save_state(self.state, self.logger)

        self.logger.info("Regeneration complete: %s", root.path)
        return True

    def run_due_root(self) -> bool:
        now = time.monotonic()
        due_items = [
            (root_key, payload)
            for root_key, payload in self.pending_roots.items()
            if payload["due"] <= now
        ]

        if not due_items:
            return False

        root_key, payload = min(due_items, key=lambda item: item[1]["due"])
        self.pending_roots.pop(root_key, None)
        root = self.root_map().get(root_key)

        if root is None:
            return True

        self.logger.info(
            "Root update due for %s (%s)", root.path, ", ".join(sorted(payload["reasons"]))
        )

        if self.run_generator(root):
            for merge in self.merge_map().values():
                self.schedule_merge(merge.key, delay=0.5, reason="root regenerated")

        return True

    def run_due_merge(self) -> bool:
        now = time.monotonic()
        due_items = [
            (merge_key, payload)
            for merge_key, payload in self.pending_merges.items()
            if payload["due"] <= now
        ]

        if not due_items:
            return False

        merge_key, payload = min(due_items, key=lambda item: item[1]["due"])
        self.pending_merges.pop(merge_key, None)
        merge = self.merge_map().get(merge_key)

        if merge is None:
            return True

        self.logger.info(
            "Merge update due for %s (%s)", merge.name, ", ".join(sorted(payload["reasons"]))
        )
        self.merge_last_attempt[merge.key] = time.monotonic()

        if merge_playlist(merge, self.logger):
            self.failed_merges.discard(merge.key)
        else:
            self.failed_merges.add(merge.key)

        return True

    def run(self):
        STOP_PATH.unlink(missing_ok=True)
        PID_PATH.write_text(str(os.getpid()) + "\n", encoding="ascii")

        try:
            self.reload_config(force=True)

            while not self.stop_requested.is_set():
                if STOP_PATH.exists():
                    self.logger.info("Stop file received.")
                    break

                now = time.monotonic()

                if now >= self.next_config_poll:
                    self.reload_config()
                    interval = (
                        self.config.settings.config_poll_interval_seconds
                        if self.config
                        else 2.0
                    )
                    self.next_config_poll = now + interval

                self.drain_events()

                if self.config and self.config.settings.enabled:
                    if now >= self.next_watcher_refresh:
                        self.refresh_watchers()
                        self.next_watcher_refresh = (
                            now + self.config.settings.watcher_retry_seconds
                        )

                    if now >= self.next_source_poll:
                        self.poll_merge_sources()
                        self.next_source_poll = (
                            now + self.config.settings.source_poll_interval_seconds
                        )

                    if now >= self.next_reconciliation:
                        self.reconcile_roots()
                        self.next_reconciliation = (
                            now + self.config.settings.reconciliation_interval_seconds
                        )

                    if self.run_due_root():
                        continue

                    if self.run_due_merge():
                        continue

                time.sleep(0.25)
        finally:
            self.stop_watchers()
            PID_PATH.unlink(missing_ok=True)
            STOP_PATH.unlink(missing_ok=True)
            self.logger.info("Playlist Builder automation stopped.")


def configure_logging(console=False):
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(APP_NAME)
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_PATH,
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    )
    logger.addHandler(file_handler)

    if console:
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
        logger.addHandler(console_handler)

    return logger


def run_merges_once(config_path: Path, logger: logging.Logger) -> int:
    try:
        config = load_config(config_path)
    except ConfigError as error:
        logger.error("%s", error)
        return 2

    enabled = [merge for merge in config.merges if merge.enabled]

    if not enabled:
        logger.info("No enabled merged playlists are configured.")
        return 0

    failed = 0

    for merge in enabled:
        if not merge_playlist(merge, logger):
            failed += 1

    return 1 if failed else 0


def run_rebuild_once(config_path: Path, logger: logging.Logger) -> int:
    try:
        config = load_config(config_path)
    except ConfigError as error:
        logger.error("%s", error)
        return 2

    service = AutomationService(config_path, logger)
    service.config = config
    failed = 0

    for root in config.roots:
        if root.enabled and not service.run_generator(root):
            failed += 1

    for merge in config.merges:
        if merge.enabled and not merge_playlist(merge, logger):
            failed += 1

    return 1 if failed else 0


def validate_config(config_path: Path, logger: logging.Logger) -> int:
    try:
        config = load_config(config_path)
    except ConfigError as error:
        logger.error("%s", error)
        return 2

    logger.info(
        "Configuration valid: %d watched root(s), %d merged playlist(s), automation %s.",
        len(config.roots),
        len(config.merges),
        "enabled" if config.settings.enabled else "disabled",
    )
    return 0


def parse_arguments(arguments=None):
    parser = argparse.ArgumentParser(description="Playlist Builder automation and merger")
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help="Path to playlist_builder.json",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--merge-now", action="store_true", help="Build all configured merges and exit")
    mode.add_argument(
        "--rebuild-all",
        action="store_true",
        help="Regenerate every configured root, then build merges and exit",
    )
    mode.add_argument(
        "--validate-config", action="store_true", help="Validate configuration and exit"
    )
    return parser.parse_args(arguments)


def main(arguments=None):
    options = parse_arguments(arguments)
    console = options.merge_now or options.rebuild_all or options.validate_config
    logger = configure_logging(console=console)

    if options.merge_now:
        return run_merges_once(options.config, logger)

    if options.rebuild_all:
        return run_rebuild_once(options.config, logger)

    if options.validate_config:
        return validate_config(options.config, logger)

    instance = SingleInstance()

    if not instance.acquire():
        logger.info("Playlist Builder automation is already running.")
        return 0

    service = AutomationService(options.config, logger)
    signal.signal(signal.SIGINT, service.request_stop)

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, service.request_stop)

    logger.info("Playlist Builder automation starting with config: %s", options.config)

    try:
        service.run()
        return 0
    finally:
        instance.release()


if __name__ == "__main__":
    raise SystemExit(main())
