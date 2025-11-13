"""
Recursive image analyzer.
- Scans subfolders automatically.
- Analyzes both resolution and file size.
- Skips broken/unreadable files (I/O errors, corrupt files, etc.).
- Groups results into resolution buckets (landscape & portrait)
  and size buckets.
- Shows progress percentage.
- Prints clean summary for both metrics.
- Writes names of skipped files to 'skipped_files.txt' (same folder) if any.
"""

import math
import sys
from pathlib import Path
from collections import Counter
from PIL import Image

# Config
SNAP_TOLERANCE = 400
TOP_OTHER_EXAMPLES = 10
IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp",
    ".webp", ".tiff", ".tif", ".ico"
}

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

SIZE_BUCKETS = [
    ("Under 100 KB", 0, 100 * 1024),
    ("100-500 KB", 100 * 1024, 500 * 1024),
    ("500 KB-1 MB", 500 * 1024, 1024 * 1024),
    ("1-5 MB", 1024 * 1024, 5 * 1024 * 1024),
    ("5-10 MB", 5 * 1024 * 1024, 10 * 1024 * 1024),
    ("10-50 MB", 10 * 1024 * 1024, 50 * 1024 * 1024),
    ("50-100 MB", 50 * 1024 * 1024, 100 * 1024 * 1024),
    ("Over 100 MB", 100 * 1024 * 1024, float("inf")),
]


def is_image_file(path: Path) -> bool:
    try:
        return path.suffix.lower() in IMAGE_EXTS
    except (OSError, PermissionError):
        return False


def nearest_bucket(width: int, height: int) -> str:
    best_name, best_dist = None, float("inf")
    for name, (w, h) in COMMON_RESOLUTIONS.items():
        dist = math.hypot(width - w, height - h)
        if dist < best_dist:
            best_name, best_dist = name, dist
    return best_name if best_dist <= SNAP_TOLERANCE else "Other"


def size_bucket(bytes_size: int) -> str:
    for name, min_bytes, max_bytes in SIZE_BUCKETS:
        if min_bytes <= bytes_size < max_bytes:
            return name
    return "Unknown"


def get_image_info(file_path: Path):
    try:
        with Image.open(file_path) as img:
            width, height = img.size
            if width and height:
                res_bucket = nearest_bucket(width, height)
                return res_bucket, (width, height)
        return "Other", None
    except Exception:
        return "Other", None


def gather_files(target: Path):
    files = []
    try:
        if target.is_file():
            if is_image_file(target):
                files.append(target)
        elif target.is_dir():
            for p in target.rglob("*"):
                try:
                    if p.is_file() and is_image_file(p):
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

    try:
        files = gather_files(script_dir)
    except Exception as e:
        print(f"Failed to access {script_dir}: {e}")
        input("Press Enter to exit...")
        return

    total = len(files)
    if total == 0:
        print("No image files found in", script_dir.resolve())
        input("Press Enter to exit...")
        return

    print(f"Scanning {total} image files in {script_dir.resolve()}...\n")

    res_counts = Counter()
    size_counts = Counter()
    format_counts = Counter()
    other_raw = Counter()
    total_size = 0
    skipped = []

    for idx, f in enumerate(files, start=1):
        try:
            res_bucket, raw_res = get_image_info(f)
            res_counts[res_bucket] += 1

            if res_bucket == "Other" and raw_res:
                other_raw[f"{raw_res[0]}x{raw_res[1]}"] += 1

            file_size = f.stat().st_size
            size_counts[size_bucket(file_size)] += 1
            total_size += file_size
            
            format_counts[f.suffix.lower().lstrip('.')] += 1

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
    print("FILE FORMAT")
    print("-" * 40)
    
    if format_counts:
        for fmt, cnt in format_counts.most_common():
            print(f"{fmt.upper():<15} {cnt:>3}")
    else:
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