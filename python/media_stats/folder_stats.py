"""
folder_stats.py (double-click friendly)

What it does
- Scans the target folder recursively.
- Computes totals per subfolder (size and file count),
  including all of its descendants.
- Prints two leaderboards:
  1) Top folders by total storage used.
  2) Top folders by total number of files.
- Excludes the target root itself from the rankings.
- Limits results to at most 10 folders (or fewer if less exist).
- Skips unreadable files/dirs and symlinks to avoid loops.
- Waits for Enter before exit (so double-click works on Windows).

Usage
- Double-click this file to scan the folder it lives in, or:
  python folder_stats.py --path "X:/Media" --limit 10
"""

from __future__ import annotations

import os
import sys
import heapq
from pathlib import Path
from typing import Dict, List, Tuple
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import time

# Windows-safe UTF-8 console
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Enable ANSI colors on Windows
if sys.platform == "win32":
    os.system("")

DASH = "-" * 40
BOLD = "\033[1m"
RED_FG = "\033[91m"
ORANGE_FG = "\033[38;5;208m"
RESET = "\033[0m"


def human_size(b: int | None) -> str:
    if b is None:
        return "N/A"
    units = [("TB", 1024**4), ("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)]
    for u, d in units:
        if b >= d:
            if u in ("TB", "GB"):
                return f"{b / d:.2f} {u}"
            else:
                return f"{int(b / d)} {u}"
    return f"{b} bytes"


def parse_args(argv: List[str], default_path: Path) -> tuple[Path, int]:
    path: Path | None = None
    limit = 10
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
        elif a == "--limit" and i + 1 < arglen:
            try:
                limit = max(1, int(argv[i + 1]))
            except ValueError:
                pass
            i += 1
        else:
            if path is None and not a.startswith("-"):
                path = Path(a)
        i += 1

    if path is None:
        path = default_path
    return path, limit


def scan_folders(
    target: Path,
) -> tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
    """
    Parallel directory scanner using os.scandir + ThreadPoolExecutor.

    Returns:
      size_totals: dirpath -> total bytes (recursive)
      count_totals: dirpath -> total file count (recursive)
      top_files: list of (size, path) tuples for top 10 largest files
    """
    size_totals: Dict[str, int] = defaultdict(int)
    count_totals: Dict[str, int] = defaultdict(int)

    heap_size_limit = 10
    thread_local = threading.local()
    global_heaps: List[List[Tuple[int, str]]] = []
    heaps_lock = threading.Lock()
    size_lock = threading.Lock()
    count_lock = threading.Lock()

    def update_top(file_size: int, file_path: str) -> None:
        try:
            h = thread_local.heap
        except AttributeError:
            h = []
            thread_local.heap = h
            with heaps_lock:
                global_heaps.append(h)

        if len(h) < heap_size_limit:
            heapq.heappush(h, (file_size, file_path))
        elif file_size > h[0][0]:
            heapq.heapreplace(h, (file_size, file_path))

    def scan_dir(dirpath: str, ex: ThreadPoolExecutor) -> Tuple[int, int]:
        size_direct = 0
        count_direct = 0
        subdirs: List[str] = []

        try:
            with os.scandir(dirpath) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue

                        if entry.is_file(follow_symlinks=False):
                            stat_info = entry.stat(follow_symlinks=False)
                            file_size = stat_info.st_size
                            size_direct += file_size
                            count_direct += 1
                            update_top(file_size, entry.path)

                        elif entry.is_dir(follow_symlinks=False):
                            subdirs.append(entry.path)

                    except OSError:
                        continue
        except OSError:
            pass

        size_total = size_direct
        count_total = count_direct

        if subdirs:
            if len(subdirs) <= 2:
                for subdir in subdirs:
                    sub_size, sub_count = scan_dir(subdir, ex)
                    size_total += sub_size
                    count_total += sub_count
            else:
                futures = {ex.submit(scan_dir, subdir, ex): subdir for subdir in subdirs}
                for fut in as_completed(futures):
                    try:
                        sub_size, sub_count = fut.result()
                        size_total += sub_size
                        count_total += sub_count
                    except Exception:
                        continue

        with size_lock:
            size_totals[dirpath] = size_total
        with count_lock:
            count_totals[dirpath] = count_total

        return size_total, count_total

    root_path = target.resolve()
    root_str = str(root_path)

    max_workers = (os.cpu_count() or 4) * 2
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        scan_dir(root_str, ex)

    merged: List[Tuple[int, str]] = []
    for h in global_heaps:
        merged.extend(h)
    top_files = heapq.nlargest(heap_size_limit, merged) if merged else []

    return size_totals, count_totals, top_files


def rank_and_print(
    target: Path,
    size_totals: Dict[str, int],
    count_totals: Dict[str, int],
    limit: int,
    top_files: List[Tuple[int, str]],
):
    root = str(target.resolve())

    total_size = size_totals.get(root, 0)
    total_files = count_totals.get(root, 0)

    entries: List[Tuple[str, int, int]] = []
    for d, s_val in size_totals.items():
        if d == root:
            continue
        entries.append((d, s_val, count_totals.get(d, 0)))

    if not entries:
        print(f"  No subfolders found under {root}")
        return

    by_size = sorted(entries, key=lambda x: x[1], reverse=True)[:limit]
    by_count = sorted(entries, key=lambda x: x[2], reverse=True)[:limit]

    max_rank = max(len(str(len(by_size))), len(str(len(by_count))))
    size_w = max(10, max((len(human_size(s)) for _, s, _ in by_size), default=10))
    cnt_w = max(
        6, max((len(f"{c:,}") for _, _, c in (by_size + by_count)), default=6)
    )

    print("  FOLDER TOP-10 SUMMARY")
    print(f"  TARGET: {root}")
    print("  " + "=" * len(DASH))
    print()
    print(f"  TOTAL SIZE:  {human_size(total_size)}")
    print(f"  TOTAL FILES: {total_files:,}")
    print()
    legend = (
        f"  LEGEND: {BOLD}{ORANGE_FG}1.5-2x avg{RESET}  "
        f"{BOLD}{RED_FG}2x+ avg{RESET}"
    )
    print(legend)
    print()

    avg_file_size = total_size / total_files if total_files > 0 else 0

    print("  TOP BY SIZE")
    print("  " + DASH)
    header_rank = "#".ljust(max_rank + 2)
    header_size = "SIZE".ljust(size_w)
    header_pct = "%".ljust(6)
    header_files = "FILES".ljust(cnt_w)
    header = (
        f"  {header_rank}  {header_size}  {header_pct}  {header_files}   PATH"
    )
    print(header)
    print("  " + DASH)

    for idx, (path_str, bytes_total, files_total) in enumerate(by_size, start=1):
        rank = (str(idx) + ".").ljust(max_rank + 2)
        size_h = human_size(bytes_total).ljust(size_w)
        size_pct = (bytes_total / total_size * 100) if total_size > 0 else 0
        pct = f"{size_pct:.1f}%".ljust(6)
        files_str = f"{files_total:,}"
        folder_avg = bytes_total / files_total if files_total > 0 else 0
        rel_path = str(Path(path_str).relative_to(root))

        if folder_avg >= 2 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{RED_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(RED_FG) + len(RESET)
            )
        elif folder_avg >= 1.5 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{ORANGE_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(ORANGE_FG) + len(RESET)
            )
        else:
            files_h = files_str.ljust(cnt_w)

        print(f"  {rank}  {size_h}  {pct}  {files_h}   {rel_path}")

    print()
    print()
    print()

    print("  TOP BY FILE COUNT")
    print("  " + DASH)
    print(f"  {header_rank}  {header_size}  {header_pct}  {header_files}   PATH")
    print("  " + DASH)

    for idx, (path_str, bytes_total, files_total) in enumerate(by_count, start=1):
        rank = (str(idx) + ".").ljust(max_rank + 2)
        size_h = human_size(bytes_total).ljust(size_w)
        size_pct = (bytes_total / total_size * 100) if total_size > 0 else 0
        pct = f"{size_pct:.1f}%".ljust(6)
        files_str = f"{files_total:,}"
        folder_avg = bytes_total / files_total if files_total > 0 else 0
        rel_path = str(Path(path_str).relative_to(root))

        if folder_avg >= 2 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{RED_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(RED_FG) + len(RESET)
            )
        elif folder_avg >= 1.5 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{ORANGE_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(ORANGE_FG) + len(RESET)
            )
        else:
            files_h = files_str.ljust(cnt_w)

        print(f"  {rank}  {size_h}  {pct}  {files_h}   {rel_path}")

    print()
    print()
    print()

    print("  TOP 10 LARGEST FILES")
    print("  " + DASH)
    if top_files:
        file_size_w = max(
            10, max((len(human_size(s)) for s, _ in top_files), default=10)
        )
        file_rank = "#".ljust(max_rank + 2)
        file_size_h = "SIZE".ljust(file_size_w)
        print(f"  {file_rank}  {file_size_h}   PATH")
        print("  " + DASH)
        for idx, (file_size, file_path) in enumerate(top_files, start=1):
            rank = (str(idx) + ".").ljust(max_rank + 2)
            size_h = human_size(file_size).ljust(file_size_w)
            rel_file_path = str(Path(file_path).relative_to(root))
            print(f"  {rank}  {size_h}   {rel_file_path}")
    else:
        print("  (no files)")


def main():
    script_dir = Path(__file__).parent
    target, limit = parse_args(sys.argv, script_dir)

    try:
        target = target.resolve()
    except Exception as e:
        print(f"  Failed to resolve target: {e}")
        input("\n  Press Enter to exit...")
        return

    if not target.exists():
        print(f"  Target not found: {target}")
        input("\n  Press Enter to exit...")
        return

    if not target.is_dir():
        print(f"  Target is not a directory: {target}")
        input("\n  Press Enter to exit...")
        return

    print(f"  Scanning folders under {str(target)} ... (this may take a while)")

    t0 = time.perf_counter()
    try:
        size_totals, count_totals, top_files = scan_folders(target)
    except Exception as e:
        print(f"  Failed while scanning: {e}")
        input("\n  Press Enter to exit...")
        return
    elapsed = time.perf_counter() - t0

    print(f"  SCAN TIME: {elapsed:.2f} seconds")
    print()

    rank_and_print(target, size_totals, count_totals, limit, top_files)
    input("\n  Press Enter to exit...")


if __name__ == "__main__":
    main()
