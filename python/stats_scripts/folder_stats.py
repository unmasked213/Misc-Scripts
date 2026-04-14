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
- Limits results to a specified number of folders (default 25).
- Skips unreadable files/dirs and symlinks to avoid loops.
- Waits for Enter before exit (so double-click works on Windows).

Usage
- Double-click this file to scan the folder it lives in, or:
  python folder_stats.py --path "X:/Media" --limit 10
"""

from __future__ import annotations

import os
import re
import sys
import heapq
from pathlib import Path
from typing import Dict, List, Tuple
import time
import multiprocessing as mp
from multiprocessing import Process, Manager

# Windows-safe UTF-8 console
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------------------
# ANSI colours
# ---------------------------------------------------------------------------

def _enable_ansi() -> bool:
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if k32.GetConsoleMode(handle, ctypes.byref(mode)):
            k32.SetConsoleMode(handle, mode.value | 0x0004)
            return True
    except Exception:
        pass
    return False


_ANSI = _enable_ansi()

if _ANSI:
    DIM     = "\033[2m"
    BOLD    = "\033[1m"
    RESET   = "\033[0m"
    CYAN    = "\033[36m"
    GREEN   = "\033[32m"
    YELLOW  = "\033[33m"
    RED     = "\033[31m"
    WHITE   = "\033[37m"
    GREY    = "\033[90m"
    MAGENTA = "\033[95m"
    ORANGE  = "\033[38;5;208m"
    BLUE_ACCENT  = "\033[38;2;0;157;217m"
    PINK_ACCENT  = "\033[38;2;255;46;146m"
    BOX_DARK     = "\033[38;2;41;42;53m"
else:
    DIM = BOLD = RESET = CYAN = GREEN = YELLOW = RED = WHITE = GREY = MAGENTA = ORANGE = ""
    BLUE_ACCENT = PINK_ACCENT = BOX_DARK = ""


# ---------------------------------------------------------------------------
# Box-drawing characters
# ---------------------------------------------------------------------------

PIPE      = "\u2502"
TEE       = "\u251c"
ELBOW     = "\u2570"
DASH      = "\u2500"
BOX_TL    = "\u256d"
BOX_TR    = "\u256e"
BOX_BL    = "\u2570"
BOX_BR    = "\u256f"
BOX_R_TEE = "\u2524"

_ANSI_RE = re.compile(r"\033\[[0-9;]*m")
COUNTDOWN_SECS = 10


# ---------------------------------------------------------------------------
# Console chrome
# ---------------------------------------------------------------------------

def _visible_len(s: str) -> int:
    return len(_ANSI_RE.sub("", s))


def _con_box(lines: list[str], *, colour: str = CYAN) -> None:
    width = max(_visible_len(line) for line in lines) + 2
    bar = DASH * width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")
    for line in lines:
        pad = width - 1 - _visible_len(line)
        print(f"  {colour}{PIPE}{RESET} {line}{' ' * pad}{colour}{PIPE}{RESET}")
    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")


def _con_warn(msg: str) -> None:
    print(f"\n  {RED}{PIPE}{RESET} {msg}")


def _con_ok(msg: str) -> None:
    print(f"  {GREEN}{PIPE}{RESET} {msg}")


def _clear_up(n: int) -> None:
    """Move cursor up n lines and clear each one."""
    for _ in range(n):
        sys.stdout.write("\033[1A\033[2K")
    sys.stdout.flush()


def _wait_any_key(label: str = "Press any key to exit...") -> None:
    """Block until any key is pressed."""
    import msvcrt
    sys.stdout.write(f"  {CYAN}{PIPE}{RESET} {DIM}{label}{RESET}")
    sys.stdout.flush()
    msvcrt.getwch()


def _con_prompt_timed(
    label: str,
    default: int = 25,
    timeout: int = COUNTDOWN_SECS,
) -> int:
    """Prompt for a number with a live countdown. Returns default if no input."""
    import msvcrt

    buf = ""

    def _draw(secs: int) -> None:
        if buf:
            display = f"  {YELLOW}{PIPE}{RESET} {label} {BOLD}{WHITE}{buf}{RESET}"
        else:
            display = (
                f"  {YELLOW}{PIPE}{RESET} {label}    "
                f"({DIM}defaulting to {RESET}{BOLD}{default}{RESET}"
                f"{DIM} results in {RESET}{BOLD}{MAGENTA}{secs}{RESET})"
            )
        sys.stdout.write(f"\r\033[2K{display}")
        sys.stdout.flush()

    remaining = timeout
    _draw(remaining)
    last_tick = time.monotonic()

    while remaining > 0:
        if msvcrt.kbhit():
            ch = msvcrt.getwch()
            if ch in ("\r", "\n"):
                print()
                if buf:
                    try:
                        return max(1, int(buf))
                    except ValueError:
                        return default
                return default
            elif ch == "\x08":  # backspace
                buf = buf[:-1]
                remaining = timeout
                last_tick = time.monotonic()
                _draw(remaining)
            elif ch.isdigit():
                buf += ch
                remaining = timeout
                last_tick = time.monotonic()
                _draw(remaining)
        now = time.monotonic()
        if now - last_tick >= 1.0:
            remaining -= 1
            last_tick = now
            _draw(remaining)
        time.sleep(0.05)

    print()
    if buf:
        try:
            return max(1, int(buf))
        except ValueError:
            return default
    return default





# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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
    limit = 25
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


# ---------------------------------------------------------------------------
# Scanner (unchanged)
# ---------------------------------------------------------------------------

def worker_process(work_queue, result_queue, heap_limit):
    """Worker process that scans directories from the work queue."""
    local_heap = []

    while True:
        msg = work_queue.get()
        if msg is None:
            result_queue.put(('heap', local_heap))
            break

        dirpath = msg
        size_direct = 0
        count_direct = 0
        subdirs = []

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

                            if len(local_heap) < heap_limit:
                                heapq.heappush(local_heap, (file_size, entry.path))
                            elif file_size > local_heap[0][0]:
                                heapq.heapreplace(local_heap, (file_size, entry.path))

                        elif entry.is_dir(follow_symlinks=False):
                            subdirs.append(entry.path)

                    except OSError:
                        continue
        except OSError:
            pass

        result_queue.put(('result', dirpath, size_direct, count_direct, subdirs))


def scan_folders(
    target: Path,
    limit: int,
) -> tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
    manager = Manager()
    work_queue = manager.Queue()
    result_queue = manager.Queue()

    num_workers = max(1, os.cpu_count() or 4)
    workers = []
    for _ in range(num_workers):
        p = Process(target=worker_process, args=(work_queue, result_queue, limit))
        p.start()
        workers.append(p)

    root_str = str(target.resolve())
    work_queue.put(root_str)
    pending = 1

    dir_direct_size = {}
    dir_direct_count = {}
    dir_children = {}

    while pending > 0:
        msg = result_queue.get()
        msg_type = msg[0]

        if msg_type == 'result':
            dirpath = msg[1]
            size_direct = msg[2]
            count_direct = msg[3]
            subdirs = msg[4]

            dir_direct_size[dirpath] = size_direct
            dir_direct_count[dirpath] = count_direct
            dir_children[dirpath] = subdirs

            for subdir in subdirs:
                work_queue.put(subdir)
                pending += 1

            pending -= 1

    for _ in workers:
        work_queue.put(None)

    all_heaps = []
    for _ in workers:
        msg = result_queue.get()
        if msg[0] == 'heap':
            all_heaps.append(msg[1])

    for w in workers:
        w.join()

    merged_heap = []
    for h in all_heaps:
        merged_heap.extend(h)
    top_files = heapq.nlargest(limit, merged_heap) if merged_heap else []

    dirs_by_depth = sorted(
        dir_children.keys(),
        key=lambda d: d.count(os.sep),
        reverse=True,
    )

    size_totals = {}
    count_totals = {}

    for dirpath in dirs_by_depth:
        total_size = dir_direct_size.get(dirpath, 0)
        total_count = dir_direct_count.get(dirpath, 0)

        for child in dir_children.get(dirpath, []):
            total_size += size_totals.get(child, 0)
            total_count += count_totals.get(child, 0)

        size_totals[dirpath] = total_size
        count_totals[dirpath] = total_count

    return size_totals, count_totals, top_files


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def _con_table(title: str, lines: list[str], *, colour: str = CYAN) -> None:
    """Print a titled table wrapped in coloured box-drawing borders."""
    all_lines = [f"{BOLD}{WHITE}{title}{RESET}", ""] + lines
    width = max(_visible_len(line) for line in all_lines) + 2
    bar = DASH * width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")
    # Title row
    pad = width - 1 - _visible_len(all_lines[0])
    print(f"  {colour}{PIPE}{RESET} {all_lines[0]}{' ' * pad}{colour}{PIPE}{RESET}")
    # Separator after title
    print(f"  {colour}{TEE}{bar}{BOX_R_TEE}{RESET}")
    # Content rows (skip the blank line at index 1)
    for i, line in enumerate(all_lines[2:]):
        pad = width - 1 - _visible_len(line)
        print(f"  {colour}{PIPE}{RESET} {line}{' ' * pad}{colour}{PIPE}{RESET}")
        # Blank line after the header row (first content row)
        if i == 0 and len(all_lines) > 3:
            print(f"  {colour}{PIPE}{RESET}{' ' * width}{colour}{PIPE}{RESET}")
    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")


def _folder_row(
    rank: int,
    max_rank: int,
    size_h: str,
    size_w: int,
    pct: float,
    files_total: int,
    cnt_w: int,
    rel_path: str,
    folder_avg: float,
    avg_file_size: float,
) -> str:
    rank_s = (str(rank) + ".").ljust(max_rank + 2)
    size_s = size_h.ljust(size_w)
    pct_s = f"{pct:.1f}%".ljust(6)
    files_str = f"{files_total:,}"

    if avg_file_size > 0 and folder_avg >= 2 * avg_file_size:
        files_s = f"{BOLD}{RED}{files_str}{RESET}".ljust(
            cnt_w + len(BOLD) + len(RED) + len(RESET)
        )
    elif avg_file_size > 0 and folder_avg >= 1.5 * avg_file_size:
        files_s = f"{BOLD}{ORANGE}{files_str}{RESET}".ljust(
            cnt_w + len(BOLD) + len(ORANGE) + len(RESET)
        )
    else:
        files_s = files_str.ljust(cnt_w)

    return f"{DIM}{rank_s}{RESET}  {WHITE}{size_s}{RESET}  {DIM}{pct_s}{RESET}  {files_s}   {DIM}{rel_path}{RESET}"


def rank_and_print(
    target: Path,
    size_totals: Dict[str, int],
    count_totals: Dict[str, int],
    limit: int,
    top_files: List[Tuple[int, str]],
    elapsed: float = 0.0,
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
        _con_warn(f"No subfolders found under {root}")
        return

    by_size = sorted(entries, key=lambda x: x[1], reverse=True)[:limit]
    by_count = sorted(entries, key=lambda x: x[2], reverse=True)[:limit]

    max_rank = max(len(str(len(by_size))), len(str(len(by_count))))
    size_w = max(10, max((len(human_size(s)) for _, s, _ in by_size), default=10))
    cnt_w = max(
        6, max((len(f"{c:,}") for _, _, c in (by_size + by_count)), default=6)
    )

    avg_file_size = total_size / total_files if total_files > 0 else 0

    # Summary box (with legend)
    print()
    _con_box(
        [
            f"folder_stats   {DIM}top-{limit}{RESET}",
            "",
            f"  {target}",
            f"  {DIM}Size{RESET}  {WHITE}{human_size(total_size)}{RESET}"
            f"      {DIM}Files{RESET}  {WHITE}{total_files:,}{RESET}"
            f"      {DIM}Scanned in{RESET} {WHITE}{elapsed:.2f}s{RESET}",
            "",
            f"  {BOLD}{ORANGE}1.5-2x avg{RESET}  "
            f"{BOLD}{RED}2x+ avg{RESET}",
        ],
        colour=BOX_DARK,
    )

    # Build header line for folder tables
    header_rank = "#".ljust(max_rank + 2)
    header_size = "SIZE".ljust(size_w)
    header_pct = "%".ljust(6)
    header_files = "FILES".ljust(cnt_w)
    header = f"{DIM}{header_rank}  {header_size}  {header_pct}  {header_files}   PATH{RESET}"

    # --- Top by size (yellow) ---
    size_rows = [header]
    for idx, (path_str, bytes_total, files_total) in enumerate(by_size, start=1):
        size_pct = (bytes_total / total_size * 100) if total_size > 0 else 0
        folder_avg = bytes_total / files_total if files_total > 0 else 0
        rel_path = str(Path(path_str).relative_to(root))
        size_rows.append(_folder_row(
            idx, max_rank, human_size(bytes_total), size_w,
            size_pct, files_total, cnt_w, rel_path,
            folder_avg, avg_file_size,
        ))

    print()
    _con_table("Size", size_rows, colour=BLUE_ACCENT)

    # --- Top by file count (green) ---
    count_rows = [header]
    for idx, (path_str, bytes_total, files_total) in enumerate(by_count, start=1):
        size_pct = (bytes_total / total_size * 100) if total_size > 0 else 0
        folder_avg = bytes_total / files_total if files_total > 0 else 0
        rel_path = str(Path(path_str).relative_to(root))
        count_rows.append(_folder_row(
            idx, max_rank, human_size(bytes_total), size_w,
            size_pct, files_total, cnt_w, rel_path,
            folder_avg, avg_file_size,
        ))

    print()
    _con_table("Files", count_rows, colour=BLUE_ACCENT)

    # Compute max content width from the folder tables to cap the file table
    folder_content_width = max(
        max((_visible_len(r) for r in size_rows), default=0),
        max((_visible_len(r) for r in count_rows), default=0),
    )

    # --- Top largest files (magenta) ---
    file_rows: list[str] = []
    if top_files:
        file_size_w = max(
            10, max((len(human_size(s)) for s, _ in top_files), default=10)
        )
        file_rank_h = "#".ljust(max_rank + 2)
        file_size_h = "SIZE".ljust(file_size_w)
        file_header = f"{DIM}{file_rank_h}  {file_size_h}   PATH{RESET}"
        file_rows.append(file_header)

        # Fixed prefix width: rank + gap + size + gap
        prefix_w = (max_rank + 2) + 2 + file_size_w + 3
        max_path_w = max(1, folder_content_width - prefix_w)

        for idx, (file_size, file_path) in enumerate(top_files, start=1):
            rank_s = (str(idx) + ".").ljust(max_rank + 2)
            size_s = human_size(file_size).ljust(file_size_w)
            rel_file_path = str(Path(file_path).relative_to(root))
            if _visible_len(rel_file_path) > max_path_w:
                rel_file_path = ".." + rel_file_path[-(max_path_w - 2):]
            file_rows.append(
                f"{DIM}{rank_s}{RESET}  {WHITE}{size_s}{RESET}   {DIM}{rel_file_path}{RESET}"
            )
    else:
        file_rows.append(f"{DIM}(no files){RESET}")

    print()
    _con_table("Individual", file_rows, colour=PINK_ACCENT)

    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    script_dir = Path(__file__).parent
    target, limit = parse_args(sys.argv, script_dir)

    transient_lines = 0

    # If running without command line args (double-clicked), prompt for limit
    if len(sys.argv) == 1:
        print()
        transient_lines += 1
        _con_box(
            [
                "folder_stats",
                "",
                f"  {script_dir}",
            ],
            colour=BOX_DARK,
        )
        transient_lines += 5  # top + 3 content + bottom
        print()
        transient_lines += 1
        limit = _con_prompt_timed("Results per table?", default=limit)
        transient_lines += 1
        print()
        transient_lines += 1

    try:
        target = target.resolve()
    except Exception as e:
        _con_warn(f"Failed to resolve target: {e}")
        _wait_any_key()
        return

    if not target.exists():
        _con_warn(f"Target not found: {target}")
        _wait_any_key()
        return

    if not target.is_dir():
        _con_warn(f"Target is not a directory: {target}")
        _wait_any_key()
        return

    _con_ok(f"Scanning {DIM}{target}{RESET} ...")
    transient_lines += 1

    t0 = time.perf_counter()
    try:
        size_totals, count_totals, top_files = scan_folders(target, limit)
    except Exception as e:
        _con_warn(f"Failed while scanning: {e}")
        _wait_any_key()
        return
    elapsed = time.perf_counter() - t0

    # Clear all transient output before showing results
    _clear_up(transient_lines)

    rank_and_print(target, size_totals, count_totals, limit, top_files, elapsed)

    _wait_any_key()


if __name__ == "__main__":
    mp.freeze_support()
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n\n  {DIM}Cancelled.{RESET}\n")
    except Exception:
        import traceback
        traceback.print_exc()
        _wait_any_key()