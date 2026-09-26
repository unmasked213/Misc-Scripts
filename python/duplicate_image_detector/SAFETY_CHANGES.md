# Safety rebuild summary

This version changes the application's action model as well as fixing detector and interface defects.

## Important behaviour changes

- The web app has no permanent-delete route. Confirmed files move to a reversible sibling quarantine with a durable manifest.
- Browser actions use opaque scan-result IDs. A raw filesystem path is display-only and is never accepted as an action target.
- **Duplicate** means full-file SHA-256 identity or conservative all-frame/page decoded identity. A perceptual-hash collision is never enough.
- Geometry-confirmed crops, resizes, rotations, and edits are labelled **variants** and always require manual review.
- Only byte-exact copies have a bulk-mark action. Existing manual marks are explicitly disclosed and the final quarantine list is immutable.
- Every source and required survivor is revalidated with full SHA-256 immediately before a move. Undo never overwrites an occupied original path.
- An unresolved partial filesystem operation locks the interface and preserves its manifest location for manual recovery.
- An open browser keeps its active session alive, and a same-tab refresh restores scan results, marks, recovery state, and process-local Undo while the server is still running.
- Standalone CLI reports are staged, published into isolated per-run directories, and take no file action.

## Compatibility notes

- Python 3.10 or later is required.
- The folder must be chosen with the native picker. The old raw-path registration API has been removed.
- Existing `_dupes`, quarantine, cache, generated-report, symbolic-link, junction, and reparse-point trees are excluded from scans.
- Automatic Undo is process-local, but survives a same-tab page refresh while that server process remains open. The JSON quarantine manifest remains the recovery record after restart.
- The full perceptual scan compares a global candidate pool and can be expensive for very large collections.
- Animated or multi-page matching covers every frame/page; the on-screen preview shows the first frame/page and labels its dimensions accordingly.

## Verification

Run `run_tests.bat`, or from a terminal:

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
```

The suite covers classification boundaries, alpha and animation identity, real ORB/RANSAC geometry, scan races, cache poisoning, path containment, authentication, immutable quarantine snapshots, rollback/Undo failures, recovery locking, and frontend action contracts.
