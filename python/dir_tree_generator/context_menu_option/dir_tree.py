# -*- coding: utf-8 -*-
"""
dir_tree.py - recursive directory tree generator (double-click friendly)

Scans a target folder recursively and generates a markdown directory tree
with box-drawing characters, inline folder annotations, and a boxed header.

Features
  - Curved box-drawing connectors with pipe-separated top-level sections.
  - Folder icons with inline child counts and sizes per directory.
  - Boxed header with folder name, path, scan timestamp, elapsed time,
    and summary totals. Same totals repeated in footer.
  - Sorts directories first, then files, case-insensitive.
  - Never omits anything silently. Heavy directories (node_modules, .git,
    virtualenvs, tool caches) are listed but not descended into, tagged with
    their direct entry count. Symlinked and ignore-matched directories are
    listed the same way rather than disappearing.
  - Hidden entries are included by default. --no-hidden suppresses them and
    reports the per-directory count instead of dropping them silently.
  - Self-excludes only its own file and the output file it is about to
    write, matched by path rather than by name.
  - Configurable max depth (default unlimited).
  - Discovers .*ignore files (e.g. .gitignore, .cursorignore) and excludes
    matching paths. Requires pathspec (pip install pathspec). Use --no-ignore
    to bypass. Also supports a .treeignore for tree-specific exclusions.
  - Interactive prompt when a directory exceeds TRUNCATE_THRESHOLD in normal
    file-output mode. Clipboard mode is non-interactive and scans in full.
  - Progress indicator during normal scans.
  - Can copy the complete generated markdown directly to the Windows clipboard.
  - Single stat() per file, single iterdir() per directory - no redundant I/O.
  - Handles UNC paths and drive roots.
  - Waits for Enter before exit so double-click works on Windows.

Output
  Default: saved as [foldername]_dir_tree.md in the target folder.
  --clipboard: copied to the Windows clipboard; no output file is written.

Usage
  Double-click to scan the folder it lives in, or:
    python dir_tree.py --path "X:/Projects" --depth 4 --expand --no-ignore
    pythonw dir_tree.py --clipboard --path "X:/Projects"
"""
from __future__ import annotations

import os
import re
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional, Tuple

try:
    import pathspec as _pathspec
except ImportError:
    _pathspec = None

os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------------------
# Box-drawing characters (escaped so the source file stays pure ASCII)
# ---------------------------------------------------------------------------

PIPE      = "\u2502"   # vertical
TEE       = "\u251c"   # tee right
ELBOW     = "\u2570"   # curved elbow
DASH      = "\u2500"   # horizontal
BOX_TL    = "\u256d"   # top-left corner
BOX_TR    = "\u256e"   # top-right corner
BOX_BL    = "\u2570"   # bottom-left corner
BOX_BR    = "\u256f"   # bottom-right corner
BOX_L_TEE = "\u251c"   # left tee (divider)
BOX_R_TEE = "\u2524"   # right tee (divider)
FOLDER    = "\U0001f4c1"  # folder emoji


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Directories that are listed but not descended into. Nothing here is
# dropped: a collapsed directory still appears in the tree, tagged with its
# reason and direct entry count. Only genuinely unbounded trees belong here -
# anything small enough to read is structure, not noise.
DEFAULT_COLLAPSED: frozenset[str] = frozenset({
    "node_modules", ".git", ".svn", ".hg",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache",
})

TRUNCATE_THRESHOLD = 50
BREATHE_MAX_DEPTH  = 99
BREATHE_MIN_DIRS   = 0
try:
    SCRIPT_PATH    = Path(__file__).resolve()
except OSError:
    SCRIPT_PATH    = Path(__file__)
IGNORE_RE          = re.compile(r"^\..+ignore$")

ProgressFn = Callable[[int, str], None]
TruncateFn = Callable[[Path, int], bool]


# ---------------------------------------------------------------------------
# Data model - scan phase produces this, render phase consumes it
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Config:
    target: Path
    max_depth: int = 0
    show_hidden: bool = True
    use_ignore: bool = True
    collapsed: frozenset[str] = DEFAULT_COLLAPSED
    clipboard: bool = False
    output_name: str = ""

    def is_collapsed(self, name: str) -> bool:
        return name in self.collapsed

    def is_own_artefact(self, entry: Path) -> bool:
        """This script and the file this run is about to write - root only."""
        if self.output_name and entry.name == self.output_name:
            return True
        if entry.name != SCRIPT_PATH.name:
            return False
        try:
            return entry.resolve() == SCRIPT_PATH
        except OSError:
            return False


@dataclass(frozen=True)
class FileNode:
    name: str
    size: int = 0


@dataclass(frozen=True)
class SkipNote:
    """Rendered as a trailing pseudo-child summarising unlisted files."""
    hidden: int = 0
    ignored: int = 0

    @property
    def count(self) -> int:
        return self.hidden + self.ignored

    def label(self) -> str:
        unit = "file" if self.count == 1 else "files"
        if self.hidden and self.ignored:
            why = "hidden or ignored"
        elif self.hidden:
            why = "hidden"
        else:
            why = "ignore-matched"
        return f"[{self.count} {unit} {why}]"


@dataclass
class DirNode:
    name: str
    path: Path
    dirs: list[DirNode] = field(default_factory=list)
    files: list[FileNode] = field(default_factory=list)
    error: str = ""
    truncated_count: int = 0
    note: str = ""           # why this directory was not descended into
    entry_count: int = -1    # direct entries inside a collapsed directory
    hidden_files: int = 0    # files suppressed by --no-hidden
    ignored_files: int = 0   # files matched by an ignore rule

    @property
    def direct_file_bytes(self) -> int:
        return sum(f.size for f in self.files)

    @property
    def direct_folder_count(self) -> int:
        return len(self.dirs)

    @property
    def direct_file_count(self) -> int:
        return len(self.files)


@dataclass
class Stats:
    folders: int = 0
    files: int = 0
    total_bytes: int = 0
    dirs_scanned: int = 0
    collapsed: int = 0
    skipped_files: int = 0



class IgnoreFilter:
    """Discovers .*ignore files during scan and matches paths against them.

    Patterns are scoped by ancestry. collect() pushes specs onto a stack
    and returns the count added; pop() trims them back when leaving a
    directory, so sibling branches never see each other's ignore rules.
    """

    def __init__(self) -> None:
        self._specs: list[tuple[Path, _pathspec.PathSpec]] = []
        self.discovered: list[tuple[Path, str]] = []

    @staticmethod
    def available() -> bool:
        return _pathspec is not None

    def collect(self, directory: Path, entries: list[Path]) -> int:
        """Scan a directory's entries for ignore files and parse them.

        Returns the number of specs added (used by pop() to unwind).
        """
        added = 0
        for entry in entries:
            if not entry.is_file() or not IGNORE_RE.match(entry.name):
                continue
            try:
                text = entry.read_text(encoding="utf-8", errors="replace")
                spec = _pathspec.PathSpec.from_lines("gitwildmatch", text.splitlines())
                self._specs.append((directory, spec))
                self.discovered.append((entry, entry.name))
                added += 1
            except Exception:
                pass
        return added

    def pop(self, count: int) -> None:
        """Remove the last `count` specs from the stack."""
        if count > 0:
            del self._specs[-count:]

    def is_ignored(self, entry: Path, is_dir: bool = False) -> bool:
        """Check if a path matches any accumulated ignore pattern."""
        for base_dir, spec in self._specs:
            try:
                rel_str = entry.relative_to(base_dir).as_posix()
            except ValueError:
                continue
            if is_dir:
                rel_str += "/"
            if spec.match_file(rel_str):
                return True
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _human_size(b: int) -> str:
    for unit, divisor in [("TB", 1 << 40), ("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)]:
        if b >= divisor:
            if unit in ("TB", "GB"):
                return f"{b / divisor:.2f} {unit}"
            return f"{b // divisor} {unit}"
    return f"{b} bytes"


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
    """One-level count for a directory that will not be descended into."""
    try:
        with os.scandir(path) as it:
            return sum(1 for _ in it)
    except OSError:
        return -1


def _skip_reason(
    entry: Path,
    is_dir: bool,
    is_link: bool,
    config: Config,
    ignore_filter: Optional[IgnoreFilter],
    at_root: bool,
) -> str:
    """"" to include, "self" to drop silently, otherwise a display reason."""
    if at_root and config.is_own_artefact(entry):
        return "self"
    if not config.show_hidden and entry.name.startswith("."):
        return "hidden"
    if ignore_filter and ignore_filter.is_ignored(entry, is_dir=is_dir):
        return "ignored"
    if is_dir and is_link:
        return "symlink"
    if is_dir and config.is_collapsed(entry.name):
        return "not expanded"
    return ""


def _classify(entries: list[Path]) -> list[tuple[Path, bool, bool]]:
    """Resolve is_dir/is_symlink once per entry, then sort dirs first."""
    out: list[tuple[Path, bool, bool]] = []
    for entry in entries:
        try:
            out.append((entry, entry.is_dir(), entry.is_symlink()))
        except OSError:
            continue
    out.sort(key=lambda t: (not t[1], t[0].name.lower()))
    return out


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
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
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
        0, "STATIC", "dir_tree clipboard owner", 0,
        0, 0, 0, 0, None, None, None, None,
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

        # Clipboard ownership of the allocated memory transfers to Windows.
        memory = None
    finally:
        if clipboard_open:
            user32.CloseClipboard()
        if memory:
            kernel32.GlobalFree(memory)
        user32.DestroyWindow(owner)


def _show_clipboard_error(message: str) -> None:
    """Show an error only when running as a windowless context-menu command."""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "Copy directory tree", 0x10)
            return
        except Exception:
            pass
    try:
        print(message, file=sys.stderr)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Console chrome - polished terminal output using box-drawing characters
# ---------------------------------------------------------------------------

def _enable_ansi() -> bool:
    """Try to enable VT processing on Windows. Returns True if ANSI is usable."""
    if sys.platform != "win32":
        return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        STD_OUTPUT_HANDLE = -11
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        handle = k32.GetStdHandle(STD_OUTPUT_HANDLE)
        mode = ctypes.c_ulong()
        if k32.GetConsoleMode(handle, ctypes.byref(mode)):
            k32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
            return True
    except Exception:
        pass
    return False


_ANSI = _enable_ansi()

SPINNER = ["\u2838", "\u2834", "\u2826", "\u2807", "\u280b", "\u2819", "\u2830", "\u2838"]

if _ANSI:
    DIM    = "\033[2m"
    BOLD   = "\033[1m"
    RESET  = "\033[0m"
    CYAN   = "\033[36m"
    GREEN  = "\033[32m"
    YELLOW = "\033[33m"
    RED    = "\033[31m"
    WHITE  = "\033[37m"
else:
    DIM = BOLD = RESET = CYAN = GREEN = YELLOW = RED = WHITE = ""


_ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def _visible_len(s: str) -> int:
    """Length of a string excluding ANSI escape sequences."""
    return len(_ANSI_RE.sub("", s))


def _con_box(lines: list[str], *, colour: str = CYAN) -> None:
    """Print lines inside a rounded box with optional colour."""
    width = max(_visible_len(line) for line in lines) + 2
    bar = DASH * width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")
    for line in lines:
        pad = width - 1 - _visible_len(line)
        print(f"  {colour}{PIPE}{RESET} {line}{' ' * pad}{colour}{PIPE}{RESET}")
    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")


def _con_divider(width: int = 48) -> None:
    print(f"  {DIM}{DASH * width}{RESET}")


def _con_kv(key: str, value: str) -> None:
    print(f"  {DIM}{key:<10}{RESET} {value}")


def _con_prompt(label: str, options: str) -> str:
    return input(f"  {YELLOW}{PIPE}{RESET} {label} {DIM}{options}{RESET} ").strip().lower()


def _con_warn(msg: str) -> None:
    print(f"\n  {RED}{PIPE}{RESET} {msg}")


def _con_ok(msg: str) -> None:
    print(f"  {GREEN}{PIPE}{RESET} {msg}")


# ---------------------------------------------------------------------------
# Scan phase - builds a tree of DirNode/FileNode, accumulates Stats
# ---------------------------------------------------------------------------

def scan(
    directory: Path,
    config: Config,
    stats: Stats,
    depth: int = 1,
    on_progress: Optional[ProgressFn] = None,
    on_truncate: Optional[TruncateFn] = None,
    ignore_filter: Optional[IgnoreFilter] = None,
) -> DirNode:
    stats.dirs_scanned += 1
    if on_progress:
        on_progress(stats.dirs_scanned, directory.name)

    node = DirNode(name=directory.name or _root_display_name(directory), path=directory)

    try:
        raw = list(directory.iterdir())
    except OSError:
        node.error = "permission denied"
        return node

    # Discover ignore files from this directory's entries (push)
    ignore_added = 0
    if ignore_filter:
        ignore_added = ignore_filter.collect(directory, raw)

    if len(raw) > TRUNCATE_THRESHOLD and on_truncate and on_truncate(directory, len(raw)):
        node.truncated_count = len(raw)
        if ignore_filter:
            ignore_filter.pop(ignore_added)
        return node

    at_root = depth == 1

    for entry, is_dir, is_link in _classify(raw):
        reason = _skip_reason(entry, is_dir, is_link, config, ignore_filter, at_root)

        if reason == "self":
            continue

        if not is_dir:
            if reason:
                if reason == "hidden":
                    node.hidden_files += 1
                else:
                    node.ignored_files += 1
                stats.skipped_files += 1
                continue
            stats.files += 1
            size = _stat_file(entry)
            stats.total_bytes += size
            node.files.append(FileNode(entry.name, size))
            continue

        stats.folders += 1

        if reason:
            stats.collapsed += 1
            node.dirs.append(DirNode(
                name=entry.name,
                path=entry,
                note=reason,
                entry_count=-1 if is_link else _direct_entry_count(entry),
            ))
            continue

        beyond_limit = config.max_depth > 0 and depth >= config.max_depth
        child = (
            _scan_shallow(entry, config, stats, ignore_filter)
            if beyond_limit
            else scan(entry, config, stats, depth + 1, on_progress, on_truncate, ignore_filter)
        )
        node.dirs.append(child)

    # Pop ignore specs added by this directory
    if ignore_filter:
        ignore_filter.pop(ignore_added)

    return node


def _scan_shallow(
    directory: Path,
    config: Config,
    stats: Stats,
    ignore_filter: Optional[IgnoreFilter] = None,
) -> DirNode:
    """Single-level enumeration for depth-limited directories."""
    node = DirNode(name=directory.name, path=directory)
    try:
        raw = list(directory.iterdir())
    except OSError:
        node.error = "permission denied"
        return node

    ignore_added = ignore_filter.collect(directory, raw) if ignore_filter else 0

    for entry, is_dir, is_link in _classify(raw):
        reason = _skip_reason(entry, is_dir, is_link, config, ignore_filter, False)

        if reason == "self":
            continue

        if not is_dir:
            if reason:
                if reason == "hidden":
                    node.hidden_files += 1
                else:
                    node.ignored_files += 1
                stats.skipped_files += 1
                continue
            stats.files += 1
            size = _stat_file(entry)
            stats.total_bytes += size
            node.files.append(FileNode(entry.name, size))
            continue

        stats.folders += 1
        child = DirNode(name=entry.name, path=entry, note=reason or "depth limit")
        stats.collapsed += 1
        child.entry_count = -1 if is_link else _direct_entry_count(entry)
        node.dirs.append(child)

    if ignore_filter:
        ignore_filter.pop(ignore_added)

    return node


# ---------------------------------------------------------------------------
# Render phase - transforms a DirNode tree into formatted text lines
# ---------------------------------------------------------------------------

def _annotation(node: DirNode) -> str:
    if node.note:
        if node.entry_count >= 0:
            unit = "entry" if node.entry_count == 1 else "entries"
            return f"  [{node.note}, {node.entry_count} {unit}]"
        return f"  [{node.note}]"

    parts: list[str] = []
    fc = node.direct_folder_count
    fi = node.direct_file_count
    sb = node.direct_file_bytes
    if fc:
        parts.append(f"{fc} folder{'s' if fc != 1 else ''}")
    if fi:
        parts.append(f"{fi} file{'s' if fi != 1 else ''}")
    if sb:
        parts.append(_human_size(sb))
    return f"  ({', '.join(parts)})" if parts else ""


def render_tree(node: DirNode, prefix: str = "", depth: int = 1) -> list[str]:
    lines: list[str] = []

    if node.error:
        lines.append(f"{prefix}{TEE}{DASH}{DASH} [{node.error}]")
        return lines

    if node.truncated_count:
        lines.append(f"{prefix}{TEE}{DASH}{DASH} [{node.truncated_count} entries]")
        return lines

    children: list[DirNode | FileNode | SkipNote] = [*node.dirs, *node.files]
    if node.hidden_files or node.ignored_files:
        children.append(SkipNote(node.hidden_files, node.ignored_files))
    breathe = depth <= BREATHE_MAX_DEPTH and node.direct_folder_count >= BREATHE_MIN_DIRS
    prev_was_dir = False

    # Separator between this folder's header and its first child
    if breathe and node.dirs:
        lines.append(f"{prefix}{PIPE}" if prefix else PIPE)

    for i, child in enumerate(children):
        is_last = i == len(children) - 1
        connector = f"{ELBOW}{DASH}{DASH} " if is_last else f"{TEE}{DASH}{DASH} "
        extension = "    " if is_last else f"{PIPE}   "

        if breathe and prev_was_dir:
            lines.append(f"{prefix}{PIPE}" if prefix else PIPE)

        if isinstance(child, DirNode):
            lines.append(f"{prefix}{connector}{FOLDER} {child.name}/{_annotation(child)}")
            if not child.note:
                lines.extend(render_tree(child, prefix + extension, depth + 1))
            prev_was_dir = True
        elif isinstance(child, SkipNote):
            lines.append(f"{prefix}{connector}{child.label()}")
            prev_was_dir = False
        else:
            lines.append(f"{prefix}{connector}{child.name}")
            prev_was_dir = False

    return lines


# ---------------------------------------------------------------------------
# Header / footer / document assembly
# ---------------------------------------------------------------------------

def render_header(
    folder_name: str,
    target: Path,
    max_depth: int,
    elapsed: float,
) -> list[str]:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    line1 = f"  {folder_name}"
    line2 = "  " + str(target).replace("\\", "/")
    meta = [f"Scanned: {now}", f"Took: {elapsed:.2f}s"]
    if max_depth:
        meta.append(f"Depth: {max_depth}")
    line3 = f"  {'  |  '.join(meta)}"
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
        extras.append(f"{stats.collapsed} not expanded")
    if stats.skipped_files:
        extras.append(f"{stats.skipped_files} not listed")
    suffix = f"; {', '.join(extras)}" if extras else ""
    folder_unit = "folder" if stats.folders == 1 else "folders"
    file_unit = "file" if stats.files == 1 else "files"
    root_annotation = (
        f"  (Total: {stats.folders} {folder_unit}, {stats.files} {file_unit}, "
        f"{_human_size(stats.total_bytes)}{suffix})"
    )
    parts = ["```", *header, "", f"{FOLDER} {folder_name}/{root_annotation}", *tree_lines, "```", ""]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# CLI / IO
# ---------------------------------------------------------------------------

def parse_args(argv: list[str], default_path: Path) -> Config:
    path: Path | None = None
    depth = 0
    show_hidden = True
    use_ignore = True
    clipboard = False
    collapsed = DEFAULT_COLLAPSED
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        elif a == "--path" and i + 1 < len(argv):
            path = Path(argv[i + 1])
            i += 1
        elif a == "--depth" and i + 1 < len(argv):
            try:
                depth = max(0, int(argv[i + 1]))
            except ValueError:
                pass
            i += 1
        elif a == "--hidden":
            show_hidden = True
        elif a in ("--no-hidden", "--nohidden"):
            show_hidden = False
        elif a in ("--expand", "--all"):
            collapsed = frozenset()
        elif a == "--no-ignore":
            use_ignore = False
        elif a == "--clipboard":
            clipboard = True
        elif path is None and not a.startswith("-"):
            path = Path(a)
        i += 1

    target = path or default_path
    try:
        target = target.resolve()
    except Exception as exc:
        print(f"\n  {RED}{PIPE}{RESET} Failed to resolve target: {exc}")
        sys.exit(1)

    return Config(
        target=target,
        max_depth=depth,
        show_hidden=show_hidden,
        use_ignore=use_ignore,
        collapsed=collapsed,
        clipboard=clipboard,
        output_name="" if clipboard else f"{_root_display_name(target)}_dir_tree.md",
    )


def _console_progress(dirs_done: int, label: str) -> None:
    frame = SPINNER[dirs_done % len(SPINNER)]
    name = f"  {DIM}{label}{RESET}" if label else ""
    sys.stdout.write(f"\r  {CYAN}{frame}{RESET}  {dirs_done} dirs scanned{name}    ")
    sys.stdout.flush()


def _make_truncate_prompt() -> TruncateFn:
    """Returns a stateful truncate callback.

    On first large directory, asks whether to apply a global answer
    (y/n for all) or choose individually per directory.
    """
    state: dict[str, object] = {"mode": None, "global_answer": None}

    def _prompt(dir_path: Path, count: int) -> bool:
        # Clear the progress line before prompting
        sys.stdout.write("\r" + " " * 80 + "\r")
        sys.stdout.flush()

        if state["mode"] is None:
            print()
            _con_box([
                f"Large directory detected",
                f"",
                f"  {dir_path.name}   {DIM}({count:,} entries){RESET}",
                f"",
                f"More large directories may follow.",
            ], colour=YELLOW)
            print()
            while True:
                choice = _con_prompt(
                    "Apply one answer to all, or decide per directory?",
                    "(g)lobal / (i)ndividual",
                )
                if choice in ("g", "global"):
                    state["mode"] = "global"
                    break
                if choice in ("i", "individual"):
                    state["mode"] = "individual"
                    break

            if state["mode"] == "global":
                while True:
                    answer = _con_prompt(
                        "List large directories in full?",
                        "(y)es, list all / (n)o, summary only",
                    )
                    if answer in ("y", "yes"):
                        state["global_answer"] = False
                        print()
                        return False
                    if answer in ("n", "no"):
                        state["global_answer"] = True
                        print()
                        return True

        if state["mode"] == "global":
            return state["global_answer"]

        print()
        print(f"  {YELLOW}{PIPE}{RESET} {dir_path.name}  {DIM}({count:,} entries){RESET}")
        while True:
            choice = _con_prompt("List all?", "(y)es / (n)o, summary only")
            if choice in ("y", "yes"):
                print()
                return False
            if choice in ("n", "no"):
                print()
                return True

    return _prompt


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

    # Set up ignore filter
    ignore_filter: Optional[IgnoreFilter] = None
    if config.use_ignore and IgnoreFilter.available():
        ignore_filter = IgnoreFilter()
    elif config.use_ignore and not IgnoreFilter.available() and not config.clipboard:
        _con_warn("pathspec not installed - ignore files will not be processed")
        print(f"  {DIM}pip install pathspec{RESET}")
        print()

    if not config.clipboard:
        banner = [f"dir_tree"]
        banner.append(f"")
        banner.append(f"  {str(config.target)}")
        if config.max_depth:
            banner.append(f"  Depth limit: {config.max_depth}")
        if not config.show_hidden:
            banner.append(f"  Hidden entries: suppressed")
        if not config.collapsed:
            banner.append(f"  Expanding all directories")
        if not config.use_ignore:
            banner.append(f"  Ignore files: disabled")
        print()
        _con_box(banner)
        print()

    t0 = time.perf_counter()
    root = scan(
        config.target, config, stats,
        on_progress=None if config.clipboard else _console_progress,
        on_truncate=None if config.clipboard else _make_truncate_prompt(),
        ignore_filter=ignore_filter,
    )
    elapsed = time.perf_counter() - t0

    if not config.clipboard:
        sys.stdout.write("\r" + " " * 80 + "\r")
        sys.stdout.flush()

        # Report discovered ignore files
        if ignore_filter and ignore_filter.discovered:
            names = sorted(set(name for _, name in ignore_filter.discovered))
            _con_kv("Ignoring", ", ".join(names))
            _con_kv("", f"{DIM}{len(ignore_filter.discovered)} file(s) across tree{RESET}")
            print()

    tree_lines = render_tree(root)
    document = assemble_document(folder_name, config.target, config, tree_lines, elapsed, stats)

    if config.clipboard:
        try:
            _copy_text_to_clipboard(document)
        except Exception as exc:
            _show_clipboard_error(f"Failed to copy directory tree:\n\n{exc}")
            raise SystemExit(1)
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
    if stats.collapsed:
        _con_kv("Collapsed", f"{stats.collapsed:,} folder(s) not expanded")
    if stats.skipped_files:
        _con_kv("Not listed", f"{stats.skipped_files:,} file(s)")
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
            raise SystemExit(1)
        traceback.print_exc()
    finally:
        if not clipboard_mode:
            input(f"  {DIM}Press Enter to close...{RESET}")