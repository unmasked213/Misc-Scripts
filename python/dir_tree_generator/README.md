# Copy directory tree - bounded-output update

Run `Update.cmd` to replace the installed script at:

```text
%LocalAppData%\CopyDirectoryTree\dir_tree.py
```

The updater validates the replacement with Python, backs up the current script with a timestamp, installs the new file, and verifies its SHA-256. It does not change the File Explorer registry entries or the hidden VBS launcher.

## Default output policy

The context-menu command remains silent and copies the generated Markdown tree directly to the clipboard.

The replacement script:

- does not read `.gitignore`, `.cursorignore`, `.treeignore`, or any other ignore file;
- includes filenames such as `secrets.yaml`, `.env`, local configuration files, and binaries without reading file content;
- shows known low-value directories but does not descend into them;
- does not follow directory symlinks, junctions, or duplicate directory roots;
- lists at most 60 child folders per directory;
- lists at most 80 files per directory;
- lists at most 20 representative filenames from each repetitive bulk family, including images, video, audio, fonts, archives, databases, datasets, binaries, models and logs;
- condenses repeated sibling branches that contain the same structure or only repetitive bulk content;
- trims lower-value branches if required to keep the complete Markdown document within 1,000 lines;
- states every reduction in the tree rather than silently presenting a partial result as complete.

Representative samples contain names from both the beginning and end of the sorted set.

## Hard-coded directories shown but not expanded

```text
.git
.hg
.svn
.cache
.mypy_cache
.pytest_cache
.ruff_cache
.tox
.venv
__pycache__
bower_components
build
dist
node_modules
target
venv
.eggs
.gradle
.next
.nuxt
.parcel-cache
.pnpm-store
.svelte-kit
.turbo
coverage
htmlcov
```

Tool worktree paths such as `.claude/worktrees/` are also shown but not expanded.

## Manual overrides

The normal defaults apply to both context-menu and direct script use.

```text
--unbounded        Disable per-directory and whole-document output limits.
--expand           Expand the hard-coded low-value directories.
--all              Apply both --unbounded and --expand.
--max-lines N      Override the 1,000-line document limit (minimum 250).
--max-dirs N       Override the 60-child-folder limit.
--max-files N      Override the 80-file limit.
--max-bulk N       Override the 20-files-per-bulk-family limit.
--depth N          Limit recursive depth.
--no-hidden        Do not list hidden entries.
```

`--no-ignore` remains accepted as a compatibility no-op. Ignore files are never read.

Per-directory overrides are constrained when necessary so the selected whole-document line limit remains enforceable.
