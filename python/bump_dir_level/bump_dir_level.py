# -*- coding: utf-8 -*-
"""
bump_dir_level.py - move contents of a subfolder up one level

Moves all files and folders from inside a target subfolder into its
parent directory, then removes the now-empty subfolder.

Usage
  Double-click to be prompted for a folder path, or:
    python bump_dir_level.py "D:/scripts/Misc Scripts/Misc-Scripts"
    python bump_dir_level.py --path "D:/scripts/Misc Scripts/Misc-Scripts"
    python bump_dir_level.py --path "D:/scripts/Misc Scripts/Misc-Scripts" --dry-run

Example
  Before:
    Misc Scripts/
    +-- Misc-Scripts/
        +-- batch/
        +-- python/
        +-- README.md

  After:
    Misc Scripts/
    +-- batch/
    +-- python/
    +-- README.md
"""
from __future__ import annotations

import os
import sys
import shutil
import traceback
from pathlib import Path
from typing import List


def parse_args(argv: List[str]) -> tuple[Path | None, bool]:
    path: Path | None = None
    dry_run = False
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        elif a == "--path" and i + 1 < len(argv):
            path = Path(argv[i + 1])
            i += 1
        elif a == "--dry-run":
            dry_run = True
        elif path is None and not a.startswith("-"):
            path = Path(a)
        i += 1
    return path, dry_run


def unwrap(target: Path, dry_run: bool = False) -> None:
    parent = target.parent

    entries = list(target.iterdir())
    if not entries:
        print(f"  '{target.name}' is empty, nothing to move.")
        return

    # Check for conflicts
    conflicts = []
    for entry in entries:
        dest = parent / entry.name
        if dest.exists():
            conflicts.append(entry.name)

    if conflicts:
        print(f"\n  Cannot unwrap - these already exist in '{parent.name}':")
        for name in conflicts:
            print(f"    {name}")
        print(f"\n  Resolve conflicts before running again.")
        return

    # Move everything
    print(f"\n  Moving {len(entries)} items from '{target.name}' into '{parent.name}':\n")
    for entry in sorted(entries, key=lambda e: (not e.is_dir(), e.name.lower())):
        dest = parent / entry.name
        label = f"  {entry.name}/" if entry.is_dir() else f"  {entry.name}"
        if dry_run:
            print(f"  [dry-run] {label}")
        else:
            shutil.move(str(entry), str(dest))
            print(label)

    # Remove empty folder
    if not dry_run:
        try:
            target.rmdir()
            print(f"\n  Removed empty folder '{target.name}'")
        except OSError:
            print(f"\n  Warning: '{target.name}' is not empty after move, left in place.")
    else:
        print(f"\n  [dry-run] Would remove empty folder '{target.name}'")

    print("  Done.")


def main() -> None:
    target, dry_run = parse_args(sys.argv)

    if target is None:
        raw = input("\n  Folder to unwrap: ").strip().strip('"').strip("'")
        if not raw:
            print("  No path provided.")
            return
        target = Path(raw)

    try:
        target = target.resolve()
    except Exception as e:
        print(f"  Failed to resolve path: {e}")
        return

    if not target.exists():
        print(f"  Not found: {target}")
        return

    if not target.is_dir():
        print(f"  Not a directory: {target}")
        return

    parent = target.parent
    if parent == target:
        print(f"  Cannot unwrap a root directory.")
        return

    entries = list(target.iterdir())
    dirs = sum(1 for e in entries if e.is_dir())
    files = sum(1 for e in entries if e.is_file())

    print(f"\n  Unwrap: {target.name}")
    print(f"  Into:   {parent}")
    print(f"  Items:  {dirs} folders, {files} files")
    if dry_run:
        print(f"  Mode:   DRY RUN")

    if not dry_run:
        confirm = input(f"\n  Proceed? (y/n): ").strip().lower()
        if confirm not in ("y", "yes"):
            print("  Cancelled.")
            return

    unwrap(target, dry_run)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        input("\n  Press Enter to close...")
