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
  python folder_top10.py --path "X:/Media" --limit 10
"""

from __future__ import annotations
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple

# Import optimized scanner
try:
    from folder_scanner_fast import scan_folders_fast, scan_folders_serial
    FAST_SCANNER_AVAILABLE = True
except ImportError:
    # Fallback if module not available
    FAST_SCANNER_AVAILABLE = False
    import heapq
    import stat as stat_module
    from collections import defaultdict

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
    path = None
    limit = 10
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        elif a == "--path" and i + 1 < len(argv):
            path = Path(argv[i + 1])
            i += 1
        elif a == "--limit" and i + 1 < len(argv):
            try:
                limit = max(1, int(argv[i + 1]))
            except ValueError:
                pass
            i += 1
        else:
            # allow positional path
            if path is None and not a.startswith("-"):
                path = Path(a)
        i += 1
    if path is None:
        path = default_path
    return path, limit


def on_walk_error(err: OSError):
    # best-effort: ignore permission or transient fs errors
    # print(f"[warn] {err}", file=sys.stderr)
    pass


def scan_folders(
        target: Path
) -> tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
    """
    Returns:
      size_totals: dirpath -> total bytes (recursive)
      count_totals: dirpath -> total file count (recursive)
      top_files: list of (size, path) tuples for top 10 largest files
    """
    target_str = str(target)

    # Use optimized scanner if available
    if FAST_SCANNER_AVAILABLE:
        return scan_folders_fast(target_str)

    # Fallback to original implementation
    return _scan_folders_fallback(target)


def _scan_folders_fallback(
        target: Path
) -> tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
    """
    Original implementation - fallback if optimized scanner unavailable.

    Returns:
      size_totals: dirpath -> total bytes (recursive)
      count_totals: dirpath -> total file count (recursive)
      top_files: list of (size, path) tuples for top 10 largest files
    """
    # Use defaultdict for automatic zero-initialization
    size_totals: Dict[str, int] = defaultdict(int)
    count_totals: Dict[str, int] = defaultdict(int)

    # Bounded min-heap for top 10 files - maintains at most 10 entries
    # Memory: O(10) instead of O(total_files)
    top_files_heap: List[Tuple[int, str]] = []
    heap_size_limit = 10

    # Bottom-up walk so we can aggregate children into parents.
    for dirpath, dirnames, filenames in os.walk(
            target, topdown=False, onerror=on_walk_error,
            followlinks=False):

        # Direct files in this directory
        s_direct = 0
        c_direct = 0

        for fn in filenames:
            # Use os.path.join instead of pathlib (faster for this use case)
            fp_str = os.path.join(dirpath, fn)

            try:
                # Single lstat call (doesn't follow symlinks)
                # More efficient than separate is_symlink() + stat() calls
                st = os.lstat(fp_str)

                # Skip symlinks to avoid cycles/duplicates
                if stat_module.S_ISLNK(st.st_mode):
                    continue

                # Count only regular files
                if not stat_module.S_ISREG(st.st_mode):
                    continue

                file_size = st.st_size
                s_direct += file_size
                c_direct += 1

                # Maintain bounded heap for top 10 files
                if len(top_files_heap) < heap_size_limit:
                    heapq.heappush(top_files_heap, (file_size, fp_str))
                elif file_size > top_files_heap[0][0]:
                    heapq.heapreplace(top_files_heap, (file_size, fp_str))

            except OSError:
                # unreadable/broken files are skipped
                continue

        # Start with direct totals
        size_totals[dirpath] = s_direct
        count_totals[dirpath] = c_direct

        # Add all immediate children totals (already computed in bottom-up)
        s_total = s_direct
        c_total = c_direct

        # String concatenation for child paths (faster than Path operations)
        for dn in dirnames:
            child = os.path.join(dirpath, dn)
            # defaultdict returns 0 for missing keys automatically
            s_total += size_totals[child]
            c_total += count_totals[child]

        size_totals[dirpath] = s_total
        count_totals[dirpath] = c_total

    # Convert heap to sorted list (largest first)
    # heapq.nlargest efficiently sorts the small heap
    top_files = heapq.nlargest(heap_size_limit, top_files_heap, key=lambda x: x[0])

    return size_totals, count_totals, top_files


def rank_and_print(
        target: Path, size_totals: Dict[str, int],
        count_totals: Dict[str, int], limit: int,
        top_files: List[Tuple[int, str]]):
    root = str(target.resolve())

    # Get total stats for the root
    total_size = size_totals.get(root, 0)
    total_files = count_totals.get(root, 0)

    # Exclude the root itself from the rankings
    entries: List[Tuple[str, int, int]] = []
    for d in size_totals.keys():
        if str(Path(d).resolve()) == root:
            continue
        entries.append((d, size_totals.get(d, 0), count_totals.get(d, 0)))

    # Guard: nothing under root
    if not entries:
        print(f"  No subfolders found under {root}")
        return

    # Sorters
    by_size = sorted(entries, key=lambda x: x[1], reverse=True)[:limit]
    by_count = sorted(entries, key=lambda x: x[2], reverse=True)[:limit]

    # Column widths
    max_rank = max(len(str(len(by_size))), len(str(len(by_count))))
    size_w = max(10, max((len(human_size(s))
                          for _, s, _ in by_size), default=10))
    cnt_w = max(6, max((len(f"{c:,}")
                        for _, _, c in by_size + by_count), default=6))

    print("  FOLDER TOP-10 SUMMARY")
    print(f"  TARGET: {root}")
    print("  " + "=" * len(DASH))
    print()
    print(f"  TOTAL SIZE:  {human_size(total_size)}")
    print(f"  TOTAL FILES: {total_files:,}")
    print()
    legend = (f"  LEGEND: {BOLD}{ORANGE_FG}1.5-2x avg{RESET}  "
              f"{BOLD}{RED_FG}2x+ avg{RESET}")
    print(legend)
    print()

    # Pre-compute average file size once
    avg_file_size = total_size / total_files if total_files > 0 else 0

    # Top by size
    print("  TOP BY SIZE")
    print("  " + DASH)
    header_rank = "#".ljust(max_rank + 2)
    header_size = "SIZE".ljust(size_w)
    header_pct = "%".ljust(6)
    header_files = "FILES".ljust(cnt_w)
    header = (f"  {header_rank}  {header_size}  "
              f"{header_pct}  {header_files}   PATH")
    print(header)
    print("  " + DASH)

    for idx, (path_str, bytes_total, files_total) in enumerate(
            by_size, start=1):
        rank = (str(idx) + ".").ljust(max_rank + 2)
        size_h = human_size(bytes_total).ljust(size_w)
        size_pct = (bytes_total / total_size * 100) if total_size > 0 else 0
        pct = f"{size_pct:.1f}%".ljust(6)
        files_str = f"{files_total:,}"

        # Calculate average file size for this folder
        folder_avg = bytes_total / files_total if files_total > 0 else 0

        # Strip root path to show relative path
        rel_path = str(Path(path_str).relative_to(root))

        # Highlight based on how much larger than average
        if folder_avg >= 2 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{RED_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(RED_FG) + len(RESET))
        elif folder_avg >= 1.5 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{ORANGE_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(ORANGE_FG) + len(RESET))
        else:
            files_h = files_str.ljust(cnt_w)

        print(f"  {rank}  {size_h}  {pct}  {files_h}   {rel_path}")
    if not by_size:
        print("  (no folders)")

    print()
    print()
    print()

    # Top by file count
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

        # Calculate average file size for this folder
        folder_avg = bytes_total / files_total if files_total > 0 else 0

        # Strip root path to show relative path
        rel_path = str(Path(path_str).relative_to(root))

        # Highlight based on how much larger than average
        if folder_avg >= 2 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{RED_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(RED_FG) + len(RESET))
        elif folder_avg >= 1.5 * avg_file_size and avg_file_size > 0:
            files_h = f"{BOLD}{ORANGE_FG}{files_str}{RESET}".ljust(
                cnt_w + len(BOLD) + len(ORANGE_FG) + len(RESET))
        else:
            files_h = files_str.ljust(cnt_w)

        print(f"  {rank}  {size_h}  {pct}  {files_h}   {rel_path}")
    if not by_count:
        print("  (no folders)")

    print()
    print()
    print()

    # Top 10 largest files
    if top_files:
        print("  TOP 10 LARGEST FILES")
        print("  " + DASH)
        file_size_w = max(10, max((len(human_size(s))
                                   for s, _ in top_files), default=10))
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
        print("  TOP 10 LARGEST FILES")
        print("  " + DASH)
        print("  (no files)")


def main():
    script_dir = Path(__file__).parent
    target, limit = parse_args(sys.argv, script_dir)

    # Basic access check
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
    try:
        size_totals, count_totals, top_files = scan_folders(target)
    except Exception as e:
        print(f"  Failed while scanning: {e}")
        input("\n  Press Enter to exit...")
        return

    print()
    rank_and_print(target, size_totals, count_totals, limit, top_files)
    input("\n  Press Enter to exit...")


if __name__ == "__main__":
    main()
