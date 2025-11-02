"""
Recursive video analyzer using ffprobe.
- Scans subfolders automatically.
- Analyzes both resolution and duration.
- Skips broken/unreadable files (I/O errors, corrupt files, etc.).
- Groups results into resolution buckets (landscape & portrait) and duration buckets.
- Shows progress percentage.
- Prints clean summary for both metrics.
- Writes names of skipped files to 'skipped_files.txt' (same folder) if any.
"""

import math
import json
import subprocess
import sys
from pathlib import Path
from collections import Counter

# Config
SNAP_TOLERANCE = 400
TOP_OTHER_EXAMPLES = 10
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"}

COMMON_RESOLUTIONS = {
    "480p":   (640, 480),
    "720p":   (1280, 720),
    "1080p":  (1920, 1080),
    "1440p":  (2560, 1440),
    "4K":     (3840, 2160),
    "8K":     (7680, 4320),

    "480p vertical":   (480, 640),
    "720p vertical":   (720, 1280),
    "1080p vertical":  (1080, 1920),
    "1440p vertical":  (1440, 2560),
    "4K vertical":     (2160, 3840),
    "8K vertical":     (4320, 7680),
}

DURATION_BUCKETS = [
    ("Under 1 min", 0, 60),
    ("1-3 min", 60, 180),
    ("3-5 min", 180, 300),
    ("5-10 min", 300, 600),
    ("10-20 min", 600, 1200),
    ("20-30 min", 1200, 1800),
    ("30-60 min", 1800, 3600),
    ("Over 60 min", 3600, float("inf")),
]

SIZE_BUCKETS = [
    ("Under 10 MB", 0, 10 * 1024 * 1024),
    ("10-50 MB", 10 * 1024 * 1024, 50 * 1024 * 1024),
    ("50-100 MB", 50 * 1024 * 1024, 100 * 1024 * 1024),
    ("100-500 MB", 100 * 1024 * 1024, 500 * 1024 * 1024),
    ("500 MB-1 GB", 500 * 1024 * 1024, 1024 * 1024 * 1024),
    ("1-5 GB", 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024),
    ("5-10 GB", 5 * 1024 * 1024 * 1024, 10 * 1024 * 1024 * 1024),
    ("Over 10 GB", 10 * 1024 * 1024 * 1024, float("inf")),
]

def is_video_file(path: Path) -> bool:
    try:
        return path.suffix.lower() in VIDEO_EXTS
    except (OSError, PermissionError):
        return False

def nearest_bucket(width: int, height: int) -> str:
    best_name, best_dist = None, float("inf")
    for name, (w, h) in COMMON_RESOLUTIONS.items():
        dist = math.hypot(width - w, height - h)
        if dist < best_dist:
            best_name, best_dist = name, dist
    return best_name if best_dist <= SNAP_TOLERANCE else "Other"

def duration_bucket(seconds: float) -> str:
    for name, min_sec, max_sec in DURATION_BUCKETS:
        if min_sec <= seconds < max_sec:
            return name
    return "Unknown"

def size_bucket(bytes_size: int) -> str:
    for name, min_bytes, max_bytes in SIZE_BUCKETS:
        if min_bytes <= bytes_size < max_bytes:
            return name
    return "Unknown"

def resolve_ffprobe(script_dir: Path) -> str:
    local = script_dir / "ffprobe.exe"
    return str(local) if local.exists() else "ffprobe"

def get_video_info_ffprobe(ffprobe_cmd: str, file_path: Path):
    try:
        cmd = [
            ffprobe_cmd, "-v", "quiet",
            "-print_format", "json",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height:format=duration",
            str(file_path)
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, timeout=20)
        if proc.returncode != 0:
            return "Other", None, "Unknown", None
        
        data = json.loads(proc.stdout or "{}")
        
        # Resolution
        res_bucket = "Other"
        raw_res = None
        streams = data.get("streams") or []
        if streams:
            w = int(streams[0].get("width", 0) or 0)
            h = int(streams[0].get("height", 0) or 0)
            if w and h:
                res_bucket = nearest_bucket(w, h)
                raw_res = (w, h)
        
        # Duration
        dur_bucket = "Unknown"
        raw_dur = None
        fmt = data.get("format") or {}
        duration_str = fmt.get("duration")
        if duration_str:
            duration = float(duration_str)
            if duration >= 0:
                dur_bucket = duration_bucket(duration)
                raw_dur = duration
        
        return res_bucket, raw_res, dur_bucket, raw_dur
    except Exception:
        return "Other", None, "Unknown", None

def gather_files(target: Path):
    files = []
    try:
        if target.is_file():
            if is_video_file(target):
                files.append(target)
        elif target.is_dir():
            for p in target.rglob("*"):
                try:
                    if p.is_file() and is_video_file(p):
                        files.append(p)
                except (OSError, PermissionError):
                    continue
    except (OSError, PermissionError):
        pass
    return files

def print_progress(idx, total):
    percent = (idx / total) * 100 if total else 100.0
    sys.stdout.write(f"\rProgress: {idx}/{total} ({percent:.1f}%)")
    sys.stdout.flush()

def format_duration(seconds):
    if seconds is None:
        return "N/A"
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    elif minutes > 0:
        return f"{minutes}m {secs}s"
    else:
        return f"{secs}s"

def format_size(bytes_size):
    if bytes_size is None:
        return "N/A"
    
    units = [("TB", 1024**4), ("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)]
    
    for unit, divisor in units:
        if bytes_size >= divisor:
            return f"{bytes_size / divisor:.2f} {unit}"
    
    return f"{bytes_size} bytes"

def main():
    script_dir = Path(__file__).parent
    ffprobe_cmd = resolve_ffprobe(script_dir)

    try:
        files = gather_files(script_dir)
    except Exception as e:
        print(f"Failed to access {script_dir}: {e}")
        input("Press Enter to exit...")
        return

    total = len(files)
    if total == 0:
        print("No video files found in", script_dir.resolve())
        input("Press Enter to exit...")
        return

    print(f"Scanning {total} video files in {script_dir.resolve()}...\n")

    res_counts = Counter()
    dur_counts = Counter()
    size_counts = Counter()
    other_raw = Counter()
    total_duration = 0.0
    total_size = 0
    skipped = []

    for idx, f in enumerate(files, start=1):
        try:
            res_bucket, raw_res, dur_bucket, raw_dur = get_video_info_ffprobe(ffprobe_cmd, f)
            res_counts[res_bucket] += 1
            dur_counts[dur_bucket] += 1
            
            if res_bucket == "Other" and raw_res:
                other_raw[f"{raw_res[0]}x{raw_res[1]}"] += 1
            
            if raw_dur is not None:
                total_duration += raw_dur
            
            file_size = f.stat().st_size
            size_counts[size_bucket(file_size)] += 1
            total_size += file_size
                
        except (OSError, PermissionError):
            skipped.append(f"{f}")
        except Exception:
            skipped.append(f"{f}")
        print_progress(idx, total)

    print("\n\n")
    print("RESOLUTION")
    print("-" * 40)
    
    base_resolutions = ["480p", "720p", "1080p", "1440p", "4K", "8K"]
    has_content = False
    
    for base in base_resolutions:
        landscape = res_counts.get(base, 0)
        portrait = res_counts.get(base + " vertical", 0)
        total_res = landscape + portrait
        
        if total_res:
            has_content = True
            if landscape and portrait:
                print(f"{base:<15} {total_res:>3}    ({landscape} landscape, {portrait} portrait)")
            elif landscape:
                print(f"{base:<15} {total_res:>3}    (landscape)")
            else:
                print(f"{base:<15} {total_res:>3}    (portrait)")
    
    if res_counts.get("Other"):
        has_content = True
        print(f"{'Other':<15} {res_counts['Other']:>3}")
    
    if not has_content:
        print("No files")
    
    if res_counts.get("Other") and other_raw:
        print()
        for res, cnt in other_raw.most_common(TOP_OTHER_EXAMPLES):
            print(f"  {res:<13} {cnt:>3}")
    
    print()
    print("DURATION")
    print("-" * 40)
    
    has_duration = False
    for name, _, _ in DURATION_BUCKETS:
        count = dur_counts.get(name, 0)
        if count:
            has_duration = True
            print(f"{name:<15} {count:>3}")
    
    if dur_counts.get("Unknown"):
        print(f"{'Unknown':<15} {dur_counts['Unknown']:>3}")
    
    if not has_duration and not dur_counts.get("Unknown"):
        print("No files")
    
    print()
    print("FILE SIZE")
    print("-" * 40)
    
    has_size = False
    for name, _, _ in SIZE_BUCKETS:
        count = size_counts.get(name, 0)
        if count:
            has_size = True
            print(f"{name:<15} {count:>3}")
    
    if size_counts.get("Unknown"):
        print(f"{'Unknown':<15} {size_counts['Unknown']:>3}")
    
    if not has_size and not size_counts.get("Unknown"):
        print("No files")
    
    print()
    print("SUMMARY")
    print("-" * 40)
    
    grand_total = sum(res_counts.values())
    print(f"{'Files analyzed':<15} {grand_total:>3}")
    print(f"{'Total duration':<15}   {format_duration(total_duration)}")
    print(f"{'Total size':<15}   {format_size(total_size)}")
    
    if skipped:
        try:
            (script_dir / "skipped_files.txt").write_text("\n".join(skipped), encoding="utf-8")
            print(f"{'Skipped files':<15} {len(skipped):>3}  (see skipped_files.txt)")
        except Exception:
            print(f"{'Skipped files':<15} {len(skipped):>3}  (could not write log)")
    
    print()
    print(f"{'Scanned':<15}   {script_dir.resolve()}")
    print()
    input("Press Enter to exit...")

if __name__ == "__main__":
    main()