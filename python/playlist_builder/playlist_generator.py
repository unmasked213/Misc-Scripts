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
import sys
import json
import subprocess
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Windows-safe UTF-8 console
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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
# ffprobe (unified)
# ------------------------------------------------------------

def probe_file(path):
    """Single ffprobe call returning orientation, duration, and bitrate.

    Checks three rotation sources in order:
      1. Stream tags (streams[0].tags.rotate) - most common
      2. Format tags (format.tags.rotate) - some encoders write here instead
      3. Display Matrix side_data - newer containers (MOV/MP4)
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_streams", "-show_format", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace"
        )
        if r.returncode != 0 or not r.stdout:
            return None

        data = json.loads(r.stdout)
        fmt = data.get("format", {})
        streams = data.get("streams", [])

        result = {"orientation": None, "duration": None, "bitrate": None}

        # Duration from format
        if fmt.get("duration"):
            try:
                result["duration"] = float(fmt["duration"])
            except (ValueError, TypeError):
                pass

        # Bitrate from stream or format
        br_raw = None
        if streams:
            br_raw = streams[0].get("bit_rate") or fmt.get("bit_rate")
        elif fmt.get("bit_rate"):
            br_raw = fmt["bit_rate"]
        if br_raw:
            try:
                result["bitrate"] = int(br_raw)
            except (ValueError, TypeError):
                pass

        # Orientation
        if not streams:
            return result

        vs = streams[0]
        w = int(vs.get("width", 0))
        h = int(vs.get("height", 0))
        if not w or not h:
            return result

        rotation = 0

        # Source 1: stream tags
        stream_tags = vs.get("tags", {})
        if "rotate" in stream_tags:
            try:
                rotation = int(stream_tags["rotate"])
            except (ValueError, TypeError):
                pass

        # Source 2: format tags
        if rotation == 0:
            fmt_tags = fmt.get("tags", {})
            if "rotate" in fmt_tags:
                try:
                    rotation = int(fmt_tags["rotate"])
                except (ValueError, TypeError):
                    pass

        # Source 3: Display Matrix side_data
        if rotation == 0:
            for sd in vs.get("side_data_list", []):
                if sd.get("side_data_type") == "Display Matrix" and "rotation" in sd:
                    try:
                        rotation = abs(int(sd["rotation"]))
                    except (ValueError, TypeError):
                        pass

        if rotation in (90, 270, -90, -270):
            w, h = h, w

        if w > h:
            result["orientation"] = "horizontal"
        elif h > w:
            result["orientation"] = "vertical"
        else:
            result["orientation"] = "square"

        return result
    except Exception:
        return None


def probe_all(entries):
    """Threaded batch probe. Returns {path: probe_result dict or None}."""
    if not entries:
        return {}

    total = len(entries)
    workers = min(total, max((os.cpu_count() or 4) * 4, 16))
    results = {}

    print(f"Probing metadata ({total} files, {workers} threads)...")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {executor.submit(probe_file, p): p for p in entries}
        for i, future in enumerate(as_completed(future_map), 1):
            path = future_map[future]
            try:
                results[path] = future.result()
            except Exception:
                results[path] = None
            if i % 50 == 0 or i == total:
                print(f"\r  Probed {i}/{total}...", end="", flush=True)

    print()
    return results


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
    for p in SCRIPT_DIR.glob("*playlist_*.m3u"):
        try:
            mtime = p.stat().st_mtime
            playlists.append((p, mtime))
        except (OSError, PermissionError):
            continue
    playlists.sort(key=lambda x: x[1], reverse=True)
    return [p for p, _ in playlists]


def new_playlist_path(orientation=None):
    prefix = {"horizontal": "Horz_", "vertical": "Vert_"}.get(orientation, "")
    return SCRIPT_DIR / f"{prefix}playlist_{SCRIPT_DIR.name}_{datetime.now():%Y%m%d_%H%M%S}.m3u"


# ------------------------------------------------------------
# Sorting
# ------------------------------------------------------------

def get_sort_key(mode, path, probe_cache=None):
    try:
        if mode == "1":
            return str(path).lower()
        
        stat = path.stat()
        
        if mode == "2":
            return stat.st_size
        if mode == "3":
            return stat.st_mtime
        if mode == "4":
            p = (probe_cache or {}).get(path)
            val = p.get("duration") if p else None
            return float(val) if val else 0.0
        if mode == "5":
            p = (probe_cache or {}).get(path)
            val = p.get("bitrate") if p else None
            return int(val) if val else stat.st_size
    except (OSError, PermissionError, ValueError):
        pass
    
    return 0


def sort_entries(entries, mode, descending, probe_cache=None):
    cache, total = {}, len(entries)
    for i, e in enumerate(entries, 1):
        print(f"\r  Analysing {i}/{total}...", end="", flush=True)
        cache[e] = get_sort_key(mode, e, probe_cache)
    print(f"\r  Sorting {total} entries...   ")
    return sorted(entries, key=cache.get, reverse=descending)


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------

def peek_playlist_has_video(path):
    """Sample first entries of a playlist to check for video files."""
    video_ext = EXTENSIONS["1"]
    try:
        for ln in path.read_text(encoding="utf-8").splitlines()[:20]:
            if ln.strip() and not ln.startswith("#"):
                if Path(ln).suffix.lower() in video_ext:
                    return True
    except (OSError, UnicodeDecodeError):
        pass
    return False


def split_by_orientation(entries, probe_cache):
    """Split entries into (horz, vert, dropped_count) using probe cache."""
    horz = [p for p in entries
            if (probe_cache.get(p) or {}).get("orientation") == "horizontal"]
    vert = [p for p in entries
            if (probe_cache.get(p) or {}).get("orientation") == "vertical"]
    dropped = len(entries) - len(horz) - len(vert)
    print(f"  {len(horz)} landscape, {len(vert)} portrait, {dropped} unclassified")
    return horz, vert, dropped


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


def menu_split_orientation():
    """Returns True to split by orientation, False to keep combined."""
    print("Orientation:\n\n  1  Combined (all videos)\n  2  Split (separate landscape and portrait playlists)\n")
    return prompt("Choice: ", {"1", "2"}) == "2"


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

    split = False
    if ftype == "1" and HAS_FFPROBE:
        split = menu_split_orientation()
        print()

    sort_choice = menu_sort()
    
    clear()
    print("WORKING\n")
    entries = scan(ftype)

    # Single probe pass if needed for sorting (duration/bitrate) or splitting
    needs_probe = split or (sort_choice and sort_choice[0] in ("4", "5"))
    probe_cache = probe_all(entries) if entries and needs_probe and HAS_FFPROBE else None

    if entries and sort_choice:
        entries = sort_entries(entries, *sort_choice, probe_cache=probe_cache)

    if entries and split and probe_cache:
        horz, vert, dropped = split_by_orientation(entries, probe_cache)
        results = []
        if horz:
            results.append((new_playlist_path("horizontal"), horz, dropped))
        if vert:
            results.append((new_playlist_path("vertical"), vert, 0))
        return results or [(new_playlist_path(), [], dropped)]

    return [(new_playlist_path(), entries, 0)]


def workflow_rescan(playlist_path):
    clear()
    print(f"RESCAN: {playlist_path.name}\n" + "-" * 40 + "\n")
    ftype = menu_files()
    print()

    split = False
    if ftype == "1" and HAS_FFPROBE:
        split = menu_split_orientation()
        print()

    sort_choice = menu_sort()
    
    clear()
    print("WORKING\n")
    entries = scan(ftype)

    needs_probe = split or (sort_choice and sort_choice[0] in ("4", "5"))
    probe_cache = probe_all(entries) if entries and needs_probe and HAS_FFPROBE else None

    if entries and sort_choice:
        entries = sort_entries(entries, *sort_choice, probe_cache=probe_cache)

    if entries and split and probe_cache:
        horz, vert, dropped = split_by_orientation(entries, probe_cache)
        results = []
        if horz:
            results.append((new_playlist_path("horizontal"), horz, dropped))
        if vert:
            results.append((new_playlist_path("vertical"), vert, 0))
        return results or [(playlist_path, [], dropped)]

    return [(playlist_path, entries, 0)]


def workflow_sort(playlist_path):
    clear()
    print(f"SORT: {playlist_path.name}\n" + "-" * 40 + "\n")

    split = False
    if HAS_FFPROBE and peek_playlist_has_video(playlist_path):
        split = menu_split_orientation()
        print()

    sort_choice = menu_sort()
    
    if not sort_choice and not split:
        print("\nNo changes selected.")
        return [(playlist_path, [], 0)]
    
    clear()
    print("WORKING\n")
    entries = load_playlist(playlist_path)
    
    if not entries:
        print("Empty or all files deleted.")
        return [(playlist_path, [], 0)]

    needs_probe = split or (sort_choice and sort_choice[0] in ("4", "5"))
    probe_cache = probe_all(entries) if needs_probe and HAS_FFPROBE else None

    if sort_choice:
        entries = sort_entries(entries, *sort_choice, probe_cache=probe_cache)

    if split and probe_cache:
        horz, vert, dropped = split_by_orientation(entries, probe_cache)
        results = []
        if horz:
            results.append((new_playlist_path("horizontal"), horz, dropped))
        if vert:
            results.append((new_playlist_path("vertical"), vert, 0))
        return results or [(playlist_path, [], dropped)]

    return [(playlist_path, entries, 0)]


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
            results = workflow_edit(selected)
        else:
            results = workflow_new()
    else:
        results = workflow_new()
    
    saved_any = False
    saved_playlists = []
    total_dropped = 0

    for playlist_path, entries, dropped in results:
        total_dropped += dropped
        if entries:
            if save_playlist(playlist_path, entries):
                saved_any = True
                saved_playlists.append((playlist_path, len(entries)))

    clear()
    if saved_any:
        print("=" * 50 + "\n  DONE\n" + "=" * 50)
        for path, count in saved_playlists:
            print(f"\nPlaylist: {path.name}\nLocation: {path.parent}\nEntries:  {count}")
        if total_dropped:
            print(f"\nDropped:  {total_dropped} (square, unreadable, or no video stream)")
    else:
        print("=" * 50 + "\n  NO OUTPUT\n" + "=" * 50)
        print("\nNo files found or playlist empty.")
    
    if not HAS_FFPROBE:
        print("\nNo ffprobe. Duration/bitrate used file size.")
    



if __name__ == "__main__":
    main()