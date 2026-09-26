# Duplicate Image Finder

Duplicate Image Finder scans a local folder for byte-identical images, decoded pixel-identical images, and geometrically verified visual variants. It provides a local web interface for review and a reversible quarantine workflow.

The safety boundary is deliberate: only byte-identical files can be bulk-marked. Pixel matches and perceptual variants always require human review, and the program never permanently deletes a file.

## Match types

The interface keeps four materially different findings separate:

| Match type | Evidence | Meaning |
|---|---|---|
| **Byte-exact** | Full-file SHA-256 equality | The complete files are identical, including metadata and encoding |
| **All-frame pixel match** | Canonical RGBA equality across every frame/page, including animation timing and the same alpha-capability semantics | Decoded visual content is identical, but metadata or encoding may differ |
| **Geometry-verified variant** | Symmetric feature matches plus a plausible RANSAC transform | Images are related, but information-bearing differences may exist |
| **Indirect link** | The member is connected through another verified result | No direct similarity score exists against the current comparison reference |

Perceptual hashing is candidate generation only. It is never accepted as proof of duplication, and it can never produce a 100% result by itself.

## Safety model

### Reversible quarantine, not deletion

The web app has no permanent-delete endpoint or control. A confirmed set is moved to a sibling quarantine directory outside the scanned tree:

```text
<scanned-folder>.dupefinder_quarantine/
  <operation-id>/
    manifest.json
    <original-relative-path>
```

Relative directories are preserved, and every operation is recorded in an atomically updated JSON manifest. The quarantine directory is not included in later scans.

### Identity-bound actions

The browser never sends a path as an action target. It sends an opaque result ID belonging to a completed scan. Immediately before a move, the server checks all of the following again:

- the result still belongs to the active scan and group;
- the canonical path is still inside the selected root;
- the source is a regular file, not a symbolic link;
- device, file ID/inode, byte size, modification time, and full SHA-256 still match the reviewed file;
- the quarantine destination does not exist;
- at least one member will remain in every affected group.

Any mismatch blocks the operation. A file changed after review must be rescanned.

### Immutable confirmation

Opening **Review Quarantine** creates a short-lived server-side snapshot. The dialog displays the exact relative paths in that snapshot. Confirming sends only the snapshot token, so keyboard or background UI state cannot silently add another file.

### Fail-closed Undo

Undo first verifies the entire latest operation. It restores nothing unless every quarantined file has the expected content and every original destination is absent. It never overwrites a file that has appeared at an old path, and a failed operation remains available for inspection or retry.

### Local API boundary

The server binds to `127.0.0.1`, does not enable cross-origin access, and requires a random process token on every API request. Thumbnail, open-file, open-folder, marking, quarantine, and Undo routes resolve only opaque results from a completed session.

## Installation

Requirements:

- Windows, macOS, or Linux
- Python 3.10 or later
- OpenCV, NumPy, Pillow, and Flask from `requirements.txt`
- Tkinter for the native folder picker (normally included with Windows Python)

On Windows, double-click `install_dependencies.bat`. Or run:

```powershell
python -m pip install -r requirements.txt
```

No cross-origin Flask extension is required.

## Running the web interface

On Windows, double-click:

```text
Launch Duplicate Finder Web.vbs
```

Or run from a terminal:

```powershell
python server.py
```

The browser opens at `http://localhost:5000`. An open tab keeps its active scan/review session alive. Reloading that tab restores results, marks, recovery state, and available Undo while the same server process is running. When browser contact is lost, the server waits for active scanning or file work to reach a safe checkpoint before shutting down gracefully.

## Review workflow

1. Select the root folder.
2. Set the minimum similarity for geometry-verified variants.
3. Choose a scan mode:
   - **Quick mode** checks byte identity and decoded all-frame/page identity only.
   - **Full mode** additionally finds geometry-verified variants.
4. Start the scan. Pause and Resume gate the worker; Cancel stops it at a safe checkpoint.
5. Filter results by byte-exact, pixel-identical, or review-required variants.
6. Inspect names, relative/full paths, dimensions, byte sizes, dates, alpha, and frame/page counts. The blue **comparison reference** is a stable navigation anchor, not a claim that it is the best-quality original.
7. Mark files manually, or use **Mark byte-exact copies**. The server will not allow every active member of a group to be marked.
8. Review the immutable quarantine list and confirm the move.
9. Use Undo if necessary.

Lossless PNG previews preserve transparency. For animated or multi-page media, the match signature covers all frames/pages even though a review preview may show one frame; the displayed frame/page count makes this explicit.

## Detection pipeline

### Exact and decoded-content identity

Every candidate receives:

- a full-file SHA-256;
- a canonical content digest over EXIF-transposed RGBA frames/pages, dimensions, order, animation timing/disposal where available, and loop count;
- format, dimensions, alpha, and frame/page metadata.

This prevents two animations or TIFF documents with the same first frame/page but different later content from being classified as identical.

### Perceptual variants

Full mode computes canonical perceptual hashes only to propose candidates. Candidate generation is global, so resized, rotated, cropped, and aspect-boundary pairs are not excluded by hard megapixel buckets. The selected threshold is the actual minimum; no hidden lower variant threshold is applied.

Candidates must then pass symmetric, one-to-one descriptor matching and geometric verification. The verifier checks inlier count, spatial image coverage, residual error, transform scale, and degeneracy. Valid reflections are supported. Low-texture or pHash-only pairs are rejected unless exact content identity was already established.

Related results form graph components. Every node from a positive edge remains visible. When a member has no direct edge to the chosen comparison reference, it is labelled **Indirect link** rather than being silently removed or assigned a misleading score.

## Standalone command-line report

The core engine can also run without the web UI:

```powershell
python dupefinder.py "C:\Photos" --output "C:\Reports"
```

It writes JSON, CSV, and HTML review reports using the same exact/pixel/geometry distinctions as the web scan. Thumbnail filenames use opaque hashes of their full source identity, so equal basenames in different directories cannot overwrite one another.

Each successful run is staged and published as a new `report-<UTC time>-<ID>` directory inside the selected output folder. Earlier reports are never mixed with or overwritten by a later run. The HTML review is one page, so aggregate selections do not depend on browser-specific storage sharing between local files. Selections are scoped to that one generated report and filtered through opaque member IDs, so another report cannot leak stale paths into an export. If a source changes while thumbnails are being created, the incomplete staging directory is removed and no report is published.

Run `python dupefinder.py --help` for options.

## Supported media

Common Pillow formats are included by default: JPEG, PNG, WebP, TIFF, BMP, and GIF. HEIC and AVIF require a Pillow build or plugin that provides those codecs. Animated WebP/GIF and multi-page TIFF content is evaluated across all decoded frames/pages.

## Project files

| File | Purpose |
|---|---|
| `server.py` | Authenticated local web API, scan orchestration, quarantine, and Undo |
| `dupefinder.py` | Hashing, all-frame content identity, feature geometry, clustering, and reports |
| `index.html` | Single-page review interface |
| `requirements.txt` | Python dependencies |
| `install_dependencies.bat` | Windows dependency installer |
| `Launch Duplicate Finder Web.vbs` | Windowless Windows launcher |
| `QUICK_START.md` | Condensed setup and review workflow |

## Operational notes

- The web scan cache is temporary and cleaned after each scan. The standalone CLI can keep its configured fingerprint cache, keyed by full-file SHA-256 and analysis configuration. A fingerprint is cached only after the source identity and full SHA-256 are revalidated; changed content is not reused.
- The scanner ignores legacy `_dupes` directories and quarantine directories.
- If another program edits, synchronises, replaces, or renames a reviewed file, the move is expected to fail closed.
- Quarantine uses no-overwrite filesystem primitives. On a filesystem that cannot provide them, the move is rejected instead of falling back to an overwrite-capable operation.
- Similar-looking images are not necessarily redundant. Review every pixel match or geometry-verified variant for metadata, edits, crops, annotations, redactions, and provenance you may want to keep.
- Quarantine manifests are recovery records. Keep them with quarantined files until you have completed your own backup/review process.

## Troubleshooting

**Python is not recognised**  
Reinstall Python and enable **Add Python to PATH**.

**A Python module is missing**  
Run `python -m pip install -r requirements.txt` from the project folder.

**The browser does not open**  
Open `http://localhost:5000` manually.

**The port is already in use**  
Close another running instance, then launch again.

**A file is rejected as changed**  
Do not bypass the check. Start a new scan and review the current file.

**Undo reports an occupied original path**  
Inspect the file at that path. Move or rename it yourself only after deciding what it is, then retry Undo.

**An image format fails to load**  
Install an appropriate Pillow codec/plugin, or convert a copy to a supported format.
