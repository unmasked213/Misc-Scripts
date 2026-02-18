# -*- coding: utf-8 -*-
"""
dir_tree.py (double-click friendly, interactive large-folder handling)

What it does
- Scans the target folder recursively.
- Generates a markdown directory tree with box-drawing characters.
- Saves output as [foldername]_dir_tree.md in the target folder.
- Sorts directories first, then files, case-insensitive.
- Includes a summary footer with folder/file totals and total size.
- Skips hidden files/folders (dotfiles) by default.
- Skips symlinks to avoid loops.
- Excludes common noise directories (node_modules, __pycache__, .git, etc.).
- Self-excludes: won't list its own .py file or previous _dir_tree.md output.
- Configurable max depth (default unlimited).
- If a directory exceeds TRUNCATE_THRESHOLD, prompts whether to list all files
  or show a summary line like [80412 files].
- Waits for Enter before exit (so double-click works on Windows).

Visual features
- Curved box-drawing connectors.
- Folder icons with inline counts and sizes per directory.
- Blank lines between top-level sections for readability.
- Boxed header with folder name, scan date, depth, and elapsed time.
- Progress indicator during scan.

Usage
- Double-click this file to scan the folder it lives in, or:
  python dir_tree.py --path "X:/Projects" --depth 4 --hidden
"""

from __future__ import annotations

import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import List, Tuple

# Windows-safe UTF-8 console
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

EXCLUDED_NAMES = {
    "node_modules", "__pycache__", ".git", ".svn", ".hg",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".idea", ".vscode", "dist", "build",
    ".DS_Store", "Thumbs.db",
}

SCRIPT_NAME = Path(__file__).name
FOLDER_COUNT = 0
FILE_COUNT = 0
TOTAL_BYTES = 0
DIRS_SCANNED = 0

TRUNCATE_THRESHOLD = 5000

# Box-drawing characters (escaped for ASCII-safe source)
PIPE      = "\u2502"   # ¦
TEE       = "\u251c"   # +
ELBOW     = "\u2570"   # ?
DASH      = "\u2500"   # -
BOX_TL    = "\u256d"   # ?
BOX_TR    = "\u256e"   # ?
BOX_BL    = "\u2570"   # ?
BOX_BR    = "\u256f"   # ?
BOX_H     = "\u2500"   # -
BOX_V     = "\u2502"   # ¦
BOX_TEE_L = "\u251c"   # +
BOX_TEE_R = "\u2524"   # ¦

ICON_FOLDER = "\U0001f4c1"  # ??


def human_size(b: int) -> str:
    units = [("TB", 1024**4), ("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)]
    for u, d in units:
        if b >= d:
            if u in ("TB", "GB"):
                return f"{b / d:.2f} {u}"
            else:
                return f"{int(b / d)} {u}"
    return f"{b} bytes"


def get_folder_name(target: Path) -> str:
    """Extract a usable display name, handling UNC roots and drive roots."""
    name = target.name
    if name:
        return name
    drive = target.drive
    if drive:
        # UNC path like \\server\share -> extract share name
        parts = drive.replace("/", "\\").rstrip("\\").split("\\")
        tail = parts[-1] if parts else ""
        return tail if tail else drive
    return str(target)


def parse_args(argv: List[str], default_path: Path) -> tuple[Path, int, bool]:
    path: Path | None = None
    depth = 0
    show_hidden = False

    i = 1
    arglen = len(argv)

    while i < arglen:
        a = argv[i]
        if a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        elif a == "--path" and i + 1 < arglen:
            path = Path(argv[i + 1])
            i += 1
        elif a == "--depth" and i + 1 < arglen:
            try:
                depth = max(0, int(argv[i + 1]))
            except ValueError:
                pass
            i += 1
        elif a == "--hidden":
            show_hidden = True
        else:
            if path is None and not a.startswith("-"):
                path = Path(a)
        i += 1

    if path is None:
        path = default_path
    return path, depth, show_hidden


def should_exclude(name: str, show_hidden: bool) -> bool:
    if name in EXCLUDED_NAMES:
        return True
    if name == SCRIPT_NAME:
        return True
    if name.endswith("_dir_tree.md"):
        return True
    if not show_hidden and name.startswith("."):
        return True
    return False


def ask_truncate(dir_path: Path, count: int) -> bool:
    while True:
        print(f"\nDirectory '{dir_path.name}' contains {count} files.")
        choice = input("List all files? (y = list, n = show summary only): ").strip().lower()
        if choice in ("y", "yes"):
            return False
        if choice in ("n", "no"):
            return True


def print_progress(dirs_done: int, label: str = ""):
    msg = f"\r  Scanning... {dirs_done} directories processed"
    if label:
        msg += f"  [{label}]"
    sys.stdout.write(msg + "    ")
    sys.stdout.flush()


def format_count_str(folders: int, files: int, size: int) -> str:
    """Build the inline annotation string for a directory."""
    parts = []
    if folders:
        parts.append(f"{folders} folder{'s' if folders != 1 else ''}")
    if files:
        parts.append(f"{files} file{'s' if files != 1 else ''}")
    if size:
        parts.append(human_size(size))
    return f"  ({', '.join(parts)})" if parts else ""


def build_tree(
    directory: Path,
    prefix: str,
    current_depth: int,
    max_depth: int,
    show_hidden: bool,
    is_root: bool = False,
) -> Tuple[List[str], int, int, int]:
    """Build tree lines for a directory. Returns (lines, direct_folders, direct_files, direct_size).

    Each directory is scanned exactly once. The returned counts reflect the
    direct children of this directory (after exclusions) so the parent can
    annotate the directory line without a second scan.
    """
    global FOLDER_COUNT, FILE_COUNT, TOTAL_BYTES, DIRS_SCANNED

    DIRS_SCANNED += 1
    print_progress(DIRS_SCANNED, directory.name)

    try:
        raw_entries = list(directory.iterdir())
    except OSError:
        return [f"{prefix}{TEE}{DASH}{DASH} [permission denied]"], 0, 0, 0

    if len(raw_entries) > TRUNCATE_THRESHOLD:
        truncate = ask_truncate(directory, len(raw_entries))
        if truncate:
            return [f"{prefix}{TEE}{DASH}{DASH} [{len(raw_entries)} files]"], 0, 0, 0

    entries = [
        e for e in raw_entries
        if not e.is_symlink() and not should_exclude(e.name, show_hidden)
    ]

    entries.sort(key=lambda e: (not e.is_dir(), e.name.lower()))

    # Compute direct child counts from the entries we already have
    own_folders = 0
    own_files = 0
    own_size = 0
    for e in entries:
        if e.is_dir():
            own_folders += 1
        else:
            own_files += 1
            try:
                own_size += e.stat(follow_symlinks=False).st_size
            except OSError:
                pass

    # If beyond max depth, return counts only (no lines)
    if max_depth > 0 and current_depth > max_depth:
        FOLDER_COUNT += own_folders
        FILE_COUNT += own_files
        TOTAL_BYTES += own_size
        return [], own_folders, own_files, own_size

    lines: List[str] = []
    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = f"{ELBOW}{DASH}{DASH} " if is_last else f"{TEE}{DASH}{DASH} "

        if entry.is_dir():
            FOLDER_COUNT += 1
            extension = "    " if is_last else f"{PIPE}   "

            # Recurse — child returns its own direct counts for annotation
            child_lines, cf, cfi, cs = build_tree(
                entry,
                prefix + extension,
                current_depth + 1,
                max_depth,
                show_hidden,
            )

            count_str = format_count_str(cf, cfi, cs)
            lines.append(f"{prefix}{connector}{ICON_FOLDER} {entry.name}/{count_str}")
            lines.extend(child_lines)

            if is_root and not is_last:
                lines.append("")
        else:
            FILE_COUNT += 1
            try:
                TOTAL_BYTES += entry.stat(follow_symlinks=False).st_size
            except OSError:
                pass
            lines.append(f"{prefix}{connector}{entry.name}")

    return lines, own_folders, own_files, own_size


def build_box_header(
    folder_name: str,
    target: Path,
    max_depth: int,
    elapsed: float,
) -> List[str]:
    """Build a boxed header with curved corners."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    line1 = f"  {folder_name}"
    line2 = f"  {target}"

    meta_parts = [f"Scanned: {now}", f"Took: {elapsed:.2f}s"]
    if max_depth:
        meta_parts.append(f"Depth: {max_depth}")
    line3 = f"  {'  |  '.join(meta_parts)}"

    width = max(len(line1), len(line2), len(line3)) + 4
    bar = BOX_H * width

    return [
        f"{BOX_TL}{bar}{BOX_TR}",
        f"{BOX_V}{line1:<{width}}{BOX_V}",
        f"{BOX_V}{line2:<{width}}{BOX_V}",
        f"{BOX_TEE_L}{bar}{BOX_TEE_R}",
        f"{BOX_V}{line3:<{width}}{BOX_V}",
        f"{BOX_BL}{bar}{BOX_BR}",
    ]


def main():
    global FOLDER_COUNT, FILE_COUNT, TOTAL_BYTES, DIRS_SCANNED

    script_dir = Path(__file__).parent
    target, max_depth, show_hidden = parse_args(sys.argv, script_dir)

    try:
        target = target.resolve()
    except Exception as e:
        print(f"Failed to resolve target: {e}")
        return

    if not target.exists():
        print(f"Target not found: {target}")
        return

    if not target.is_dir():
        print(f"Target is not a directory: {target}")
        return

    folder_name = get_folder_name(target)
    FOLDER_COUNT = 0
    FILE_COUNT = 0
    TOTAL_BYTES = 0
    DIRS_SCANNED = 0

    print(f"  Scanning: {target}")
    if max_depth:
        print(f"  Max depth: {max_depth}")

    t0 = time.perf_counter()
    tree_lines, _, _, _ = build_tree(target, "", 1, max_depth, show_hidden, is_root=True)
    elapsed = time.perf_counter() - t0

    # Clear progress line
    sys.stdout.write("\r" + " " * 80 + "\r")
    sys.stdout.flush()

    header_lines = build_box_header(folder_name, target, max_depth, elapsed)

    md_lines = [
        *header_lines,
        "",
        "```",
        f"{ICON_FOLDER} {folder_name}/",
        *tree_lines,
        "```",
        "",
        f"{FOLDER_COUNT} folders, {FILE_COUNT} files, {human_size(TOTAL_BYTES)} total",
        "",
    ]

    output = target / f"{folder_name}_dir_tree.md"
    try:
        output.write_text("\n".join(md_lines), encoding="utf-8")
    except Exception as e:
        print(f"Failed to write output: {e}")
        return

    print(f"  Folders: {FOLDER_COUNT}")
    print(f"  Files:   {FILE_COUNT}")
    print(f"  Size:    {human_size(TOTAL_BYTES)}")
    print(f"  Time:    {elapsed:.2f}s")
    print(f"  Output:  {output}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
    finally:
        input("\n  Press Enter to close...")