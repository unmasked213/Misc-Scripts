# Sentinel — Project Handoff

Last updated: 3 March 2026

This document is the single source of truth for resuming work on Sentinel. Read this first, then check the code. Don't rely on memory or assumptions from prior conversations.


## What Sentinel Is

An autonomous file management system for Windows. It watches download folders, classifies files by type, detects duplicates (exact and perceptual), and routes everything to destination folders based on configurable rules. The design principle is hands-off by default — confident decisions execute automatically, ambiguous cases go to quarantine for human review.

Target environment: Windows 11, Python 3.11+, running as a persistent background process.


## Current State

**Status: Core architecture complete. Not yet tested on real files on Windows.**

All modules exist, all imports resolve, integration tests pass for config loading, classification, rule matching, hashing, and image fingerprinting. No module is a stub — they all contain real logic. But the system has not been run end-to-end on actual files, and there are known bugs (listed below) that need fixing before a real run.

Total codebase: ~3,500 lines of Python across 18 modules, plus a 220-line TOML config.


## File Map

```
sentinel/
├── ARCHITECTURE.md          # Design doc (written first session, may be slightly stale)
├── config.toml              # All behaviour configuration
├── requirements.txt         # Python dependencies
└── sentinel/
    ├── __init__.py
    ├── main.py              # Entry point, Sentinel controller class, CLI
    ├── config.py            # TOML loader with defaults and validation
    ├── database.py          # SQLite with WAL mode, 32-column files table
    ├── models.py            # FileRecord, MediaInfo, DupeMatch, enums
    ├── classifier.py        # Extension lookup + ffprobe fallback
    ├── queue.py             # Thread-safe FIFO with write-completion detection
    ├── watcher.py           # watchdog-based filesystem monitor + catch-up scan
    ├── pipeline.py          # Orchestrates classify → enrich → hash → dedup → rules → action
    ├── logging_config.py    # Rotating file + console handler setup
    ├── trash_cleaner.py     # Date-based auto-purge utility
    ├── enrichment/
    │   ├── orientation.py   # Video orientation via dimensions + cropdetect
    │   ├── source.py        # Windows ADS Zone.Identifier parsing
    │   └── naming.py        # yt-dlp title resolution from source URLs
    ├── dedup/
    │   ├── exact.py         # Partial hash (blake2b, first+last 64KB) → full hash
    │   ├── image.py         # pHash ×8 transforms + ORB + RANSAC geometric verification
    │   ├── perceptual.py    # Video frame dHash + audio Chromaprint
    │   └── resolver.py      # Quality comparison and auto-trash/quarantine decision
    └── rules/
        ├── engine.py        # Ordered rule evaluation, first-match-wins
        └── actions.py       # move_to, rename, copy_to, trash, quarantine, tag
```


## Config Format

**TOML** (not YAML). The config loader is in `sentinel/config.py`. It uses stdlib `tomllib` on Python 3.11+ and falls back to `tomli` (pip package) on 3.10. PyYAML is not a dependency.

The `Config` class exposes typed properties (`config.rules`, `config.dedup`, `config.destinations`, etc.) and a few helpers like `get_destination(name)` and `get_all_type_extensions()`.

Key sections in `config.toml`:
- `[[watch_folders]]` — array of tables, each with `path` and optional `recursive`
- `[destinations]` — named folders for routing (referenced by rules)
- `[classification]` — extension lists per type (audio, video, image, document, archive)
- `[dedup]` — toggle and thresholds for exact, video, audio, image, and subset detection
- `[dedup.image]` — pHash thresholds, ORB parameters, geometry verification settings
- `[[rules]]` — ordered rule list with conditions and actions


## Processing Pipeline

For each detected file:

1. **Wait for write completion** — poll file size until stable (queue.py)
2. **Classify** — extension lookup, ffprobe fallback for unknowns (classifier.py)
3. **Enrich** — media metadata, orientation detection, ADS source parsing, title resolution (enrichment/)
4. **Hash** — blake2b partial+full hash, video frame hashes, image pHash+ORB, audio fingerprint (dedup/)
5. **Dedup** — exact hash match → perceptual match → image match → resolve (dedup/)
6. **Rules** — evaluate ordered rule list, first match wins unless `continue: true` (rules/engine.py)
7. **Action** — move, rename, copy, trash, or quarantine (rules/actions.py)
8. **Record** — store everything in SQLite (database.py)


## Image Dedup — How It Works

This is the most complex subsystem. It was adapted from a standalone `dupefinder.py` tool that already worked well. The pipeline:

1. **Load and normalise** — EXIF rotation, alpha compositing, convert to RGB
2. **pHash ×8** — compute 64-bit perceptual hash for all 8 canonical orientations (4 rotations × 2 flips). This makes detection rotation/flip invariant.
3. **ORB keypoints** — extract up to 800 keypoints with binary descriptors. Image is resized to max 1024px for speed.
4. **Matching** — BF Hamming matcher with Lowe's ratio test (0.75). Filters weak matches.
5. **RANSAC geometric verification** — tries similarity → affine → homography models. Checks inlier count, coverage, residual, and scale limits.
6. **Composite scoring** — deletion-safe confidence score that combines pHash, geometry, texture level, and dimensional agreement. Conservative by design — the score is a lower bound on "safe to delete as redundant."

Scoring tiers:
- pHash ≥0.99 + strong geometry → 1.0 (definite duplicate)
- pHash ≥0.99 + high texture + dimensions match → 1.0 (no geometry needed)
- pHash ≥0.99 + low texture + no geometry → 0.98 (collision plausible, quarantine)
- pHash 0.95-0.99 + geometry confirmed → 0.98
- Lower pHash + geometry → capped boost (+0.02 to +0.05)

The threshold for auto-trash vs quarantine is configurable (`dedup.resolution.confidence_threshold`, default 0.85).


## Known Bugs

These need fixing before the first real run:

1. **main.py still references `config.yaml`** — three occurrences. The default config path in `Sentinel.__init__()` and the argparse default need changing to `config.toml`. Quick find-and-replace.

2. **`sqlite3.Row` doesn't have `.get()`** — `dedup/image.py` calls `cand.get("image_phash")` and similar on sqlite3.Row objects. Row supports `cand["key"]` and `cand.keys()` but not `.get()` with defaults. Either wrap in a helper or use try/except with KeyError. Affects `check_image_dupe()` only.

3. **Image fingerprints not stored to DB** — `pipeline.py` computes `ImageFingerprint` and passes it to `check_image_dupe()`, but never actually writes the fingerprint data (phash blob, descriptors, keypoints) to the database. The DB columns exist but nothing inserts into them. The `database.py` insert method needs updating to accept and store image fingerprint fields, and `pipeline.py` needs to pass them through after processing.

4. **`find_by_type` returns all files, no indexing** — for large collections, the image dedup's `check_image_dupe()` calls `db.find_by_type("image")` which does a full table scan. Works fine for hundreds of files, will be slow for tens of thousands. Needs an index on `(file_type, image_phash)` and ideally LSH blocking to avoid comparing against every stored image.


## What's Not Built Yet

These were identified as future work during design:

- **System tray icon** — pystray is in requirements.txt but no tray code exists. Planned: green=idle, orange=quarantine items, red=errors. Right-click menu for pause/resume/status.
- **Web UI for quarantine review** — not started. Planned as a minimal Flask interface with side-by-side dupe comparison and keep/delete/keep-both actions.
- **Windows service wrapper** — currently runs as a foreground process. Needs either a Windows service (pywin32) or a scheduled task to survive reboots.
- **Audio tag extraction** — mutagen library for ID3/Vorbis tags (artist, album, track). Template variables `{artist}`, `{album}`, `{track}` exist in the rename action but nothing populates them.
- **EXIF-based image orientation** — the image dedup normalises EXIF rotation for fingerprinting, but the pipeline's orientation enrichment (`enrichment/orientation.py`) is video-only. Images don't get an orientation classification.
- **Trash auto-purge scheduling** — `trash_cleaner.py` has the purge logic but it's not wired into the main loop on a timer.
- **Hot-reload** — `Config.reload()` exists but nothing calls it. Could watch config.toml for changes.


## Dependencies

Required:
- `watchdog` — filesystem monitoring
- `Pillow` — image loading for dedup

Optional (graceful degradation without):
- `opencv-python-headless` + `numpy` — image dedup (pHash, ORB, RANSAC). Without these, image dedup silently skips.
- `ffprobe` / `ffmpeg` — media metadata, orientation detection, frame extraction. Without these, media enrichment is skipped and unknown extensions can't be probed.
- `fpcalc` — audio fingerprinting (Chromaprint). Without this, audio dedup skips.
- `yt-dlp` — title resolution from download URLs. Without this, `{source_title}` template variable is empty.

Python 3.10 compatibility: needs `pip install tomli` (3.11+ has `tomllib` in stdlib).


## How the Existing Tools Relate

Several uploaded tools informed the design:

- **dupefinder.py** — the pHash + ORB + RANSAC pipeline was lifted from this. The composite scoring logic is a direct port. The standalone dupefinder is a batch tool with HTML report output; Sentinel's `dedup/image.py` is the same detection engine adapted for inline processing.
- **Chrome extension (background.js, intercept.js, bridge.js, popup.js, shortcuts.js, offscreen.html)** — this is the primary download source. It handles image downloads with custom prefixes and HLS video stream assembly. Sentinel's ADS source detection will pick up the browser origin. The `.ts` files from HLS assembly should be classified as video without needing ffprobe.
- **video_stats.py / image_stats.py / folder_stats.py** — these show how file analysis and bucketing is already done. The resolution buckets and size buckets in image_stats.py parallel what Sentinel tracks in its database. folder_stats.py's multiprocessing pattern is relevant for bulk catch-up scans.
- **playlist_generator.py** — downstream consumer. Once Sentinel sorts videos into destination folders, the playlist generator builds .m3u playlists from those folders. Sentinel's folder structure needs to stay compatible.
- **dir_tree.py** — diagnostic tool. Useful for verifying Sentinel's routing is correct after a run.
- **server.py + index.html** — Flask web server for the dupefinder's interactive review UI. Could be adapted for Sentinel's quarantine review.


## Architecture Decisions Log

1. **TOML over YAML** — Python's native config format since 3.11. No third-party dep needed. Cleaner for flat key-value and simple nesting. YAML anchors and complex nesting aren't needed here.

2. **blake2b over SHA-256** — faster, no OpenSSL dependency, and it's what dupefinder already uses. Same partial-hash strategy (first+last 64KB + file size).

3. **Lazy-loaded OpenCV** — `dedup/image.py` imports cv2/numpy/Pillow only when first called. If not installed, the module logs once and returns None for all operations. The rest of Sentinel continues working.

4. **sqlite3.Row for DB results** — enables dictionary-style access on query results. Trade-off: no `.get()` method (see known bug #2).

5. **Composite similarity is a conservative lower bound** — the scoring deliberately caps confidence when confirming signals are absent. A 0.98 score means "almost certainly a duplicate but we're not 100% sure." Only perfect pHash + confirming geometry OR perfect pHash + high texture + dimensional agreement reaches 1.0.

6. **Quarantine vs trash** — quarantine is for files the system couldn't confidently handle (low-confidence dupes, processing errors). Trash is for files confidently marked for removal. Quarantine is never auto-purged. Trash is date-organised and auto-purged after configurable retention.


## Resuming Work — Suggested Order

1. Fix the four known bugs listed above (30 minutes, all surgical edits).
2. Edit `config.toml` with real paths for your system.
3. Test end-to-end on a small folder (~20 files, mixed types) on Windows.
4. Verify: classification, orientation detection, rule matching, file routing.
5. Add a few real duplicate images and verify the dedup pipeline catches them.
6. Once routing works, tackle the "not built yet" list in priority order.

The highest-value next features are probably: image fingerprint DB storage (bug #3 fix), trash auto-purge timer, and then either the tray icon or the quarantine web UI depending on whether you want background operation or review capability first.
