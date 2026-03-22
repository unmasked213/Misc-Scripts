# bump_dir_level.py

Moves the contents of a subfolder up into its parent directory, then removes the now-empty subfolder.

## Usage

Double-click to be prompted for a folder path, or run from the command line:

```
python bump_dir_level.py "D:/scripts/Misc Scripts/Misc-Scripts"
python bump_dir_level.py --path "D:/scripts/Misc Scripts/Misc-Scripts"
python bump_dir_level.py --path "D:/scripts/Misc Scripts/Misc-Scripts" --dry-run
```

## Options

`--path` - the subfolder to unwrap

`--dry-run` - preview what would happen without moving anything

## Example

Before:

```
Misc Scripts/
╰── Misc-Scripts/
    ├── batch/
    ├── python/
    ├── CLAUDE.md
    ╰── README.md
```

After running `python bump_dir_level.py "Misc Scripts/Misc-Scripts"`:

```
Misc Scripts/
├── batch/
├── python/
├── CLAUDE.md
╰── README.md
```

## Safety

The script checks for name conflicts in the parent directory before moving anything. If any file or folder in the subfolder already exists in the parent, it aborts with a list of conflicts. A confirmation prompt is shown before any changes are made (skipped in `--dry-run` mode).

## Requirements

Python 3.10+ (no external dependencies).
