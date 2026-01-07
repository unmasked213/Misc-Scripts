# ============================================================
# PLAYLIST GENERATOR
# ============================================================
#
# Drop this script into any folder containing media files.
# Run it to create a plain-text playlist of all videos, images,
# or audio files found in that folder and its subfolders.
#
# If a playlist already exists, you can either create a new one
# or edit the existing one by refreshing its contents or sorting
# it by name, size, date, duration, or bitrate.
#
# The output is an .m3u file with one absolute path per line,
# compatible with MPV, VLC, and most media players. Drag the
# file onto MPV to play.
#
# Optional: If ffprobe is available in PATH, duration and bitrate
# sorting will use actual media metadata. Otherwise, file size
# is used as a fallback.
#
# ============================================================

import os
import subprocess
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()

EXTENSIONS = {
    "1": {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v",
          ".ts", ".vob", ".mpg", ".mpeg", ".3gp", ".ogv"},
    "2": {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif", ".webp",
          ".heic", ".heif", ".avif", ".jxl"},
    "3": {".mp3", ".flac", ".wav", ".aac", ".ogg", ".opus", ".m4a", ".wma"},
}
EXTENSIONS["4"] = EXTENSIONS["1"] | EXTENSIONS["2"] | EXTENSIONS["3"]

SORT_OPTIONS = {
    "1": {"label": "Name", "asc": "A-Z", "desc": "Z-A"},
    "2": {"label": "Size", "asc": "Smallest", "desc": "Largest"},
    "3": {"label": "Date", "asc": "Oldest", "desc": "Newest"},
    "4": {"label": "Duration", "asc": "Shortest", "desc": "Longest"},
    "5": {"label": "Bitrate", "asc": "Lowest", "desc": "Highest"},
}


def detect_ffprobe():
    try:
        subprocess.run(["ffprobe", "-version"], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


HAS_FFPROBE = detect_ffprobe()


# ------------------------------------------------------------
# Terminal
# ------------------------------------------------------------

def clear():
    os.system("cls" if os.name == "nt" else "clear")


def prompt(msg, valid):
    while (c := input(msg).strip().lower()) not in valid:
        print(f"Invalid. Choose: {', '.join(sorted(valid))}")
    return c


# ------------------------------------------------------------
# ffprobe
# ------------------------------------------------------------

def ffprobe_field(path, field):
    if not HAS_FFPROBE:
        return None
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", f"format={field}",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=10
        )
        return r.stdout.strip() or None
    except (subprocess.TimeoutExpired, subprocess.SubprocessError):
        return None


# ------------------------------------------------------------
# File operations
# ------------------------------------------------------------

def scan(mode):
    print("Scanning...")
    ext, results = EXTENSIONS[mode], []
    for p in SCRIPT_DIR.rglob("*"):
        try:
            if p.is_file() and p.suffix.lower() in ext:
                results.append(p)
                print(f"\r  Found {len(results)}...", end="", flush=True)
        except (OSError, PermissionError):
            continue
    print()
    return results


def load_playlist(path):
    print("Loading...")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        print("  Failed to read playlist.")
        return []
    
    valid = []
    for ln in lines:
        if ln.strip() and not ln.startswith("#"):
            try:
                p = Path(ln)
                if p.exists():
                    valid.append(p)
            except (OSError, PermissionError):
                continue
    
    print(f"  {len(valid)} valid entries.")
    return valid


def save_playlist(path, entries):
    print("Writing...")
    content = "#EXTM3U\n" + "\n".join(str(p) for p in entries) + "\n"
    try:
        path.write_text(content, encoding="utf-8")
        return True
    except (OSError, PermissionError) as e:
        print(f"  Failed to save: {e}")
        return False


def find_playlists():
    playlists = []
    for p in SCRIPT_DIR.glob("playlist_*.m3u"):
        try:
            mtime = p.stat().st_mtime
            playlists.append((p, mtime))
        except (OSError, PermissionError):
            continue
    playlists.sort(key=lambda x: x[1], reverse=True)
    return [p for p, _ in playlists]


def new_playlist_path():
    return SCRIPT_DIR / f"playlist_{SCRIPT_DIR.name}_{datetime.now():%Y%m%d_%H%M%S}.m3u"


# ------------------------------------------------------------
# Sorting
# ------------------------------------------------------------

def get_sort_key(mode, path):
    try:
        if mode == "1":
            return str(path).lower()
        
        stat = path.stat()
        
        if mode == "2":
            return stat.st_size
        if mode == "3":
            return stat.st_mtime
        if mode == "4":
            val = ffprobe_field(path, "duration")
            return float(val) if val else 0.0
        if mode == "5":
            val = ffprobe_field(path, "bit_rate")
            return int(val) if val else stat.st_size
    except (OSError, PermissionError, ValueError):
        pass
    
    return 0


def sort_entries(entries, mode, descending):
    cache, total = {}, len(entries)
    for i, e in enumerate(entries, 1):
        print(f"\r  Analysing {i}/{total}...", end="", flush=True)
        cache[e] = get_sort_key(mode, e)
    print(f"\r  Sorting {total} entries...   ")
    return sorted(entries, key=cache.get, reverse=descending)


# ------------------------------------------------------------
# Menus
# ------------------------------------------------------------

def menu_files():
    print("File types:\n\n  1  Videos\n  2  Images\n  3  Audio\n  4  All\n")
    return prompt("Choice: ", {"1", "2", "3", "4"})


def menu_sort():
    """Returns (mode, descending) or None if no sorting selected."""
    print("Sort by:\n\n  0  None")
    for key, opt in SORT_OPTIONS.items():
        suffix = " (no ffprobe)" if key in ("4", "5") and not HAS_FFPROBE else ""
        print(f"  {key}  {opt['label']}{suffix}")
    print()
    
    choice = prompt("Choice: ", {"0", "1", "2", "3", "4", "5"})
    if choice == "0":
        return None
    
    opt = SORT_OPTIONS[choice]
    print(f"\nOrder:\n\n  1  {opt['asc']}\n  2  {opt['desc']}\n")
    descending = prompt("Choice: ", {"1", "2"}) == "2"
    
    return (choice, descending)


def menu_playlist(playlists):
    print(f"Found {len(playlists)} playlist(s):\n")
    for i, p in enumerate(playlists[:5], 1):
        try:
            mt = datetime.fromtimestamp(p.stat().st_mtime)
            lines = p.read_text(encoding="utf-8").splitlines()
            cnt = sum(1 for ln in lines if ln.strip() and not ln.startswith("#"))
            print(f"  {i}  {p.name}\n     {mt:%Y-%m-%d %H:%M}  |  {cnt} entries\n")
        except (OSError, UnicodeDecodeError):
            print(f"  {i}  {p.name}\n     (unreadable)\n")
    print("  N  New playlist\n")
    
    valid = {"n"} | {str(i) for i in range(1, min(6, len(playlists) + 1))}
    choice = prompt("Choice: ", valid)
    
    return None if choice == "n" else playlists[int(choice) - 1]


def menu_edit():
    print("  1  Rescan\n  2  Sort only\n")
    return prompt("Choice: ", {"1", "2"})


# ------------------------------------------------------------
# Workflows
# ------------------------------------------------------------

def workflow_new():
    clear()
    print("NEW PLAYLIST\n" + "-" * 40 + "\n")
    ftype = menu_files()
    print()
    sort_choice = menu_sort()
    
    clear()
    print("WORKING\n")
    entries = scan(ftype)
    
    if entries and sort_choice:
        entries = sort_entries(entries, *sort_choice)
    
    return new_playlist_path(), entries


def workflow_rescan(playlist_path):
    clear()
    print(f"RESCAN: {playlist_path.name}\n" + "-" * 40 + "\n")
    ftype = menu_files()
    print()
    sort_choice = menu_sort()
    
    clear()
    print("WORKING\n")
    entries = scan(ftype)
    
    if entries and sort_choice:
        entries = sort_entries(entries, *sort_choice)
    
    return playlist_path, entries


def workflow_sort(playlist_path):
    clear()
    print(f"SORT: {playlist_path.name}\n" + "-" * 40 + "\n")
    sort_choice = menu_sort()
    
    if not sort_choice:
        print("\nNo sorting selected.")
        input("\nEnter to exit.")
        return playlist_path, []
    
    clear()
    print("WORKING\n")
    entries = load_playlist(playlist_path)
    
    if not entries:
        print("Empty or all files deleted.")
        input("\nEnter to exit.")
        return playlist_path, []
    
    entries = sort_entries(entries, *sort_choice)
    return playlist_path, entries


def workflow_edit(playlist_path):
    clear()
    print(f"EDIT: {playlist_path.name}\n\n")
    action = menu_edit()
    
    if action == "1":
        return workflow_rescan(playlist_path)
    return workflow_sort(playlist_path)


# ------------------------------------------------------------
# Main
# ------------------------------------------------------------

def main():
    playlists = find_playlists()
    
    if playlists:
        clear()
        selected = menu_playlist(playlists)
        if selected:
            playlist_path, entries = workflow_edit(selected)
        else:
            playlist_path, entries = workflow_new()
    else:
        playlist_path, entries = workflow_new()
    
    if entries:
        saved = save_playlist(playlist_path, entries)
    else:
        saved = False
    
    clear()
    if saved:
        print("=" * 50 + "\n  DONE\n" + "=" * 50)
        print(f"\nPlaylist: {playlist_path.name}\nLocation: {playlist_path.parent}\nEntries:  {len(entries)}")
    else:
        print("=" * 50 + "\n  NO OUTPUT\n" + "=" * 50)
        if not entries:
            print("\nNo files found or playlist empty.")
    
    if not HAS_FFPROBE:
        print("\nNo ffprobe. Duration/bitrate used file size.")
    
    input("\nEnter to exit.")


if __name__ == "__main__":
    main()