# -*- coding: utf-8 -*-
"""
dir_tree.py - bounded recursive directory tree generator (double-click friendly)

Scans a target folder recursively and generates a Markdown directory tree with
box-drawing characters, inline folder annotations, and a boxed header.

Default behaviour is designed for AI context and guarantees bounded output:
  - Does not read .gitignore, .cursorignore, or any other ignore file.
  - Lists filenames such as secrets.yaml and .env without reading their content.
  - Lists known low-value directories but does not descend into them.
  - Does not follow directory symlinks, junctions, or duplicate directory roots.
  - Limits each directory to 60 child folders and 80 files.
  - Limits each repetitive bulk file family to 20 representative filenames.
  - Trims lower-value subtrees when needed to keep the complete document within
    1,000 lines. Every reduction is shown explicitly in the tree.

Output:
  Default: saved as [foldername]_dir_tree.md in the target folder.
  --clipboard: copied to the Windows clipboard; no output file is written.

Usage:
  Double-click to scan the folder the script lives in, or:
    python dir_tree.py --path "X:/Projects" --depth 4
    pythonw dir_tree.py --clipboard --path "X:/Projects"
    python dir_tree.py --path "X:/Projects" --unbounded --expand
"""
from __future__ import annotations

import hashlib
import os
import stat
import sys
import time
import traceback
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Sequence, TypeVar

os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------------------
# Box-drawing characters
# ---------------------------------------------------------------------------

PIPE = "\u2502"
TEE = "\u251c"
ELBOW = "\u2570"
DASH = "\u2500"
BOX_TL = "\u256d"
BOX_TR = "\u256e"
BOX_BL = "\u2570"
BOX_BR = "\u256f"
BOX_L_TEE = "\u251c"
BOX_R_TEE = "\u2524"
FOLDER = "\U0001f4c1"


# ---------------------------------------------------------------------------
# Output policy
# ---------------------------------------------------------------------------

MAX_DOCUMENT_LINES = 1_000
MIN_DOCUMENT_LINES = 250
MAX_DIRECTORIES_PER_DIRECTORY = 60
MAX_FILES_PER_DIRECTORY = 80
MAX_BULK_FILES_PER_CATEGORY = 20
MAX_EXPANDED_IDENTICAL_SIBLINGS = 4
MIN_IDENTICAL_SIBLING_GROUP = 6
MIN_IDENTICAL_SUBTREE_LINES = 8

# Blank separators remain between top-level sections only. Applying them at
# every depth can add thousands of lines without adding structural information.
BREATHE_MAX_DEPTH = 1
BREATHE_MIN_DIRS = 2

# These directories are always shown, but their contents are not traversed by
# default. The list is intentionally conservative and limited to predictable
# dependency, version-control, cache, environment, and generated-output trees.
DEFAULT_COLLAPSED_NAMES: frozenset[str] = frozenset({
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "bower_components",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
    ".eggs",
    ".gradle",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".pnpm-store",
    ".svelte-kit",
    ".turbo",
    "coverage",
    "htmlcov",
})

# Path-specific tool internals that can contain a second complete copy of the
# project. The suffix is matched case-insensitively against the target-relative
# directory path.
DEFAULT_COLLAPSED_PATH_SUFFIXES: tuple[tuple[str, ...], ...] = (
    (".claude", "worktrees"),
    (".codex", "worktrees"),
    (".agents", "worktrees"),
)

# Directory names prioritised when a single parent has more child directories
# than can be listed. This protects common source, configuration, test, and
# documentation entry points without applying project-specific ignore files.
PRIORITY_DIRECTORY_NAMES: frozenset[str] = frozenset({
    ".agents",
    ".claude",
    ".codex",
    "addons",
    "ai-stack",
    "blueprints",
    "pyscript",
    "script-modules",
    "script-opts",
    "shaders",
    "app",
    "apps",
    "assets",
    "bin",
    "cards",
    "client",
    "components",
    "config",
    "configs",
    "custom_components",
    "docs",
    "documentation",
    "include",
    "lib",
    "modules",
    "packages",
    "plugins",
    "public",
    "scripts",
    "server",
    "skills",
    "src",
    "source",
    "templates",
    "test",
    "tests",
    "themes",
    "ui",
    "views",
    "www",
})

# These names are not collapsed automatically. They are only preferred for
# global budget trimming after local folder/file limits have already applied.
LOW_VALUE_DIRECTORY_HINTS: frozenset[str] = frozenset({
    "archive",
    "archives",
    "backup",
    "backups",
    "cache",
    "caches",
    "downloads",
    "example",
    "examples",
    "fixtures",
    "fonts",
    "generated",
    "images",
    "image",
    "logs",
    "media",
    "recordings",
    "reports",
    "snapshots",
    "temp",
    "temporary",
    "third_party",
    "thumbnails",
    "thumbnail",
    "tmp",
    "transcripts",
    "vendor",
})

# Protected names are collapsed later than ordinary branches when the global
# line budget is enforced.
GLOBAL_PROTECTED_DIRECTORY_NAMES: frozenset[str] = frozenset({
    *PRIORITY_DIRECTORY_NAMES,
    "base",
    "core",
    "hooks",
    "rules",
})

BULK_EXTENSION_CATEGORIES: dict[str, frozenset[str]] = {
    "image": frozenset({
        ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jfif",
        ".jpeg", ".jpg", ".png", ".psd", ".raw", ".svg", ".tif",
        ".tiff", ".webp",
    }),
    "video": frozenset({
        ".3gp", ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov",
        ".mp4", ".mpeg", ".mpg", ".mts", ".ogv", ".webm", ".wmv",
    }),
    "audio": frozenset({
        ".aac", ".aiff", ".alac", ".flac", ".m4a", ".mid", ".midi",
        ".mp3", ".oga", ".ogg", ".opus", ".wav", ".wma",
    }),
    "font": frozenset({
        ".eot", ".otf", ".ttc", ".ttf", ".woff", ".woff2",
    }),
    "archive": frozenset({
        ".7z", ".bz2", ".cab", ".gz", ".iso", ".rar", ".tar",
        ".tar.bz2", ".tar.gz", ".tar.xz", ".tbz2", ".tgz", ".txz",
        ".xz", ".zip", ".zst",
    }),
    "binary": frozenset({
        ".a", ".aab", ".apk", ".appimage", ".bin", ".deb", ".dll",
        ".dylib", ".exe", ".lib", ".msi", ".o", ".obj", ".pdb",
        ".rpm", ".so", ".wasm",
    }),
    "database": frozenset({
        ".db", ".db-shm", ".db-wal", ".sqlite", ".sqlite3",
    }),
    "dataset": frozenset({
        ".arrow", ".csv", ".feather", ".npy", ".npz", ".parquet",
        ".pickle", ".pkl",
    }),
    "document": frozenset({
        ".doc", ".docm", ".docx", ".epub", ".odf", ".odg", ".odp",
        ".ods", ".odt", ".pdf", ".ppt", ".pptm", ".pptx", ".rtf",
        ".xls", ".xlsb", ".xlsm", ".xlsx",
    }),
    "model": frozenset({
        ".ckpt", ".gguf", ".onnx", ".pt", ".pth", ".safetensors",
    }),
    "log": frozenset({
        ".log", ".trace",
    }),
}

REPETITIVE_BULK_CATEGORIES: frozenset[str] = frozenset({
    "archive",
    "audio",
    "binary",
    "database",
    "dataset",
    "font",
    "image",
    "log",
    "model",
    "video",
})

STRUCTURAL_EXTENSIONS: frozenset[str] = frozenset({
    ".asm", ".astro", ".bat", ".c", ".cc", ".cfg", ".cjs", ".clj",
    ".cljs", ".cmd", ".conf", ".cpp", ".cs", ".css", ".cu", ".cuh",
    ".dart", ".env", ".fish", ".fs", ".fsx", ".glsl", ".go", ".graphql",
    ".groovy", ".h", ".handlebars", ".hbs", ".hh", ".hook", ".hpp",
    ".htm", ".html", ".ini", ".java", ".jinja", ".jinja2", ".jl",
    ".js", ".json", ".json5", ".jsonc", ".jsx", ".kt", ".kts", ".less",
    ".lua", ".m", ".md", ".mdx", ".mjs", ".mm", ".mustache", ".php",
    ".pl", ".pm", ".proto", ".ps1", ".psd1", ".psm1", ".py", ".pyi",
    ".r", ".rb", ".rs", ".sass", ".scala", ".scss", ".sh", ".sql",
    ".svelte", ".swift", ".tex", ".tf", ".tfvars", ".toml", ".ts",
    ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zsh",
})

SPECIAL_FILENAMES: frozenset[str] = frozenset({
    ".dockerignore",
    ".editorconfig",
    ".env",
    ".gitattributes",
    ".gitignore",
    ".npmrc",
    ".prettierignore",
    ".prettierrc",
    ".python-version",
    ".treeignore",
    "agents.md",
    "architecture.md",
    "cargo.lock",
    "cargo.toml",
    "changelog",
    "changelog.md",
    "claude.md",
    "cmakelists.txt",
    "codeowners",
    "compose.yaml",
    "compose.yml",
    "containerfile",
    "dockerfile",
    "gemfile",
    "go.mod",
    "go.sum",
    "justfile",
    "license",
    "license.md",
    "makefile",
    "manifest.json",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "pyproject.toml",
    "readme",
    "readme.md",
    "requirements.txt",
    "system_context.yaml",
    "tsconfig.json",
    "yarn.lock",
})

try:
    SCRIPT_PATH = Path(__file__).resolve()
except OSError:
    SCRIPT_PATH = Path(__file__)

ProgressFn = Callable[[int, str], None]
T = TypeVar("T")


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Config:
    target: Path
    max_depth: int = 0
    show_hidden: bool = True
    collapsed_names: frozenset[str] = DEFAULT_COLLAPSED_NAMES
    clipboard: bool = False
    output_name: str = ""
    bounded: bool = True
    max_document_lines: int = MAX_DOCUMENT_LINES
    max_directories_per_directory: int = MAX_DIRECTORIES_PER_DIRECTORY
    max_files_per_directory: int = MAX_FILES_PER_DIRECTORY
    max_bulk_files_per_category: int = MAX_BULK_FILES_PER_CATEGORY

    def is_collapsed(self, entry: Path) -> bool:
        if not self.collapsed_names:
            return False
        if entry.name.casefold() in self.collapsed_names:
            return True
        try:
            relative_parts = tuple(
                part.casefold() for part in entry.relative_to(self.target).parts
            )
        except ValueError:
            relative_parts = tuple(part.casefold() for part in entry.parts)
        return any(
            len(relative_parts) >= len(suffix)
            and relative_parts[-len(suffix):] == suffix
            for suffix in DEFAULT_COLLAPSED_PATH_SUFFIXES
        )

    def is_own_artefact(self, entry: Path) -> bool:
        """Exclude this script and this run's output file at the target root."""
        if self.output_name and entry.name == self.output_name:
            return True
        if entry.name != SCRIPT_PATH.name:
            return False
        try:
            return entry.resolve() == SCRIPT_PATH
        except OSError:
            return False


@dataclass(frozen=True)
class EntryInfo:
    path: Path
    is_dir: bool
    is_link: bool


@dataclass(frozen=True)
class FileNode:
    name: str
    size: int = 0
    category: str = ""
    priority: int = 0


@dataclass(frozen=True)
class SummaryNode:
    label: str


@dataclass
class DirNode:
    name: str
    path: Path
    dirs: list[DirNode] = field(default_factory=list)
    files: list[FileNode] = field(default_factory=list)
    dir_notes: list[SummaryNode] = field(default_factory=list)
    file_notes: list[SummaryNode] = field(default_factory=list)
    error: str = ""
    note: str = ""
    entry_count: int = -1
    direct_folder_total: int = 0
    direct_file_total: int = 0
    direct_file_bytes: int = 0
    trimmed_folder_total: int = 0
    trimmed_file_total: int = 0


@dataclass
class Stats:
    folders: int = 0
    files: int = 0
    total_bytes: int = 0
    dirs_scanned: int = 0
    collapsed: int = 0
    unlisted_files: int = 0
    unlisted_dirs: int = 0
    budget_collapsed: int = 0
    repetitive_collapsed: int = 0


@dataclass
class ScanContext:
    target: Path
    seen_realpaths: dict[str, str] = field(default_factory=dict)
    seen_inodes: dict[tuple[int, int], str] = field(default_factory=dict)

    def register(self, path: Path, display_path: str) -> Optional[str]:
        """Register a directory and return its earlier path if already seen."""
        real_key = _normalised_realpath(path)
        inode_key = _directory_inode(path)

        earlier = self.seen_realpaths.get(real_key)
        if earlier is None and inode_key is not None:
            earlier = self.seen_inodes.get(inode_key)
        if earlier is not None:
            return earlier

        self.seen_realpaths[real_key] = display_path
        if inode_key is not None:
            self.seen_inodes[inode_key] = display_path
        return None


@dataclass(frozen=True)
class PruneCandidate:
    node: DirNode
    depth: int
    relative_path: str
    savings: int
    tier: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _human_size(byte_count: int) -> str:
    for unit, divisor in [
        ("TB", 1 << 40),
        ("GB", 1 << 30),
        ("MB", 1 << 20),
        ("KB", 1 << 10),
    ]:
        if byte_count >= divisor:
            if unit in ("TB", "GB"):
                return f"{byte_count / divisor:.2f} {unit}"
            return f"{byte_count // divisor} {unit}"
    return f"{byte_count} bytes"


def _root_display_name(target: Path) -> str:
    if target.name:
        return target.name
    drive = target.drive
    if drive:
        parts = drive.replace("/", "\\").rstrip("\\").split("\\")
        return parts[-1] if parts and parts[-1] else drive
    return str(target)


def _stat_file(path: Path) -> int:
    try:
        return path.stat(follow_symlinks=False).st_size
    except OSError:
        return 0


def _direct_entry_count(path: Path) -> int:
    try:
        with os.scandir(path) as iterator:
            return sum(1 for _ in iterator)
    except OSError:
        return -1


def _normalised_realpath(path: Path) -> str:
    try:
        resolved = os.path.realpath(os.fspath(path))
    except OSError:
        resolved = os.path.abspath(os.fspath(path))
    return os.path.normcase(os.path.normpath(resolved))


def _directory_inode(path: Path) -> Optional[tuple[int, int]]:
    try:
        result = path.stat()
    except OSError:
        return None
    inode = int(getattr(result, "st_ino", 0) or 0)
    device = int(getattr(result, "st_dev", 0) or 0)
    if inode == 0:
        return None
    return device, inode


def _is_directory_link(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        return False

    if os.name != "nt":
        return False

    try:
        attributes = int(getattr(path.lstat(), "st_file_attributes", 0) or 0)
    except OSError:
        return False
    reparse_flag = int(getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400))
    return bool(attributes & reparse_flag)


def _classify(entries: Iterable[Path]) -> list[EntryInfo]:
    classified: list[EntryInfo] = []
    for entry in entries:
        try:
            is_dir = entry.is_dir()
            is_link = _is_directory_link(entry) if is_dir else entry.is_symlink()
        except OSError:
            continue
        classified.append(EntryInfo(entry, is_dir, is_link))
    classified.sort(key=lambda item: (not item.is_dir, item.path.name.casefold()))
    return classified


def _file_extension(name: str) -> str:
    lower = name.casefold()
    for compound in (".db-shm", ".db-wal", ".tar.gz", ".tar.xz", ".tar.bz2"):
        if lower.endswith(compound):
            return compound
    return Path(lower).suffix


def _file_category(name: str) -> str:
    extension = _file_extension(name)
    for category, extensions in BULK_EXTENSION_CATEGORIES.items():
        if extension in extensions:
            return category
    return ""


def _file_priority(name: str, category: str) -> int:
    lower = name.casefold()
    extension = _file_extension(lower)

    if (
        lower in SPECIAL_FILENAMES
        or lower.startswith("readme")
        or lower.startswith("license")
        or lower.startswith("changelog")
        or lower.startswith("requirements")
        or lower.startswith(".env")
    ):
        return 3
    if extension in STRUCTURAL_EXTENSIONS:
        return 2
    if not category:
        return 1
    return 0


def _representative_sample(items: Sequence[T], limit: int) -> list[T]:
    """Return deterministic head-and-tail examples while preserving order."""
    if limit <= 0:
        return []
    if len(items) <= limit:
        return list(items)
    head_count = (limit + 1) // 2
    tail_count = limit - head_count
    if tail_count == 0:
        return list(items[:head_count])
    return [*items[:head_count], *items[-tail_count:]]


def _plural(count: int, singular: str, plural: Optional[str] = None) -> str:
    return singular if count == 1 else (plural or f"{singular}s")


def _relative_display(path: Path, target: Path) -> str:
    try:
        relative = path.relative_to(target)
        return relative.as_posix() or "."
    except ValueError:
        return path.as_posix()


def _copy_text_to_clipboard(text: str) -> None:
    """Copy Unicode text to the Windows clipboard without external packages."""
    if sys.platform != "win32":
        raise RuntimeError("Clipboard output is supported only on Windows")

    import ctypes
    from ctypes import wintypes

    cf_unicode_text = 13
    gmem_moveable = 0x0002

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL

    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalFree.argtypes = [wintypes.HANDLE]
    kernel32.GlobalFree.restype = wintypes.HANDLE

    owner = user32.CreateWindowExW(
        0,
        "STATIC",
        "dir_tree clipboard owner",
        0,
        0,
        0,
        0,
        0,
        None,
        None,
        None,
        None,
    )
    if not owner:
        raise ctypes.WinError(ctypes.get_last_error())

    clipboard_open = False
    memory = None
    try:
        for _ in range(20):
            if user32.OpenClipboard(owner):
                clipboard_open = True
                break
            time.sleep(0.05)
        if not clipboard_open:
            raise RuntimeError("The clipboard is busy")

        if not user32.EmptyClipboard():
            raise ctypes.WinError(ctypes.get_last_error())

        normalised = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
        payload = normalised.encode("utf-16-le") + b"\x00\x00"
        memory = kernel32.GlobalAlloc(gmem_moveable, len(payload))
        if not memory:
            raise ctypes.WinError(ctypes.get_last_error())

        pointer = kernel32.GlobalLock(memory)
        if not pointer:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            ctypes.memmove(pointer, payload, len(payload))
        finally:
            kernel32.GlobalUnlock(memory)

        if not user32.SetClipboardData(cf_unicode_text, memory):
            raise ctypes.WinError(ctypes.get_last_error())

        memory = None
    finally:
        if clipboard_open:
            user32.CloseClipboard()
        if memory:
            kernel32.GlobalFree(memory)
        user32.DestroyWindow(owner)


def _show_clipboard_error(message: str) -> None:
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                None,
                message,
                "Copy directory tree",
                0x10,
            )
            return
        except Exception:
            pass
    try:
        print(message, file=sys.stderr)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Console chrome
# ---------------------------------------------------------------------------

def _enable_ansi() -> bool:
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
SPINNER = ["\u2838", "\u2834", "\u2826", "\u2807", "\u280b", "\u2819", "\u2830", "\u2838"]

if _ANSI:
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"
    CYAN = "\033[36m"
    GREEN = "\033[32m"
    RED = "\033[31m"
else:
    DIM = BOLD = RESET = CYAN = GREEN = RED = ""


def _strip_ansi(value: str) -> str:
    result = value
    while "\033[" in result:
        start = result.find("\033[")
        end = result.find("m", start)
        if end == -1:
            break
        result = result[:start] + result[end + 1:]
    return result


def _visible_len(value: str) -> int:
    return len(_strip_ansi(value))


def _con_box(lines: list[str], *, colour: str = CYAN) -> None:
    width = max(_visible_len(line) for line in lines) + 2
    bar = DASH * width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")
    for line in lines:
        padding = width - 1 - _visible_len(line)
        print(f"  {colour}{PIPE}{RESET} {line}{' ' * padding}{colour}{PIPE}{RESET}")
    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")


def _con_divider(width: int = 48) -> None:
    print(f"  {DIM}{DASH * width}{RESET}")


def _con_kv(key: str, value: str) -> None:
    print(f"  {DIM}{key:<12}{RESET} {value}")


def _con_warn(message: str) -> None:
    print(f"\n  {RED}{PIPE}{RESET} {message}")


def _con_ok(message: str) -> None:
    print(f"  {GREEN}{PIPE}{RESET} {message}")


# ---------------------------------------------------------------------------
# Local selection policy
# ---------------------------------------------------------------------------

def _select_directory_nodes(
    directories: list[DirNode],
    config: Config,
) -> tuple[list[DirNode], list[DirNode]]:
    if (
        not config.bounded
        or len(directories) <= config.max_directories_per_directory
    ):
        return directories, []

    limit = config.max_directories_per_directory
    prioritised = [
        node
        for node in directories
        if node.name.startswith(".")
        or node.name.casefold() in PRIORITY_DIRECTORY_NAMES
        or node.name.casefold() in config.collapsed_names
    ]
    ordinary = [node for node in directories if node not in prioritised]

    if len(prioritised) >= limit:
        selected = _representative_sample(prioritised, limit)
    else:
        selected = [
            *prioritised,
            *_representative_sample(ordinary, limit - len(prioritised)),
        ]

    selected_ids = {id(node) for node in selected}
    unlisted = [node for node in directories if id(node) not in selected_ids]
    selected.sort(key=lambda node: node.name.casefold())
    return selected, unlisted


def _update_layout_digest(digest: Any, node: DirNode) -> None:
    def add(value: object) -> None:
        digest.update(str(value).encode("utf-8", errors="surrogatepass"))
        digest.update(b"\0")

    add(node.error)
    add(node.note)
    add(node.entry_count)
    add(node.direct_folder_total)
    add(node.direct_file_total)
    add(node.trimmed_folder_total)
    add(node.trimmed_file_total)

    for file in node.files:
        add("file")
        add(file.name.casefold())
    for note in node.dir_notes:
        add("dir-note")
        add(note.label.casefold())
    for note in node.file_notes:
        add("file-note")
        add(note.label.casefold())
    for child in node.dirs:
        add("dir")
        add(child.name.casefold())
        _update_layout_digest(digest, child)


def _bulk_only_categories(node: DirNode) -> Optional[frozenset[str]]:
    if node.note or node.error:
        return None

    categories: set[str] = set()
    for file in node.files:
        if file.category not in REPETITIVE_BULK_CATEGORIES:
            return None
        categories.add(file.category)

    for child in node.dirs:
        child_categories = _bulk_only_categories(child)
        if child_categories is None:
            return None
        categories.update(child_categories)

    if not categories:
        return None
    return frozenset(categories)


def _directory_layout_fingerprint(node: DirNode) -> Optional[bytes]:
    if node.note or node.error:
        return None
    if _render_line_count(node, depth=2) < MIN_IDENTICAL_SUBTREE_LINES:
        return None

    bulk_categories = _bulk_only_categories(node)
    if bulk_categories is not None:
        profile = "bulk-only:" + ",".join(sorted(bulk_categories))
        return hashlib.blake2b(
            profile.encode("ascii"),
            digest_size=20,
        ).digest()

    digest = hashlib.blake2b(digest_size=20)
    _update_layout_digest(digest, node)
    return digest.digest()


def _compress_identical_siblings(
    directories: list[DirNode],
    config: Config,
    stats: Stats,
) -> None:
    if not config.bounded:
        return

    groups: dict[bytes, list[DirNode]] = {}
    for node in directories:
        fingerprint = _directory_layout_fingerprint(node)
        if fingerprint is not None:
            groups.setdefault(fingerprint, []).append(node)

    for group in groups.values():
        if len(group) < MIN_IDENTICAL_SIBLING_GROUP:
            continue
        expanded = _representative_sample(
            group,
            MAX_EXPANDED_IDENTICAL_SIBLINGS,
        )
        expanded_ids = {id(node) for node in expanded}
        for node in group:
            if id(node) in expanded_ids:
                continue
            folder_count, file_count = _known_descendant_counts(node)
            node.note = "repetitive contents not expanded"
            node.trimmed_folder_total = folder_count
            node.trimmed_file_total = file_count
            stats.collapsed += 1
            stats.repetitive_collapsed += 1


def _choose_with_priority(files: list[FileNode], limit: int) -> list[FileNode]:
    if len(files) <= limit:
        return files

    selected: list[FileNode] = []
    remaining = limit
    for priority in (3, 2, 1, 0):
        if remaining <= 0:
            break
        group = [item for item in files if item.priority == priority]
        chosen = _representative_sample(group, remaining)
        selected.extend(chosen)
        remaining -= len(chosen)

    selected.sort(key=lambda item: item.name.casefold())
    return selected


def _select_files(
    files: list[FileNode],
    config: Config,
) -> tuple[list[FileNode], list[SummaryNode], int]:
    if not config.bounded:
        return files, [], 0

    omitted = Counter()
    candidates: list[FileNode] = []
    categories = sorted({item.category for item in files if item.category})

    bulk_names: set[str] = set()
    for category in categories:
        group = [item for item in files if item.category == category]
        if len(group) <= config.max_bulk_files_per_category:
            chosen = group
        else:
            important = [item for item in group if item.priority >= 3]
            ordinary = [item for item in group if item.priority < 3]
            if len(important) >= config.max_bulk_files_per_category:
                chosen = _representative_sample(
                    important,
                    config.max_bulk_files_per_category,
                )
            else:
                chosen = [
                    *important,
                    *_representative_sample(
                        ordinary,
                        config.max_bulk_files_per_category - len(important),
                    ),
                ]
            omitted[category] += len(group) - len(chosen)
        candidates.extend(chosen)
        bulk_names.update(item.name for item in group)

    candidates.extend(item for item in files if item.name not in bulk_names)
    candidates.sort(key=lambda item: item.name.casefold())

    if len(candidates) > config.max_files_per_directory:
        selected = _choose_with_priority(candidates, config.max_files_per_directory)
        selected_names = {item.name for item in selected}
        for item in candidates:
            if item.name in selected_names:
                continue
            omitted[item.category or "file"] += 1
    else:
        selected = candidates

    notes: list[SummaryNode] = []
    category_order = [
        "image",
        "video",
        "audio",
        "font",
        "document",
        "archive",
        "database",
        "dataset",
        "model",
        "binary",
        "log",
        "file",
    ]
    for category in category_order:
        count = omitted.get(category, 0)
        if not count:
            continue
        if category == "file":
            notes.append(SummaryNode(f"[{count:,} more {_plural(count, 'file')}]"))
        else:
            notes.append(
                SummaryNode(
                    f"[{count:,} more {category} {_plural(count, 'file')}]"
                )
            )

    total_omitted = sum(omitted.values())
    return selected, notes, total_omitted


# ---------------------------------------------------------------------------
# Scan phase
# ---------------------------------------------------------------------------

def scan(
    directory: Path,
    config: Config,
    stats: Stats,
    context: ScanContext,
    depth: int = 1,
    on_progress: Optional[ProgressFn] = None,
) -> DirNode:
    stats.dirs_scanned += 1
    if on_progress:
        on_progress(stats.dirs_scanned, directory.name)

    node = DirNode(
        name=directory.name or _root_display_name(directory),
        path=directory,
    )

    try:
        raw_entries = list(directory.iterdir())
    except OSError:
        node.error = "permission denied"
        return node

    at_root = depth == 1
    visible_dirs: list[EntryInfo] = []
    visible_files: list[FileNode] = []
    hidden_dirs = 0
    hidden_files = 0

    for entry in _classify(raw_entries):
        if at_root and config.is_own_artefact(entry.path):
            continue

        if not config.show_hidden and entry.path.name.startswith("."):
            if entry.is_dir:
                hidden_dirs += 1
                stats.folders += 1
                stats.unlisted_dirs += 1
            else:
                hidden_files += 1
                stats.files += 1
                stats.total_bytes += _stat_file(entry.path)
                stats.unlisted_files += 1
            continue

        if entry.is_dir:
            stats.folders += 1
            visible_dirs.append(entry)
            continue

        size = _stat_file(entry.path)
        category = _file_category(entry.path.name)
        visible_files.append(
            FileNode(
                name=entry.path.name,
                size=size,
                category=category,
                priority=_file_priority(entry.path.name, category),
            )
        )
        stats.files += 1
        stats.total_bytes += size

    node.direct_folder_total = len(visible_dirs)
    node.direct_file_total = len(visible_files)
    node.direct_file_bytes = sum(item.size for item in visible_files)

    if hidden_dirs:
        node.dir_notes.append(
            SummaryNode(
                f"[{hidden_dirs:,} hidden {_plural(hidden_dirs, 'folder')} not listed]"
            )
        )

    selected_files, file_notes, unlisted_file_count = _select_files(
        visible_files,
        config,
    )
    node.files.extend(selected_files)
    node.file_notes.extend(file_notes)
    if unlisted_file_count:
        stats.unlisted_files += unlisted_file_count

    if hidden_files:
        node.file_notes.append(
            SummaryNode(
                f"[{hidden_files:,} hidden {_plural(hidden_files, 'file')} not listed]"
            )
        )

    scanned_dirs: list[DirNode] = []
    for entry in visible_dirs:
        if entry.is_link:
            stats.collapsed += 1
            scanned_dirs.append(
                DirNode(
                    name=entry.path.name,
                    path=entry.path,
                    note="link not followed",
                    entry_count=_direct_entry_count(entry.path),
                )
            )
            continue

        if config.is_collapsed(entry.path):
            stats.collapsed += 1
            scanned_dirs.append(
                DirNode(
                    name=entry.path.name,
                    path=entry.path,
                    note="not expanded",
                    entry_count=_direct_entry_count(entry.path),
                )
            )
            continue

        if config.max_depth > 0 and depth >= config.max_depth:
            stats.collapsed += 1
            scanned_dirs.append(
                DirNode(
                    name=entry.path.name,
                    path=entry.path,
                    note="depth limit",
                    entry_count=_direct_entry_count(entry.path),
                )
            )
            continue

        display_path = _relative_display(entry.path, config.target)
        duplicate_of = context.register(entry.path, display_path)
        if duplicate_of is not None:
            stats.collapsed += 1
            scanned_dirs.append(
                DirNode(
                    name=entry.path.name,
                    path=entry.path,
                    note=f"same directory as {duplicate_of}",
                    entry_count=_direct_entry_count(entry.path),
                )
            )
            continue

        scanned_dirs.append(
            scan(
                entry.path,
                config,
                stats,
                context,
                depth + 1,
                on_progress,
            )
        )

    selected_dirs, unlisted_dirs = _select_directory_nodes(scanned_dirs, config)
    _compress_identical_siblings(selected_dirs, config, stats)
    node.dirs.extend(selected_dirs)
    if unlisted_dirs:
        stats.unlisted_dirs += len(unlisted_dirs)
        unlisted_file_total = sum(
            _known_descendant_counts(child)[1] for child in unlisted_dirs
        )
        detail = (
            f"; {unlisted_file_total:,} "
            f"{_plural(unlisted_file_total, 'file')} beneath them"
            if unlisted_file_total
            else ""
        )
        node.dir_notes.append(
            SummaryNode(
                f"[{len(unlisted_dirs):,} more child "
                f"{_plural(len(unlisted_dirs), 'folder')} not expanded{detail}]"
            )
        )

    return node


# ---------------------------------------------------------------------------
# Render and global line-budget policy
# ---------------------------------------------------------------------------

def _annotation(node: DirNode) -> str:
    if node.note:
        if node.trimmed_folder_total or node.trimmed_file_total:
            parts: list[str] = [node.note]
            if node.trimmed_folder_total:
                parts.append(
                    f"{node.trimmed_folder_total:,} "
                    f"{_plural(node.trimmed_folder_total, 'folder')}"
                )
            if node.trimmed_file_total:
                parts.append(
                    f"{node.trimmed_file_total:,} "
                    f"{_plural(node.trimmed_file_total, 'file')}"
                )
            return f"  [{', '.join(parts)}]"
        if node.entry_count >= 0:
            return (
                f"  [{node.note}, {node.entry_count:,} "
                f"{_plural(node.entry_count, 'entry', 'entries')}]"
            )
        return f"  [{node.note}]"

    parts: list[str] = []
    if node.direct_folder_total:
        parts.append(
            f"{node.direct_folder_total:,} "
            f"{_plural(node.direct_folder_total, 'folder')}"
        )
    if node.direct_file_total:
        parts.append(
            f"{node.direct_file_total:,} "
            f"{_plural(node.direct_file_total, 'file')}"
        )
    if node.direct_file_bytes:
        parts.append(_human_size(node.direct_file_bytes))
    return f"  ({', '.join(parts)})" if parts else ""


def _render_line_count(node: DirNode, depth: int = 1) -> int:
    if node.error:
        return 1

    children: list[DirNode | FileNode | SummaryNode] = [
        *node.dirs,
        *node.dir_notes,
        *node.files,
        *node.file_notes,
    ]
    count = len(children)
    breathe = (
        depth <= BREATHE_MAX_DEPTH
        and node.direct_folder_total >= BREATHE_MIN_DIRS
    )
    previous_was_dir = False

    if breathe and node.dirs:
        count += 1

    for child in children:
        if breathe and previous_was_dir:
            count += 1
        if isinstance(child, DirNode):
            if not child.note:
                count += _render_line_count(child, depth + 1)
            previous_was_dir = True
        else:
            previous_was_dir = False

    return count


def render_tree(node: DirNode, prefix: str = "", depth: int = 1) -> list[str]:
    lines: list[str] = []

    if node.error:
        lines.append(f"{prefix}{TEE}{DASH}{DASH} [{node.error}]")
        return lines

    children: list[DirNode | FileNode | SummaryNode] = [
        *node.dirs,
        *node.dir_notes,
        *node.files,
        *node.file_notes,
    ]
    breathe = (
        depth <= BREATHE_MAX_DEPTH
        and node.direct_folder_total >= BREATHE_MIN_DIRS
    )
    previous_was_dir = False

    if breathe and node.dirs:
        lines.append(f"{prefix}{PIPE}" if prefix else PIPE)

    for index, child in enumerate(children):
        is_last = index == len(children) - 1
        connector = f"{ELBOW}{DASH}{DASH} " if is_last else f"{TEE}{DASH}{DASH} "
        extension = "    " if is_last else f"{PIPE}   "

        if breathe and previous_was_dir:
            lines.append(f"{prefix}{PIPE}" if prefix else PIPE)

        if isinstance(child, DirNode):
            lines.append(
                f"{prefix}{connector}{FOLDER} {child.name}/{_annotation(child)}"
            )
            if not child.note:
                lines.extend(render_tree(child, prefix + extension, depth + 1))
            previous_was_dir = True
        elif isinstance(child, FileNode):
            lines.append(f"{prefix}{connector}{child.name}")
            previous_was_dir = False
        else:
            lines.append(f"{prefix}{connector}{child.label}")
            previous_was_dir = False

    return lines


def _visible_file_count(node: DirNode) -> int:
    count = len(node.files)
    for child in node.dirs:
        if not child.note:
            count += _visible_file_count(child)
    return count


def _visible_collapsed_counts(node: DirNode) -> tuple[int, int, int]:
    collapsed = 0
    repetitive = 0
    budget = 0
    for child in node.dirs:
        if child.note:
            collapsed += 1
            if child.note == "repetitive contents not expanded":
                repetitive += 1
            elif child.note == "trimmed to line limit":
                budget += 1
        else:
            child_collapsed, child_repetitive, child_budget = (
                _visible_collapsed_counts(child)
            )
            collapsed += child_collapsed
            repetitive += child_repetitive
            budget += child_budget
    return collapsed, repetitive, budget


def _reconcile_output_stats(root: DirNode, stats: Stats) -> None:
    stats.unlisted_files = max(0, stats.files - _visible_file_count(root))
    collapsed, repetitive, budget = _visible_collapsed_counts(root)
    stats.collapsed = collapsed
    stats.repetitive_collapsed = repetitive
    stats.budget_collapsed = budget


def _known_descendant_counts(node: DirNode) -> tuple[int, int]:
    folder_count = node.direct_folder_total
    file_count = node.direct_file_total
    for child in node.dirs:
        if child.note:
            if child.trimmed_folder_total or child.trimmed_file_total:
                folder_count += child.trimmed_folder_total
                file_count += child.trimmed_file_total
            continue
        child_folders, child_files = _known_descendant_counts(child)
        folder_count += child_folders
        file_count += child_files
    return folder_count, file_count


def _candidate_tier(node: DirNode, depth: int, path_parts: tuple[str, ...]) -> int:
    lowered_parts = tuple(part.casefold() for part in path_parts)
    low_value = any(part in LOW_VALUE_DIRECTORY_HINTS for part in lowered_parts)
    protected = node.name.casefold() in GLOBAL_PROTECTED_DIRECTORY_NAMES

    if low_value and depth >= 2:
        return 0
    if low_value and depth == 1:
        return 1
    if not protected and depth >= 4:
        return 2
    if not protected and depth == 3:
        return 3
    if not protected and depth == 2:
        return 4
    if protected and depth >= 4:
        return 5
    if protected and depth == 3:
        return 6
    if protected and depth == 2:
        return 7
    if not protected and depth == 1:
        return 8
    return 9


def _collect_prune_candidates(
    node: DirNode,
    depth: int = 0,
    path_parts: tuple[str, ...] = (),
) -> list[PruneCandidate]:
    candidates: list[PruneCandidate] = []
    for child in node.dirs:
        child_depth = depth + 1
        child_parts = (*path_parts, child.name)
        if child.note or child.error:
            continue

        savings = _render_line_count(child, depth=child_depth + 1)
        if savings > 0:
            relative_path = "/".join(child_parts)
            candidates.append(
                PruneCandidate(
                    node=child,
                    depth=child_depth,
                    relative_path=relative_path,
                    savings=savings,
                    tier=_candidate_tier(child, child_depth, child_parts),
                )
            )

        candidates.extend(
            _collect_prune_candidates(child, child_depth, child_parts)
        )
    return candidates


def _enforce_global_budget(root: DirNode, config: Config, stats: Stats) -> None:
    if not config.bounded:
        return

    # Code fence, six header rows, blank lines, root line, and closing fence.
    fixed_document_overhead = 11
    target_tree_lines = max(1, config.max_document_lines - fixed_document_overhead)

    while _render_line_count(root) > target_tree_lines:
        candidates = _collect_prune_candidates(root)
        if not candidates:
            break

        candidates.sort(
            key=lambda candidate: (
                candidate.tier,
                -candidate.savings,
                -candidate.depth,
                candidate.relative_path.casefold(),
            )
        )
        chosen = candidates[0]
        folder_count, file_count = _known_descendant_counts(chosen.node)
        chosen.node.note = "trimmed to line limit"
        chosen.node.trimmed_folder_total = folder_count
        chosen.node.trimmed_file_total = file_count
        stats.collapsed += 1
        stats.budget_collapsed += 1


def render_header(
    folder_name: str,
    target: Path,
    max_depth: int,
    elapsed: float,
) -> list[str]:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    line1 = f"  {folder_name}"
    line2 = "  " + str(target).replace("\\", "/")
    metadata = [f"Scanned: {now}", f"Took: {elapsed:.2f}s"]
    if max_depth:
        metadata.append(f"Depth: {max_depth}")
    line3 = f"  {'  |  '.join(metadata)}"
    width = max(len(line1), len(line2), len(line3)) + 4
    bar = DASH * width
    return [
        f"{BOX_TL}{bar}{BOX_TR}",
        f"{PIPE}{line1:<{width}}{PIPE}",
        f"{PIPE}{line2:<{width}}{PIPE}",
        f"{BOX_L_TEE}{bar}{BOX_R_TEE}",
        f"{PIPE}{line3:<{width}}{PIPE}",
        f"{ELBOW}{bar}{BOX_BR}",
    ]


def assemble_document(
    folder_name: str,
    target: Path,
    config: Config,
    tree_lines: list[str],
    elapsed: float,
    stats: Stats,
) -> str:
    header = render_header(folder_name, target, config.max_depth, elapsed)
    extras: list[str] = []
    if stats.collapsed:
        extras.append(
            f"{stats.collapsed:,} {_plural(stats.collapsed, 'folder')} not expanded"
        )
    if stats.unlisted_dirs:
        extras.append(
            f"{stats.unlisted_dirs:,} {_plural(stats.unlisted_dirs, 'folder')} not listed"
        )
    if stats.unlisted_files:
        extras.append(
            f"{stats.unlisted_files:,} {_plural(stats.unlisted_files, 'file')} not listed"
        )
    suffix = f"; {', '.join(extras)}" if extras else ""
    root_annotation = (
        f"  (Total: {stats.folders:,} {_plural(stats.folders, 'folder')}, "
        f"{stats.files:,} {_plural(stats.files, 'file')}, "
        f"{_human_size(stats.total_bytes)}{suffix})"
    )
    parts = [
        "```",
        *header,
        "",
        f"{FOLDER} {folder_name}/{root_annotation}",
        *tree_lines,
        "```",
        "",
    ]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# CLI / IO
# ---------------------------------------------------------------------------

def _parse_positive_int(value: str, fallback: int) -> int:
    try:
        parsed = int(value)
    except ValueError:
        return fallback
    return max(1, parsed)


def parse_args(argv: list[str], default_path: Path) -> Config:
    path: Optional[Path] = None
    depth = 0
    show_hidden = True
    clipboard = False
    bounded = True
    collapsed_names = DEFAULT_COLLAPSED_NAMES
    max_lines = MAX_DOCUMENT_LINES
    max_dirs = MAX_DIRECTORIES_PER_DIRECTORY
    max_files = MAX_FILES_PER_DIRECTORY
    max_bulk = MAX_BULK_FILES_PER_CATEGORY

    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        if argument == "--path" and index + 1 < len(argv):
            path = Path(argv[index + 1])
            index += 2
            continue
        if argument == "--depth" and index + 1 < len(argv):
            try:
                depth = max(0, int(argv[index + 1]))
            except ValueError:
                pass
            index += 2
            continue
        if argument in ("--no-hidden", "--nohidden"):
            show_hidden = False
        elif argument == "--hidden":
            show_hidden = True
        elif argument == "--clipboard":
            clipboard = True
        elif argument == "--expand":
            collapsed_names = frozenset()
        elif argument in ("--unbounded", "--full"):
            bounded = False
        elif argument == "--all":
            bounded = False
            collapsed_names = frozenset()
        elif argument == "--max-lines" and index + 1 < len(argv):
            max_lines = _parse_positive_int(argv[index + 1], max_lines)
            index += 2
            continue
        elif argument == "--max-dirs" and index + 1 < len(argv):
            max_dirs = _parse_positive_int(argv[index + 1], max_dirs)
            index += 2
            continue
        elif argument == "--max-files" and index + 1 < len(argv):
            max_files = _parse_positive_int(argv[index + 1], max_files)
            index += 2
            continue
        elif argument == "--max-bulk" and index + 1 < len(argv):
            max_bulk = _parse_positive_int(argv[index + 1], max_bulk)
            index += 2
            continue
        elif argument == "--no-ignore":
            # Accepted as a backward-compatible no-op. Ignore files are never
            # read by this version.
            pass
        elif path is None and not argument.startswith("-"):
            path = Path(argument)
        index += 1

    target = path or default_path
    try:
        target = target.resolve()
    except Exception as exc:
        print(f"\n  {RED}{PIPE}{RESET} Failed to resolve target: {exc}")
        raise SystemExit(1) from exc

    if bounded:
        max_lines = max(MIN_DOCUMENT_LINES, max_lines)
        max_dirs = min(max_dirs, max(1, max_lines // 6))
        max_files = min(max_files, max(1, max_lines // 2))
        max_bulk = min(max_bulk, max_files)

    return Config(
        target=target,
        max_depth=depth,
        show_hidden=show_hidden,
        collapsed_names=collapsed_names,
        clipboard=clipboard,
        output_name="" if clipboard else f"{_root_display_name(target)}_dir_tree.md",
        bounded=bounded,
        max_document_lines=max_lines,
        max_directories_per_directory=max_dirs,
        max_files_per_directory=max_files,
        max_bulk_files_per_category=max_bulk,
    )


def _console_progress(dirs_done: int, label: str) -> None:
    frame = SPINNER[dirs_done % len(SPINNER)]
    name = f"  {DIM}{label}{RESET}" if label else ""
    sys.stdout.write(
        f"\r  {CYAN}{frame}{RESET}  {dirs_done:,} dirs scanned{name}    "
    )
    sys.stdout.flush()


def main() -> None:
    config = parse_args(sys.argv, Path(__file__).parent)

    if not config.target.exists():
        message = f"Target not found: {config.target}"
        if config.clipboard:
            _show_clipboard_error(message)
            raise SystemExit(1)
        _con_warn(message)
        return
    if not config.target.is_dir():
        message = f"Target is not a directory: {config.target}"
        if config.clipboard:
            _show_clipboard_error(message)
            raise SystemExit(1)
        _con_warn(message)
        return

    folder_name = _root_display_name(config.target)
    stats = Stats()
    context = ScanContext(config.target)
    context.register(config.target, ".")

    if not config.clipboard:
        banner = ["dir_tree", "", f"  {config.target}"]
        if config.max_depth:
            banner.append(f"  Depth limit: {config.max_depth}")
        if not config.show_hidden:
            banner.append("  Hidden entries: not listed")
        if not config.collapsed_names:
            banner.append("  Known low-value directories: expanded")
        if config.bounded:
            banner.append(
                f"  Output: <= {config.max_document_lines:,} lines; "
                f"{config.max_directories_per_directory} folders / "
                f"{config.max_files_per_directory} files per directory"
            )
        else:
            banner.append("  Output limits: disabled")
        print()
        _con_box(banner)
        print()

    start = time.perf_counter()
    root = scan(
        config.target,
        config,
        stats,
        context,
        on_progress=None if config.clipboard else _console_progress,
    )
    _enforce_global_budget(root, config, stats)
    _reconcile_output_stats(root, stats)
    elapsed = time.perf_counter() - start

    if not config.clipboard:
        sys.stdout.write("\r" + " " * 100 + "\r")
        sys.stdout.flush()

    tree_lines = render_tree(root)
    document = assemble_document(
        folder_name,
        config.target,
        config,
        tree_lines,
        elapsed,
        stats,
    )

    # The pruning calculation includes a conservative fixed overhead. This is a
    # final invariant check rather than a second truncation mechanism.
    if config.bounded and len(document.splitlines()) > config.max_document_lines:
        raise RuntimeError(
            f"Internal line-budget failure: generated {len(document.splitlines()):,} "
            f"lines with a limit of {config.max_document_lines:,}"
        )

    if config.clipboard:
        try:
            _copy_text_to_clipboard(document)
        except Exception as exc:
            _show_clipboard_error(f"Failed to copy directory tree:\n\n{exc}")
            raise SystemExit(1) from exc
        return

    output = config.target / f"{folder_name}_dir_tree.md"
    try:
        output.write_text(document, encoding="utf-8")
    except Exception as exc:
        _con_warn(f"Failed to write output: {exc}")
        return

    _con_divider()
    _con_kv("Folders", f"{stats.folders:,}")
    _con_kv("Files", f"{stats.files:,}")
    _con_kv("Size", _human_size(stats.total_bytes))
    _con_kv("Lines", f"{len(document.splitlines()):,}")
    if stats.collapsed:
        _con_kv("Not expanded", f"{stats.collapsed:,} folder(s)")
    if stats.unlisted_dirs:
        _con_kv("Folders hidden", f"{stats.unlisted_dirs:,}")
    if stats.unlisted_files:
        _con_kv("Not listed", f"{stats.unlisted_files:,} file(s)")
    if stats.repetitive_collapsed:
        _con_kv("Pattern-folded", f"{stats.repetitive_collapsed:,} branch(es)")
    if stats.budget_collapsed:
        _con_kv("Line-trimmed", f"{stats.budget_collapsed:,} branch(es)")
    _con_kv("Time", f"{elapsed:.2f}s")
    _con_divider()
    print()
    _con_ok(f"Saved to {output}")
    print()


if __name__ == "__main__":
    clipboard_mode = "--clipboard" in sys.argv[1:]
    try:
        main()
    except KeyboardInterrupt:
        if not clipboard_mode:
            print(f"\n\n  {DIM}Cancelled.{RESET}\n")
    except Exception as exc:
        if clipboard_mode:
            _show_clipboard_error(f"Copy directory tree failed:\n\n{exc}")
            raise SystemExit(1) from exc
        traceback.print_exc()
    finally:
        if not clipboard_mode:
            try:
                input(f"  {DIM}Press Enter to close...{RESET}")
            except EOFError:
                pass
