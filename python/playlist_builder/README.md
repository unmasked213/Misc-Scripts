# Generate video playlists

Adds a per-user Windows File Explorer command named **Generate video playlists**.

It appears when:

- right-clicking a selected folder;
- right-clicking the background of an open folder.

The command opens the included playlist generator in a visible console and passes it the folder you clicked. The script then retains its normal interactive sort and orientation choices, scans the folder recursively, and writes its playlists into that folder.

## Install

Put all six files together in:

```text
D:\scripts\Misc Scripts\Misc-Scripts\python\playlist_builder\
```

Then run `Install.cmd`.

The installer:

- checks for Python 3.10 or later;
- copies `playlist_generator.py` to `%LocalAppData%\PlaylistBuilder\`;
- creates a VBS launcher that opens the generator visibly;
- registers the two menu entries under `HKCU\Software\Classes`;
- requires no administrator rights.

`ffprobe` enables duration, quality, orientation splitting and duplicate detection. `ffmpeg` enables accurate orientation analysis and content fingerprinting. They must be available on `PATH` for the corresponding features, exactly as when the script is run normally.

## Behaviour

The clicked folder becomes the generator's working folder. It recursively scans that folder and writes or replaces:

- `Horz.m3u`;
- `Vert.m3u`;
- `Dupes.m3u`, when duplicate groups are found;
- `.playlist_generator_cache.json`.

Running `playlist_generator.py` normally without `--path` still processes the folder containing the script, preserving the original drop-in behaviour.

The installer keeps its own copy in `%LocalAppData%`. After replacing or editing the source `playlist_generator.py`, run `Install.cmd` again to update the context-menu copy.

## Uninstall

Run `Uninstall.cmd`.

This removes the current-user Explorer entries and `%LocalAppData%\PlaylistBuilder`. It does not remove playlists or cache files already created in video folders.
