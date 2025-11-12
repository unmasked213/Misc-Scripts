#!/usr/bin/env python3
"""
delete_marked.py

This helper script complements the dupefinder interactive report.  It reads
the `to_delete.json` file produced by marking images in the HTML report and
safely moves the listed files into a `_trash` directory.  Files are not
deleted outright; moving them allows you to review the contents of `_trash`
before permanent deletion.

Usage:

    python delete_marked.py

The script looks for `to_delete.json` in the current working directory.
If the file is not found, it prints a warning and exits.  Files that
cannot be found on disk are skipped silently.
"""

import json
from pathlib import Path


def main() -> None:
    marker_path = Path("to_delete.json")
    if not marker_path.exists():
        print("to_delete.json not found in current directory. Nothing to do.")
        return
    # Read list of file paths to move
    try:
        data = marker_path.read_text(encoding="utf-8")
        files = json.loads(data)
    except Exception as e:
        print(f"Failed to parse {marker_path}: {e}")
        return
    if not isinstance(files, list):
        print(f"Invalid format: expected a JSON array in {marker_path}")
        return
    trash_dir = Path("_trash")
    trash_dir.mkdir(exist_ok=True)
    moved = 0
    for file_str in files:
        try:
            p = Path(file_str)
        except Exception:
            # Skip invalid paths
            continue
        if not p.exists():
            continue
        # Determine a unique destination path to avoid overwriting
        dest = trash_dir / p.name
        if dest.exists():
            stem = p.stem
            suffix = p.suffix
            i = 1
            dest = trash_dir / f"{stem}_{i}{suffix}"
            while dest.exists():
                i += 1
                dest = trash_dir / f"{stem}_{i}{suffix}"
        try:
            p.rename(dest)
            moved += 1
        except Exception as e:
            print(f"Failed to move {p}: {e}")
    print(f"Moved {moved} files to '{trash_dir}' for review.")


if __name__ == "__main__":
    main()
