# dir_tree.py

Recursive directory tree generator. Outputs a markdown file with box-drawing characters, inline folder stats, and a boxed summary header.

## Usage

Double-click to scan the folder it lives in, or run from the command line:

```
python dir_tree.py
python dir_tree.py --path "X:/Projects"
python dir_tree.py --path "X:/Projects" --depth 4
python dir_tree.py --path "X:/Projects" --hidden
```

Output is saved as `[foldername]_dir_tree.md` in the target folder.

## Options

`--path` - target directory (defaults to the script's own folder)

`--depth` - max recursion depth (default unlimited)

`--hidden` - include dotfiles and hidden folders

## Example output

```
╭──────────────────────────────────────────────────╮
│  Misc-Scripts                                    │
│  D:/scripts/Misc Scripts/Misc-Scripts            │
├──────────────────────────────────────────────────┤
│  Scanned: 2026-03-20 23:04  |  Took: 0.04s      │
╰──────────────────────────────────────────────────╯

📁 Misc-Scripts/  (Total: 18 folders, 63 files, 882 KB)
│
├── 📁 batch/  (2 folders, 2 files, 3 KB)
│   │
│   ├── 📁 mp3 converter/  (2 files, 4 KB)
│   │   ├── any2mp3.bat
│   │   ╰── README.md
│   │
│   ├── 📁 rotate_display/  (3 files, 8 KB)
│   │   ├── rotate-display.bat
│   │   ╰── rotate-display.cs
│   │
│   ├── clean_ghosts.bat
│   ╰── README.md
│
├── 📁 python/  (6 folders)
│   │
│   ├── 📁 media_stats/  (4 files, 48 KB)
│   │   ├── folder_stats.py
│   │   ├── image_stats.py
│   │   ╰── video_stats.py
│   │
│   ╰── ...
│
├── CLAUDE.md
╰── README.md
```

The root folder shows recursive totals (prefixed with "Total:"). All other folders show direct child counts only.

## Configuration

Constants at the top of the script control behaviour:

`TRUNCATE_THRESHOLD` (5000) - directories with more entries than this trigger an interactive prompt to list or summarise.

`BREATHE_MAX_DEPTH` (2) - pipe separators between sibling folders are inserted up to this tree depth.

`BREATHE_MIN_DIRS` (3) - pipe separators only appear when a directory has at least this many child folders.

`DEFAULT_EXCLUDED` - set of directory/file names to skip (node_modules, __pycache__, .git, .vscode, etc.).

## What it skips

Dotfiles (unless `--hidden`), symlinks, its own source file, any previous `_dir_tree.md` output, and the directories listed in `DEFAULT_EXCLUDED`.

## Requirements

Python 3.10+ (no external dependencies).