# Copy directory tree

Adds a per-user Windows File Explorer command named **Copy directory tree**.

It appears when:

- right-clicking a selected folder;
- right-clicking the background of an open folder.

The command runs the included `dir_tree.py` invisibly, generates the same Markdown tree as the original script, and copies it directly to the Windows clipboard. No tree file is written.

## Install

Run `Install.cmd`.

The installer:

- copies the script to `%LocalAppData%\CopyDirectoryTree\dir_tree.py`;
- creates a hidden VBS launcher;
- registers the two menu entries under `HKCU\Software\Classes`;
- requires no administrator rights.

Python 3.10 or later is required. The optional `pathspec` package is still used when available for `.gitignore`, `.treeignore` and other `.*ignore` files.

## Behaviour

Clipboard mode is deliberately non-interactive. Directories above the script's normal prompt threshold are scanned in full rather than silently truncated.

Running `dir_tree.py` normally still retains the original behaviour: console progress, large-directory prompts, Markdown file output, and the final Enter-to-close pause.

Successful context-menu copies are silent. A Windows error dialog appears only if the scan or clipboard operation fails.

## Uninstall

Run `Uninstall.cmd`.
