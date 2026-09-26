# Playlist Builder

Playlist Builder adds a per-user Windows File Explorer command named **Generate video playlists** and a hidden automation process for maintaining playlists over time.

It can:

- generate `Horz.m3u`, `Vert.m3u` and `Dupes.m3u` for any folder selected in Explorer;
- sort by Name, Size, Date modified, Duration, Quality or Random;
- continue automatically when an interactive question is left unanswered;
- regenerate configured roots when video files are added, changed, moved or removed;
- merge playlists from different folders, drives or mounted Cryptomator vaults into named outputs;
- preserve the last good output when a watched root or merge source is unavailable.

MPV integration is not included in this build.

## Files

```text
playlist_generator.py           Interactive and headless playlist generator
playlist_automation.py          Watcher, reconciliation service and playlist merger
playlist_builder.json           Initial persistent configuration
Install.cmd                     Installer entry point
Install-PlaylistBuilder.ps1     Per-user installer
Uninstall.cmd                   Uninstaller entry point
Uninstall-PlaylistBuilder.ps1   Per-user uninstaller
Open-Config.cmd                 Opens the persistent JSON configuration
Merge-Playlists.cmd             Rebuilds configured merges immediately
README.md                       This file
```

## Install or update

Keep all files together in:

```text
D:\scripts\Misc Scripts\Misc-Scripts\python\playlist_builder\
```

Run:

```text
Install.cmd
```

The installer:

- checks for Python 3.10 or later;
- validates both Python scripts;
- installs the program files under `%LOCALAPPDATA%\PlaylistBuilder`;
- creates `%APPDATA%\PlaylistBuilder\playlist_builder.json` only when it does not already exist;
- registers **Generate video playlists** for selected folders and folder backgrounds;
- registers the hidden automation process under the current user's Windows startup entries;
- starts the automation immediately;
- requires no administrator rights.

Running `Install.cmd` again updates the installed program files but preserves the existing configuration.

`ffprobe` enables duration, quality, orientation splitting and duplicate detection. `ffmpeg` enables accurate orientation analysis and content fingerprinting. Both must be available on `PATH` for the corresponding features.

## Interactive generation

Right-click a selected folder, or the background of an open folder, and choose **Generate video playlists**.

The clicked folder is scanned recursively. The generator writes or replaces:

```text
Horz.m3u
Vert.m3u
Dupes.m3u
.playlist_generator_cache.json
```

The interactive sort choices are:

```text
1  Name
2  Size
3  Date modified
4  Duration
5  Quality
6  Random
```

If no sort choice is entered within 8 seconds, **Date modified** is selected. If no orientation choice is entered within 8 seconds, **Accurate** is selected.

Name sorting preserves folder grouping and sorts filenames A-Z within each containing folder. Random shuffles the normal orientation playlists. `Dupes.m3u` keeps its deliberate duplicate-group and best-copy-first ordering.

If a target no longer contains any videos, the managed playlists are removed and stale cache records are pruned.

Running `playlist_generator.py` directly without `--path` still processes the folder containing the script.

## Persistent configuration

Run:

```text
Open-Config.cmd
```

The live configuration is:

```text
%APPDATA%\PlaylistBuilder\playlist_builder.json
```

It is separate from the installed program directory, so updates and uninstalling do not delete it.

JSON paths must escape each backslash:

```json
"E:\\Videos"
```

Absolute paths are recommended. Any relative path is resolved from the directory containing `playlist_builder.json`.

The automation reloads a valid saved configuration within a few seconds. If an edit produces invalid JSON, the running process keeps the last valid configuration and records the error in its log.

### Watched roots

Add one object per root whose generated playlists should be kept current:

```json
"watched_roots": [
  {
    "enabled": true,
    "path": "E:\\Videos",
    "sort": "date_modified",
    "orientation": "accurate"
  },
  {
    "enabled": true,
    "path": "F:\\Archive\\Clips",
    "sort": "random",
    "orientation": "fast"
  }
]
```

Valid sort values are:

```text
name
size
date_modified
duration
quality
random
```

Valid orientation values are:

```text
fast
accurate
```

A root can omit `sort` or `orientation` to inherit the values under `defaults`.

When a new enabled root is added to the configuration, it is generated as soon as the path is available. Automated runs are headless and do not wait for the interactive 8-second timers.

### Merged playlists

A merge definition contains an ordered source list and one output path:

```json
"merged_playlists": [
  {
    "enabled": true,
    "name": "Combined portrait library",
    "output": "D:\\Playlists\\Combined Portrait.m3u",
    "sources": [
      "E:\\Collection A\\Vert.m3u",
      "F:\\Collection B\\Vert.m3u",
      "G:\\Vault\\Collection C\\Vert.m3u"
    ],
    "deduplicate": true,
    "allow_partial": false
  }
]
```

Source playlists are read in the order shown. Their entries retain their `#EXTINF` metadata and source-relative media paths are converted to absolute paths before being written to the merged output.

With `deduplicate` set to `true`, the first occurrence of a media path is retained and later duplicates are omitted. Set it to `false` when repeated entries are intentional.

With `allow_partial` set to `false`, any unavailable source prevents the merge from replacing its current output. This is the default and protects the last good playlist while a drive or vault is unavailable. Setting it to `true` permits an output made from the sources that are currently readable.

Merged outputs are rebuilt automatically when a source playlist changes. Run `Merge-Playlists.cmd` to rebuild all enabled merges immediately.

## Complete configuration example

```json
{
  "schema_version": 1,
  "defaults": {
    "sort": "date_modified",
    "orientation": "accurate"
  },
  "automation": {
    "enabled": true,
    "debounce_seconds": 5,
    "reconciliation_interval_seconds": 900,
    "source_poll_interval_seconds": 5,
    "config_poll_interval_seconds": 2,
    "watcher_retry_seconds": 30
  },
  "watched_roots": [
    {
      "enabled": true,
      "path": "E:\\Videos",
      "sort": "date_modified",
      "orientation": "accurate"
    }
  ],
  "merged_playlists": [
    {
      "enabled": true,
      "name": "Combined landscape library",
      "output": "D:\\Playlists\\Combined Landscape.m3u",
      "sources": [
        "E:\\Videos\\Horz.m3u",
        "F:\\Archive\\Horz.m3u"
      ],
      "deduplicate": true,
      "allow_partial": false
    }
  ]
}
```

## Automatic regeneration

On Windows, the hidden process uses recursive native directory change notifications for configured roots. Events are debounced so a burst of related file operations produces one regeneration rather than one run per event.

A periodic reconciliation also compares the configured policy, generator version, video paths, sizes, modification times and expected output files. The default interval is 900 seconds. This catches changes that a mounted or virtual filesystem did not report and also regenerates a root after its sort or orientation setting changes.

The automation ignores its own `.m3u` and cache writes, serialises regeneration jobs, and never runs two updates for the same root at once.

## Cryptomator and unavailable drives

A locked Cryptomator vault normally appears as an unavailable root or source. Playlist Builder does not run the generator against an unavailable root and does not replace a complete merged playlist with an incomplete one.

The watcher retries unavailable roots periodically. When a mounted root becomes available, native notifications resume and reconciliation remains the fallback.

Generated media entries retain the existing Cryptomator mounted-drive translation used by the generator, so MPV and Explorer receive mounted paths rather than Cryptomator backing UNC paths.

## Diagnostics

Automation files are stored under:

```text
%LOCALAPPDATA%\PlaylistBuilder\
```

The main diagnostic files are:

```text
automation.log          Rotating activity and error log
automation_state.json   Disposable reconciliation state
```

The log retains up to four files of approximately 1 MB each.

The automation also supports these direct commands:

```text
playlist_automation.py --validate-config
playlist_automation.py --merge-now
playlist_automation.py --rebuild-all
```

The supplied `Merge-Playlists.cmd` wraps `--merge-now` against the installed configuration.

## Uninstall

Run:

```text
Uninstall.cmd
```

This removes:

- the Explorer context-menu entries;
- the current-user startup registration;
- the hidden automation process;
- `%LOCALAPPDATA%\PlaylistBuilder`.

It preserves:

```text
%APPDATA%\PlaylistBuilder\playlist_builder.json
```

Generated playlists and per-folder cache files are also left unchanged.
