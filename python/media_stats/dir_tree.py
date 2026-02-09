# -*- coding: utf-8 -*-
"""
dir_tree.py (double-click friendly)

What it does
- Scans the target folder recursively.
- Generates a markdown directory tree with box-drawing characters.
- Saves output as [foldername]_dir_tree.md in the target folder.
- Sorts directories first, then files, case-insensitive.
- Includes a summary footer with folder/file totals.
- Skips hidden files/folders (dotfiles) by default.
- Skips symlinks to avoid loops.
- Excludes common noise directories (node_modules, __pycache__, .git, etc.).
- Self-excludes: won't list its own .py file or previous _dir_tree.md output.
- Configurable max depth (default unlimited).
- Waits for Enter before exit (so double-click works on Windows).

Usage
- Double-click this file to scan the folder it lives in, or:
  python dir_tree.py --path "X:/Projects" --depth 4 --hidden
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List

# Windows-safe UTF-8 console
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def auto_close(seconds=5):
    import time
    for i in range(seconds, 0, -1):
        print(f"\r  Closing in {i}...", end="", flush=True)
        time.sleep(1)
    sys.exit(0)


EXCLUDED_DIRS = {
    "node_modules", "__pycache__", ".git", ".svn", ".hg",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".idea", ".vscode", "dist", "build",
    ".DS_Store", "Thumbs.db",
}

SCRIPT_NAME = Path(__file__).name
FOLDER_COUNT = 0
FILE_COUNT = 0


def parse_args(argv: List[str], default_path: Path) -> tuple[Path, int, bool]:
    path: Path | None = None
    depth = 0  # 0 = unlimited
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
    if name in EXCLUDED_DIRS:
        return True
    if name == SCRIPT_NAME:
        return True
    if name.endswith("_dir_tree.md"):
        return True
    if not show_hidden and name.startswith("."):
        return True
    return False


def build_tree(
    directory: Path,
    prefix: str,
    current_depth: int,
    max_depth: int,
    show_hidden: bool,
) -> List[str]:
    global FOLDER_COUNT, FILE_COUNT

    try:
        entries = sorted(
            directory.iterdir(),
            key=lambda e: (not e.is_dir(), e.name.lower()),
        )
    except OSError:
        return []

    entries = [
        e for e in entries
        if not e.is_symlink() and not should_exclude(e.name, show_hidden)
    ]

    lines = []
    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "\u2514\u2500\u2500 " if is_last else "\u251c\u2500\u2500 "
        lines.append(f"{prefix}{connector}{entry.name}")

        if entry.is_dir():
            FOLDER_COUNT += 1
            if max_depth == 0 or current_depth < max_depth:
                extension = "    " if is_last else "\u2502   "
                lines.extend(
                    build_tree(
                        entry,
                        prefix + extension,
                        current_depth + 1,
                        max_depth,
                        show_hidden,
                    )
                )
        else:
            FILE_COUNT += 1

    return lines


def main():
    global FOLDER_COUNT, FILE_COUNT

    script_dir = Path(__file__).parent
    target, max_depth, show_hidden = parse_args(sys.argv, script_dir)

    try:
        target = target.resolve()
    except Exception as e:
        print(f"  Failed to resolve target: {e}")
        auto_close()
        return

    if not target.exists():
        print(f"  Target not found: {target}")
        auto_close()
        return

    if not target.is_dir():
        print(f"  Target is not a directory: {target}")
        auto_close()
        return

    folder_name = target.name
    FOLDER_COUNT = 0
    FILE_COUNT = 0

    print(f"  Scanning: {target}")
    if max_depth:
        print(f"  Max depth: {max_depth}")

    tree_lines = build_tree(target, "", 1, max_depth, show_hidden)

    depth_note = f" (depth: {max_depth})" if max_depth else ""
    md_lines = [
        f"# {folder_name}{depth_note}\n",
        "```",
        f"{folder_name}/",
        *tree_lines,
        "```\n",
        f"**{FOLDER_COUNT}** folders, **{FILE_COUNT}** files\n",
    ]

    output = target / f"{folder_name}_dir_tree.md"
    try:
        output.write_text("\n".join(md_lines), encoding="utf-8")
    except Exception as e:
        print(f"  Failed to write output: {e}")
        auto_close()
        return

    print(f"  Folders: {FOLDER_COUNT}")
    print(f"  Files:   {FILE_COUNT}")
    print(f"  Output:  {output}")
    auto_close()


if __name__ == "__main__":
    main()