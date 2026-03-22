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
  - Skips hidden files/folders (dotfiles), symlinks, and common noise
    directories (node_modules, __pycache__, .git, etc.).
  - Self-excludes its own .py file and previous _dir_tree.md output.
  - Configurable max depth (default unlimited).
  - Interactive prompt when a directory exceeds TRUNCATE_THRESHOLD.
  - Progress indicator during scan.
  - Single stat() per file, single iterdir() per directory - no redundant I/O.
  - Handles UNC paths and drive roots.
  - Waits for Enter before exit so double-click works on Windows.

Output
  Saved as [foldername]_dir_tree.md in the target folder.

Usage
  Double-click to scan the folder it lives in, or:
    python dir_tree.py --path "X:/Projects" --depth 4 --hidden
"""
from __future__ import annotations

import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional, Tuple

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
BOX_BR    = "\u256f"   # bottom-right corner
BOX_L_TEE = "\u251c"   # left tee (divider)
BOX_R_TEE = "\u2524"   # right tee (divider)
FOLDER    = "\U0001f4c1"  # folder emoji


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_EXCLUDED: frozenset[str] = frozenset({
    "node_modules", "__pycache__", ".git", ".svn", ".hg",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".idea", ".vscode", "dist", "build",
    ".DS_Store", "Thumbs.db",
})

TRUNCATE_THRESHOLD = 5000
BREATHE_MAX_DEPTH  = 99
BREATHE_MIN_DIRS   = 0
SCRIPT_NAME        = Path(__file__).name

ProgressFn = Callable[[int, str], None]
TruncateFn = Callable[[Path, int], bool]


# ---------------------------------------------------------------------------
# Data model - scan phase produces this, render phase consumes it
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Config:
    target: Path
    max_depth: int = 0
    show_hidden: bool = False
    excluded: frozenset[str] = DEFAULT_EXCLUDED

    def is_excluded(self, name: str) -> bool:
        return (
            name in self.excluded
            or name == SCRIPT_NAME
            or name.endswith("_dir_tree.md")
            or (not self.show_hidden and name.startswith("."))
        )


@dataclass(frozen=True)
class FileNode:
    name: str
    size: int = 0


@dataclass
class DirNode:
    name: str
    path: Path
    dirs: list[DirNode] = field(default_factory=list)
    files: list[FileNode] = field(default_factory=list)
    error: str = ""
    truncated_count: int = 0

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

    if len(raw) > TRUNCATE_THRESHOLD and on_truncate and on_truncate(directory, len(raw)):
        node.truncated_count = len(raw)
        return node

    # Filter and sort from the single iterdir() result
    entries = sorted(
        (e for e in raw if not e.is_symlink() and not config.is_excluded(e.name)),
        key=lambda e: (not e.is_dir(), e.name.lower()),
    )

    for entry in entries:
        if entry.is_dir():
            stats.folders += 1
            beyond_limit = config.max_depth > 0 and depth >= config.max_depth
            child = (
                _scan_shallow(entry, config, stats)
                if beyond_limit
                else scan(entry, config, stats, depth + 1, on_progress, on_truncate)
            )
            node.dirs.append(child)
        else:
            stats.files += 1
            size = _stat_file(entry)
            stats.total_bytes += size
            node.files.append(FileNode(entry.name, size))

    return node


def _scan_shallow(directory: Path, config: Config, stats: Stats) -> DirNode:
    """Single-level enumeration for depth-limited directories."""
    node = DirNode(name=directory.name, path=directory)
    try:
        raw = list(directory.iterdir())
    except OSError:
        node.error = "permission denied"
        return node

    for entry in raw:
        if entry.is_symlink() or config.is_excluded(entry.name):
            continue
        if entry.is_dir():
            stats.folders += 1
            node.dirs.append(DirNode(name=entry.name, path=entry))
        else:
            stats.files += 1
            size = _stat_file(entry)
            stats.total_bytes += size
            node.files.append(FileNode(entry.name, size))

    return node


# ---------------------------------------------------------------------------
# Render phase - transforms a DirNode tree into formatted text lines
# ---------------------------------------------------------------------------

def _annotation(node: DirNode) -> str:
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

    children: list[DirNode | FileNode] = [*node.dirs, *node.files]
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
            lines.extend(render_tree(child, prefix + extension, depth + 1))
            prev_was_dir = True
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
    line2 = f"  {str(target).replace('\\', '/')}"
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
    root_annotation = f"  (Total: {stats.folders} folders, {stats.files} files, {_human_size(stats.total_bytes)})"
    parts = ["```", *header, "", f"{FOLDER} {folder_name}/{root_annotation}", *tree_lines, "```", ""]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# CLI / IO
# ---------------------------------------------------------------------------

def parse_args(argv: list[str], default_path: Path) -> Config:
    path: Path | None = None
    depth = 0
    show_hidden = False
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
        elif path is None and not a.startswith("-"):
            path = Path(a)
        i += 1

    target = path or default_path
    try:
        target = target.resolve()
    except Exception as exc:
        print(f"Failed to resolve target: {exc}")
        sys.exit(1)

    return Config(target=target, max_depth=depth, show_hidden=show_hidden)


def _console_progress(dirs_done: int, label: str) -> None:
    msg = f"\r  Scanning... {dirs_done} directories processed"
    if label:
        msg += f"  [{label}]"
    sys.stdout.write(msg + "    ")
    sys.stdout.flush()


def _console_truncate_prompt(dir_path: Path, count: int) -> bool:
    while True:
        print(f"\nDirectory '{dir_path.name}' contains {count} entries.")
        choice = input("List all? (y = list, n = summary only): ").strip().lower()
        if choice in ("y", "yes"):
            return False
        if choice in ("n", "no"):
            return True


def main() -> None:
    config = parse_args(sys.argv, Path(__file__).parent)

    if not config.target.exists():
        print(f"Target not found: {config.target}")
        return
    if not config.target.is_dir():
        print(f"Target is not a directory: {config.target}")
        return

    folder_name = _root_display_name(config.target)
    stats = Stats()

    print(f"  Scanning: {config.target}")
    if config.max_depth:
        print(f"  Max depth: {config.max_depth}")

    t0 = time.perf_counter()
    root = scan(
        config.target, config, stats,
        on_progress=_console_progress,
        on_truncate=_console_truncate_prompt,
    )
    elapsed = time.perf_counter() - t0

    sys.stdout.write("\r" + " " * 80 + "\r")
    sys.stdout.flush()

    tree_lines = render_tree(root)
    document = assemble_document(folder_name, config.target, config, tree_lines, elapsed, stats)

    output = config.target / f"{folder_name}_dir_tree.md"
    try:
        output.write_text(document, encoding="utf-8")
    except Exception as exc:
        print(f"Failed to write output: {exc}")
        return

    print(f"  Folders: {stats.folders}")
    print(f"  Files:   {stats.files}")
    print(f"  Size:    {_human_size(stats.total_bytes)}")
    print(f"  Time:    {elapsed:.2f}s")
    print(f"  Output:  {output}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        input("\n  Press Enter to close...")