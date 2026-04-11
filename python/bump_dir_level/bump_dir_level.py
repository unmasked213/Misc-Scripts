# -*- coding: utf-8 -*-
"""
bump_dir_level.py - move contents of all subfolders up into the current folder

Place this script in a folder and double-click it. Every subfolder's
contents get moved up, then the empty subfolders are removed.
If a name conflict exists, the moved item gets a numeric suffix.

Usage
  Double-click, or:
    python bump_dir_level.py
    python bump_dir_level.py --dry-run
"""
from __future__ import annotations

import os
import re
import sys
import shutil
import time
import traceback
from pathlib import Path

os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


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
BOX_L_TEE = "\u251c"
BOX_R_TEE = "\u2524"


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
    DIM    = "\033[2m"
    BOLD   = "\033[1m"
    RESET  = "\033[0m"
    CYAN   = "\033[36m"
    GREEN  = "\033[32m"
    YELLOW = "\033[33m"
    RED    = "\033[31m"
    WHITE  = "\033[37m"
    GREY   = "\033[90m"
    MAGENTA = "\033[95m"
else:
    DIM = BOLD = RESET = CYAN = GREEN = YELLOW = RED = WHITE = GREY = MAGENTA = ""


_ANSI_RE = re.compile(r"\033\[[0-9;]*m")

SCRIPT_NAME    = Path(__file__).name
COUNTDOWN_SECS = 3


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


def _con_divider(width: int = 48) -> None:
    print(f"  {DIM}{DASH * width}{RESET}")


def _con_kv(key: str, value: str) -> None:
    print(f"  {DIM}{key:<12}{RESET} {value}")


def _con_prompt_timed(label: str, timeout: int = COUNTDOWN_SECS, default: str = "y") -> str:
    """Prompt with a live countdown. Returns default if no input within timeout."""
    import msvcrt

    def _draw(secs: int) -> None:
        line = f"  {YELLOW}{PIPE}{RESET} {label}    {BOLD}Y{RESET} ({DIM}..in {RESET}{BOLD}{MAGENTA}{secs}{RESET})            {DIM}N{RESET}"
        sys.stdout.write(f"\r{line}  ")
        sys.stdout.flush()

    remaining = timeout
    _draw(remaining)
    last_tick = time.monotonic()

    while remaining > 0:
        if msvcrt.kbhit():
            ch = msvcrt.getwch().lower()
            if ch in ("y", "\r", "\n"):
                print()
                return "y"
            if ch == "n":
                print()
                return "n"
        now = time.monotonic()
        if now - last_tick >= 1.0:
            remaining -= 1
            last_tick = now
            _draw(remaining)
        time.sleep(0.05)

    print()
    return default


def _con_warn(msg: str) -> None:
    print(f"\n  {RED}{PIPE}{RESET} {msg}")


def _con_ok(msg: str) -> None:
    print(f"  {GREEN}{PIPE}{RESET} {msg}")

def _clear_up(n: int) -> None:
    """Move cursor up n lines and clear each one."""
    for _ in range(n):
        sys.stdout.write(f"\033[1A\033[2K")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def unique_dest(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem = dest.stem
    suffix = dest.suffix
    parent = dest.parent
    n = 2
    while True:
        candidate = parent / f"{stem}_{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def unwrap_all(parent: Path, dry_run: bool = False) -> None:
    folders = sorted(
        (e for e in parent.iterdir() if e.is_dir() and not e.name.startswith(".")),
        key=lambda e: e.name.lower(),
    )

    if not folders:
        print()
        _con_warn("No subfolders found.")
        return

    # Gather moves, resolving conflicts with renames
    all_moves: list[tuple[Path, Path]] = []
    claimed: set[Path] = {parent / SCRIPT_NAME}

    for folder in folders:
        for entry in folder.iterdir():
            dest = unique_dest(parent / entry.name)
            while dest in claimed:
                dest = unique_dest(dest.parent / (dest.stem + "_2" + dest.suffix))
            claimed.add(dest)
            all_moves.append((entry, dest))

    total_items = len(all_moves)
    renames = sum(1 for src, dst in all_moves if src.name != dst.name)

    # Banner (stays on screen)
    banner = [
        "bump_dir_level",
        "",
        f"  {parent}",
        f"  Mode: {'DRY RUN' if dry_run else 'LIVE'}",
    ]
    print()
    _con_box(banner)

    # --- Everything below here gets replaced after confirm ---
    lines_after_banner = 0

    def _print(text: str = "") -> None:
        nonlocal lines_after_banner
        print(text)
        lines_after_banner += 1

    def _print_box(lines: list[str], *, colour: str = CYAN) -> None:
        nonlocal lines_after_banner
        _con_box(lines, colour=colour)
        lines_after_banner += len(lines) + 2  # content + top + bottom

    # Summary
    summary_lines = [
        f"Subfolders   {len(folders)}",
        f"Items        {total_items}",
    ]
    if renames:
        summary_lines.append(f"Renamed      {renames} {DIM}(conflict avoidance){RESET}")
    _print()
    _print_box(summary_lines, colour=YELLOW)

    # Tree preview
    preview_max = 4
    _print()
    shown_folders = folders[:preview_max]
    remaining_folders = len(folders) - len(shown_folders)

    _print(f"  {BOLD}{WHITE}{parent.name}/{RESET}")

    for i, folder in enumerate(shown_folders):
        moves = [(s, d) for s, d in all_moves if s.parent == folder]
        moves.sort(key=lambda t: (not t[0].is_dir(), t[0].name.lower()))

        dirs = sum(1 for s, _ in moves if s.is_dir())
        files = sum(1 for s, _ in moves if not s.is_dir())
        annotation = f"  {DIM}({dirs} folders, {files} files){RESET}" if dirs or files else ""

        is_last_folder = i == len(shown_folders) - 1 and remaining_folders == 0
        connector = f"{YELLOW}{ELBOW}{DASH}{DASH}{RESET} " if is_last_folder else f"{YELLOW}{TEE}{DASH}{DASH}{RESET} "
        extension = "    " if is_last_folder else f"{YELLOW}{PIPE}{RESET}   "

        _print(f"  {connector}{BOLD}{WHITE}{folder.name}/{RESET}{annotation}")

        shown_items = moves[:preview_max]
        remaining_items = len(moves) - len(shown_items)

        for j, (src, dst) in enumerate(shown_items):
            is_last = j == len(shown_items) - 1 and remaining_items == 0
            child_conn = f"{YELLOW}{ELBOW}{DASH}{DASH}{RESET} " if is_last else f"{YELLOW}{TEE}{DASH}{DASH}{RESET} "
            if src.is_dir():
                name = f"{WHITE}{src.name}/{RESET}"
            else:
                name = f"{DIM}{src.name}{RESET}"
            renamed = f"  {YELLOW}\u2192 {dst.name}{RESET}" if src.name != dst.name else ""
            _print(f"  {extension}{child_conn}{name}{renamed}")

        if remaining_items:
            _print(f"  {extension}{YELLOW}{ELBOW}{DASH}{DASH}{RESET} {DIM}..and {remaining_items} more{RESET}")

    if remaining_folders:
        _print(f"  {YELLOW}{ELBOW}{DASH}{DASH}{RESET} {DIM}..and {remaining_folders} more subfolder{'s' if remaining_folders != 1 else ''}{RESET}")

    # Confirm
    if not dry_run:
        _print()
        confirm = _con_prompt_timed("Proceed?")
        lines_after_banner += 1  # the prompt line itself
        if confirm not in ("y", "yes"):
            print()
            _con_warn("Cancelled.")
            return

    # Rewind and clear everything below the banner
    _clear_up(lines_after_banner)

    # Execute
    moved = 0
    errors: list[str] = []
    for folder in folders:
        moves = [(s, d) for s, d in all_moves if s.parent == folder]
        for src, dst in moves:
            if not dry_run:
                shutil.move(str(src), str(dst))
            moved += 1

        if not dry_run:
            try:
                folder.rmdir()
            except OSError:
                errors.append(f"{folder.name}/ not empty, left in place")

    # Results (printed in place of the old preview)
    print()
    done_lines = [f"Done.        {moved} moved"]
    if renames:
        done_lines.append(f"             {renames} renamed")
    if dry_run:
        done_lines.append(f"             DRY RUN (nothing changed)")
    _con_box(done_lines, colour=GREEN)

    for err in errors:
        print()
        _con_warn(err)

    print()


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    parent = Path(__file__).parent.resolve()
    unwrap_all(parent, dry_run)


def _countdown(seconds: int = COUNTDOWN_SECS) -> None:
    for i in range(seconds, 0, -1):
        sys.stdout.write(f"\r  {CYAN}{PIPE}{RESET} {DIM}Closing in {RESET}{BOLD}{MAGENTA}{i}{RESET}{DIM}..{RESET}  ")
        sys.stdout.flush()
        time.sleep(1)
    sys.stdout.write("\r" + " " * 40 + "\r")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n\n  {DIM}Cancelled.{RESET}\n")
    except Exception:
        traceback.print_exc()
    finally:
        _countdown()