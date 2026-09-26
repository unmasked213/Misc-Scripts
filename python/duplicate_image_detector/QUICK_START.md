# Quick Start: Duplicate Image Finder

## One-time setup

1. Install Python 3.10 or later from [python.org](https://www.python.org/downloads/). On Windows, select **Add Python to PATH**.
2. Double-click `install_dependencies.bat`.

You can also install from a terminal:

```powershell
python -m pip install -r requirements.txt
```

## Launch

Double-click `Launch Duplicate Finder Web.vbs`, or run:

```powershell
python server.py
```

The app opens at `http://localhost:5000`. It binds only to your computer.

## Safe workflow

1. Choose a photo folder.
2. Choose a similarity threshold. Enable **Quick mode** if you want only byte-exact and all-frame pixel-identical results.
3. Start the scan. Pause, resume, and cancel control the scan itself.
4. Review each group. The blue card is only the **comparison reference**, not a quality recommendation.
5. Mark files for quarantine. **Mark byte-exact copies** is the only bulk-mark action.
6. Select **Review Quarantine**, verify the fixed list of paths, then move them.

The app never permanently deletes files. Quarantined files are placed outside the scanned folder in:

```text
<folder-name>.dupefinder_quarantine\<operation-id>\<original-relative-path>
```

Each operation has a durable JSON manifest. **Undo** restores an operation only when every source still matches and every original path is empty; it never overwrites another file.

If you refresh the same browser tab while the server is still running, the app restores the active results, marks, recovery notice, and available Undo. After the server exits, use the quarantine manifest as the durable recovery record.

## Match labels

| Label | Meaning | Bulk marking |
|---|---|---|
| **Byte-exact** | Full-file SHA-256 is identical | Available |
| **All-frame pixel match** | Every decoded frame/page, timing, and alpha-capability semantics are identical, but file bytes differ | Manual review only |
| **Geometry-verified variant** | Feature geometry links the images; crops, resizes, rotations, or edits may differ | Manual review only |
| **Indirect link** | Connected through another verified member, with no direct score to the current reference | Manual review only |

## Important safeguards

- Actions use scan-result IDs, not browser-supplied paths.
- Every file is rechecked against its scan identity and SHA-256 before it moves.
- A changed, replaced, missing, linked, or out-of-scope file is rejected.
- At least one active member must remain in every result group.
- The quarantine confirmation is an immutable server-side snapshot.
- PNG previews preserve transparency; animated and multi-page files show their frame/page count.

## Troubleshooting

| Problem | What to do |
|---|---|
| Python is not recognised | Reinstall Python and enable **Add Python to PATH** |
| A module is missing | Run `python -m pip install -r requirements.txt` |
| The browser did not open | Open `http://localhost:5000` manually |
| A move is rejected as changed | Rescan; the file no longer has the identity that was reviewed |
| Undo is blocked by an existing path | Move or rename the occupying file yourself, verify it, then retry Undo |
| Quarantine reports no safe move primitive | The filesystem cannot guarantee no-overwrite moves; the app deliberately refuses to fall back to an overwrite-capable move |
| A format will not decode | Install the relevant Pillow codec/plugin or convert a copy to PNG/JPEG |

See `README.md` for the full safety model and standalone command-line usage.
