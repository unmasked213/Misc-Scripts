"""
Media Spec Analyzer (double-click friendly, terminal output, AI-usable)

Usage (normal):
    - Double-click the file in any folder.
    - It scans that folder recursively.
    - Shows a clean summary and waits for Enter before closing.

Usage (advanced, terminal):
    python media_spec.py --details
    python media_spec.py --path "X:/Videos"   # hidden feature

Performance notes:
    - ffprobe calls are I/O-bound. This script uses a bounded thread pool to run many
      ffprobe subprocesses concurrently on Windows without multiprocessing overhead.
    - Override parallelism with env var MEDIA_SPEC_WORKERS (integer, 1-256).
"""

from __future__ import annotations
import sys
import os
import math
import json
import subprocess
from pathlib import Path
from collections import Counter, defaultdict
from statistics import median
from typing import Dict, Tuple, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

# UTF-8 everywhere (Windows-safe)
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# -------------------------------
# Config
# -------------------------------
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"}
SNAP_TOLERANCE = 400
TOP_OTHER_EXAMPLES = 10
FFPROBE_TIMEOUT_SEC = 20
DASH = "-" * 40  # D2 width

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

# Subprocess flags for Windows - suppresses console window per ffprobe call
# Set to 0 to disable if ffprobe fails silently on your system
_CREATION_FLAGS = 0

# -------------------------------
# Utilities
# -------------------------------


def resolve_ffprobe(script_dir: Path) -> str:
    local = script_dir / "ffprobe.exe"
    return str(local) if local.exists() else "ffprobe"



def nearest_bucket(width: int, height: int) -> str:
    best_name, best_dist = None, float("inf")
    for name, (w, h) in COMMON_RESOLUTIONS.items():
        dist = math.hypot(width - w, height - h)
        if dist < best_dist:
            best_name, best_dist = name, dist
    return best_name if best_dist <= SNAP_TOLERANCE else "Other"



def duration_bucket(seconds: float) -> str:
    for name, lo, hi in DURATION_BUCKETS:
        if lo <= seconds < hi:
            return name
    return "Unknown"



def size_bucket(b: int) -> str:
    for name, lo, hi in SIZE_BUCKETS:
        if lo <= b < hi:
            return name
    return "Unknown"



def parse_fps(avg_frame_rate: Optional[str]) -> Optional[float]:
    if not avg_frame_rate or avg_frame_rate in ("0/0", "0", "N/A"):
        return None
    if "/" in avg_frame_rate:
        try:
            n, d = avg_frame_rate.split("/", 1)
            n = float(n); d = float(d)
            return (n / d) if d else None
        except ValueError:
            return None
    try:
        return float(avg_frame_rate)
    except ValueError:
        return None



def human_size(b: Optional[int]) -> str:
    if b is None:
        return "N/A"
    units = [("TB", 1024**4), ("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)]
    for u, d in units:
        if b >= d:
            return f"{b / d:.2f} {u}"
    return f"{b} bytes"



def human_duration(sec: Optional[float]) -> str:
    if sec is None:
        return "N/A"
    s = int(sec)
    h = s // 3600
    m = (s % 3600) // 60
    s2 = s % 60
    return f"{h}h {m}m {s2}s" if h else (f"{m}m {s2}s" if m else f"{s2}s")



def hdr_label(transfer: str | None, side_data_types: str | None) -> str:
    t = (transfer or "").lower()
    s = (side_data_types or "").lower()
    if "dolby vision" in s:
        return "Dolby Vision"
    if t == "smpte2084":
        return "HDR10"
    if t == "arib-std-b67":
        return "HLG"
    return "SDR"



def kbps(bits: Optional[int]) -> Optional[float]:
    return (bits / 1000.0) if bits is not None else None



def median_safe(values: list[float]) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return median(vals) if vals else None



def compute_probe_workers(file_count: int) -> int:
    env = os.environ.get("MEDIA_SPEC_WORKERS", "").strip()
    if env:
        try:
            w = int(env)
            if 1 <= w <= 256:
                return min(w, file_count)
        except Exception:
            pass
    cpu = os.cpu_count() or 4
    return min(file_count, max(cpu * 4, 32))

# -------------------------------
# ffprobe
# -------------------------------


def probe(ffprobe_cmd: str, file_path: Path, file_size: int) -> Optional[dict]:
    try:
        cmd = [
            ffprobe_cmd,
            "-v", "error",
            "-print_format", "json",
            "-show_streams", "-show_format",
            str(file_path),
        ]
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=FFPROBE_TIMEOUT_SEC,
            encoding="utf-8",
            errors="replace",
        )
        if p.returncode != 0 or not p.stdout:
            print(f"\nDEBUG ffprobe exit={p.returncode} stdout_len={len(p.stdout) if p.stdout else 0}: {file_path}\n  stderr: {(p.stderr or '')[:300]}")
            return None

        data = json.loads(p.stdout or "{}")
        vstreams = [s for s in (data.get("streams") or []) if s.get("codec_type") == "video"]
        if not vstreams:
            print(f"\nDEBUG no video streams found: {file_path}")
            return None

        vs = vstreams[0]
        fmt = data.get("format") or {}

        width = int(vs.get("width") or 0)
        height = int(vs.get("height") or 0)
        res_bucket = nearest_bucket(width, height) if (width and height) else "Other"
        raw_res = (width, height) if (width and height) else None

        duration = None
        if fmt.get("duration"):
            try:
                duration = float(fmt["duration"])
            except ValueError:
                duration = None

        br = None
        bit_rate_val = vs.get("bit_rate") or fmt.get("bit_rate")
        if bit_rate_val:
            try:
                br = int(bit_rate_val)
            except ValueError:
                br = None

        fps = parse_fps(vs.get("avg_frame_rate"))
        codec = (vs.get("codec_name") or "unknown").lower()

        prim = vs.get("color_primaries")
        trns = vs.get("color_transfer_characteristic") or vs.get("color_transfer")
        cspc = vs.get("color_space")

        side_list = vs.get("side_data_list") or []
        side_types = ", ".join([sd.get("side_data_type", "") for sd in side_list])
        hdr = hdr_label(trns, side_types)

        return {
            "path": str(file_path),
            "size": file_size,
            "resolution_bucket": res_bucket,
            "resolution": raw_res,
            "duration": duration,
            "duration_bucket": duration_bucket(duration) if duration is not None else "Unknown",
            "size_bucket": size_bucket(file_size),
            "codec": codec,
            "bitrate": br,
            "fps": fps,
            "hdr": hdr,
            "color_space": cspc,
            "color_transfer": trns,
            "color_primaries": prim,
        }
    except Exception as e:
        print(f"\nDEBUG probe failed: {file_path}\n  {type(e).__name__}: {e}")
        return None

# -------------------------------
# Collection
# -------------------------------


def gather_files(target: Path) -> list[Tuple[Path, int]]:
    """Walk directory tree, return (path, file_size) tuples for video files."""
    results: list[Tuple[Path, int]] = []
    video_exts = VIDEO_EXTS

    if target.is_file():
        if target.suffix.lower() in video_exts:
            try:
                results.append((target, target.stat().st_size))
            except OSError:
                pass
        return results

    if not target.is_dir():
        return results

    # os.walk is faster than Path.rglob on Windows - avoids constructing
    # Path objects for every non-video file before discarding them
    target_str = str(target)
    for dirpath, _dirnames, filenames in os.walk(target_str):
        for fname in filenames:
            dot_pos = fname.rfind(".")
            if dot_pos == -1:
                continue
            ext = fname[dot_pos:].lower()
            if ext not in video_exts:
                continue
            full = os.path.join(dirpath, fname)
            try:
                sz = os.path.getsize(full)
                results.append((Path(full), sz))
            except OSError:
                pass

    return results

# -------------------------------
# Formatting helpers (GLOBAL alignment)
# -------------------------------


def pad_left(s: str, width: int) -> str:
    s = "" if s is None else str(s)
    return s.ljust(width)



def build_rows(records: list[dict]) -> dict:
    rows = {}

    # SUMMARY
    rows["SUMMARY"] = [
        ("Total size", human_size(sum(r["size"] or 0 for r in records))),
        ("Total duration", human_duration(sum(r["duration"] or 0 for r in records))),
    ]

    # RESOLUTION
    res_counts = Counter(r["resolution_bucket"] for r in records)
    other_raw = Counter(
        f"{w}x{h}"
        for r in records
        if r["resolution_bucket"] == "Other" and r["resolution"] and (w := r["resolution"][0]) and (h := r["resolution"][1])
    )
    base_order = ["480p","720p","1080p","1440p","4K","8K"]
    res_rows = []
    for base in base_order:
        l = res_counts.get(base, 0)
        p = res_counts.get(base + " vertical", 0)
        t = l + p
        if t:
            suffix = ""
            if l and p: suffix = "(landscape, portrait)"
            elif l:     suffix = "(landscape)"
            else:       suffix = "(portrait)"
            res_rows.append((base, str(t) + (f"  {suffix}" if suffix else "")))
    if res_counts.get("Other"):
        res_rows.append(("Other", str(res_counts["Other"])))
        for res, cnt in other_raw.most_common(TOP_OTHER_EXAMPLES):
            res_rows.append(("  " + res, str(cnt)))
    rows["RESOLUTION"] = res_rows

    # CODEC
    codec_counts = Counter((r["codec"] or "UNKNOWN").upper() for r in records)
    rows["CODEC"] = [(k, str(v)) for k, v in sorted(codec_counts.items(), key=lambda x: (-x[1], x[0]))]

    # HDR / SDR
    hdr_counts = Counter(r["hdr"] for r in records)
    hdr_order = [k for k in ["SDR","HDR10","HLG","Dolby Vision","Unknown"] if hdr_counts.get(k)]
    rows["HDR / SDR"] = [(k, str(hdr_counts[k])) for k in hdr_order]

    # FRAMERATE
    def bin_fps(x: Optional[float]) -> str:
        if x is None: return "Unknown"
        if abs(x-23.976)<0.1 or abs(x-24.0)<0.1: return "24fps"
        if abs(x-25.0)<0.1: return "25fps"
        if abs(x-29.97)<0.1 or abs(x-30.0)<0.1: return "30fps"
        if abs(x-50.0)<0.1: return "50fps"
        if abs(x-59.94)<0.1 or abs(x-60.0)<0.1: return "60fps"
        return "Other"
    fps_counts = Counter(bin_fps(r["fps"]) for r in records)
    fps_order = [k for k in ["24fps","25fps","30fps","50fps","60fps","Other","Unknown"] if fps_counts.get(k)]
    rows["FRAMERATE"] = [(k, str(fps_counts[k])) for k in fps_order]

    # DURATION
    dur_counts = Counter(r["duration_bucket"] for r in records)
    rows["DURATION"] = [(name, str(dur_counts.get(name, 0))) for name,_,_ in DURATION_BUCKETS if dur_counts.get(name)] + \
                       ([("Unknown", str(dur_counts["Unknown"]))] if dur_counts.get("Unknown") else [])

    # FILE SIZE
    size_counts = Counter(r["size_bucket"] for r in records)
    rows["FILE SIZE"] = [(name, str(size_counts.get(name, 0))) for name,_,_ in SIZE_BUCKETS if size_counts.get(name)] + \
                        ([("Unknown", str(size_counts["Unknown"]))] if size_counts.get("Unknown") else [])

    # BITRATE (MEDIAN, kbps)
    bitrate_by_res = defaultdict(list)
    for r in records:
        if r["bitrate"] is not None:
            kb = kbps(r["bitrate"])
            if kb is not None:
                bitrate_by_res[r["resolution_bucket"]].append(kb)
    br_rows = []
    for base in base_order + ["Other"]:
        vals = bitrate_by_res.get(base, [])
        if vals:
            br_rows.append((base, str(int(round(median_safe(vals))))))  # kbps as int
    rows["BITRATE (MEDIAN, kbps)"] = br_rows

    return rows



def compute_value_col_start(rows: dict, min_col: int = 18, gap: int = 2) -> int:
    max_label = 0
    for section in rows.values():
        for label, _ in section:
            max_label = max(max_label, len(label))
    return max(min_col, max_label + gap)



def print_section_header(title: str):
    print(title)
    print(DASH)



def print_kv_rows(rows: list[tuple[str,str]], value_col: int):
    for label, value in rows:
        if "  (" in value:
            num_part, suffix = value.split("  (", 1)
            suffix = "  (" + suffix
        else:
            num_part, suffix = value, ""
        print(f"{pad_left(label, value_col)}{num_part}{suffix}")

# -------------------------------
# CLI / UX
# -------------------------------


def parse_args(argv: list[str], default_path: Path) -> Tuple[Path,bool]:
    path = None
    details = False
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--details":
            details = True
        elif a == "--path" and i + 1 < len(argv):
            path = Path(argv[i+1]); i += 1
        else:
            if path is None and not a.startswith("-"):
                path = Path(a)
        i += 1
    if path is None:
        path = default_path
    return path, details

# -------------------------------
# Main
# -------------------------------


def summarize_and_print(records: list[dict], target: Path):
    all_rows = build_rows(records)
    value_col = compute_value_col_start(all_rows)

    # Header (H-B)
    print("MEDIA SPEC SUMMARY")
    print(f"TARGET: {str(target.resolve())}")
    print(f"FILES:  {len(records)}")
    print("=" * len(DASH))
    print()

    # Sections with GLOBAL alignment + two blank lines between
    order = [
        "SUMMARY",
        "RESOLUTION",
        "CODEC",
        "HDR / SDR",
        "FRAMERATE",
        "DURATION",
        "FILE SIZE",
        "BITRATE (MEDIAN, kbps)",
    ]
    first = True
    for key in order:
        if key not in all_rows or not all_rows[key]:
            continue
        if not first:
            print()
            print()
        first = False
        print_section_header(key)
        print_kv_rows(all_rows[key], value_col)



def main():
    script_dir = Path(__file__).parent
    ffprobe_cmd = resolve_ffprobe(script_dir)
    target, show_details = parse_args(sys.argv, script_dir)

    try:
        file_list = gather_files(target)
    except Exception as e:
        print(f"Failed to access {target}: {e}")
        input("\nPress Enter to exit...")
        return

    if not file_list:
        print(f"No video files found in {target.resolve()}")
        input("\nPress Enter to exit...")
        return

    total = len(file_list)
    max_workers = compute_probe_workers(total)

    print(f"Scanning {total} files in {target.resolve()} ...")
    print(f"Using {max_workers} threads for parallel processing...")

    records = []
    skipped = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Map futures to file paths for immediate identification on failure
        future_to_path = {
            executor.submit(probe, ffprobe_cmd, fpath, fsize): fpath
            for fpath, fsize in file_list
        }

        for idx, future in enumerate(as_completed(future_to_path), start=1):
            path = future_to_path[future]
            try:
                result = future.result()
                if result is not None:
                    records.append(result)
                else:
                    skipped.append(str(path))
            except Exception:
                skipped.append(str(path))

            if idx % 50 == 0 or idx == total:
                sys.stdout.write(f"\rProgress: {idx}/{total}")
                sys.stdout.flush()

    print("\n")
    summarize_and_print(records, target)

    if show_details and records:
        print()
        print()
        print("PER-FILE DETAIL")
        print(DASH)
        headers = ["RES","FPS","HDR","CODEC","BR(kbps)","SIZE","DUR","PATH"]
        widths  = [10, 6,   12,   8,      10,        10,    8,    0]
        def cell(s,w,right=False): s="" if s is None else str(s); return s.rjust(w) if right else s.ljust(w)
        line = (
            cell(headers[0],widths[0])+" "+
            cell(headers[1],widths[1],right=True)+" "+
            cell(headers[2],widths[2])+" "+
            cell(headers[3],widths[3])+" "+
            cell(headers[4],widths[4],right=True)+" "+
            cell(headers[5],widths[5])+" "+
            cell(headers[6],widths[6])+" "+
            headers[7]
        )
        print(line)
        print("-"*len(DASH))
        def human_duration_local(sec):
            if sec is None: return "N/A"
            s=int(sec); h=s//3600; m=(s%3600)//60; s2=s%60
            return f"{h}h {m}m {s2}s" if h else (f"{m}m {s2}s" if m else f"{s2}s")
        def kbps_local(bits): return (bits/1000.0) if bits is not None else None

        for r in records:
            w,h = r["resolution"] or (0,0)
            res = f"{w}x{h}" if (w and h) else "-"
            fps = f"{r['fps']:.2f}" if r["fps"] is not None else "-"
            brk = f"{int(round(kbps_local(r['bitrate']) or 0))}" if r["bitrate"] is not None else "-"
            row = (
                cell(res, widths[0])+" "+
                cell(fps, widths[1], right=True)+" "+
                cell(r["hdr"], widths[2])+" "+
                cell((r["codec"] or "-").upper(), widths[3])+" "+
                cell(brk, widths[4], right=True)+" "+
                cell(human_size(r["size"]), widths[5])+" "+
                cell(human_duration_local(r["duration"]), widths[6])+" "+
                r["path"]
            )
            print(row)

    if skipped:
        try:
            (Path(__file__).parent / "skipped_files.txt").write_text("\n".join(skipped), encoding="utf-8", errors="replace")
            print()
            print(f"Skipped files: {len(skipped)}  (see skipped_files.txt)")
        except Exception:
            print()
            print(f"Skipped files: {len(skipped)}  (could not write log)")

    input("\nPress Enter to exit...")

if __name__ == "__main__":
    main()