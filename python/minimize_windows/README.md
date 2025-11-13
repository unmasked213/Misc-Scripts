# Automatic Window Minimizer

## What does it do?

This script automatically minimizes certain windows on your computer based on rules you can customize. It's like having a helper that tidies up your screen by putting away windows you don't need right now.

The script can minimize:
- Media viewer windows (like image and video players)
- Windows showing specific file types (like .jpg, .png, .pdf)
- Web browser tabs (but you can protect important ones)
- File Explorer windows

You have full control over what gets minimized and what stays open.

## How to set up

### Step 1: Install Python

If you don't have Python installed:
1. Go to https://www.python.org/downloads/
2. Download Python 3.9 or newer
3. Run the installer and check "Add Python to PATH"

### Step 2: Install required packages

Open Command Prompt and type:

```
pip install pygetwindow pywin32
```

These packages let the script see and control your windows.

### Step 3: Customize what gets minimized

Open `minimize_windows.py` in a text editor (like Notepad) and look for these sections:

**Programs and file types to minimize:**
Find the list called `keywords_to_minimize`. You can add or remove items here. For example:
- Add `"Notepad"` to minimize all Notepad windows
- Add `".txt"` to minimize windows showing text files

**Windows to protect:**
Find the list called `exceptions`. Add any specific window names you never want minimized.

**Browser tabs to keep open:**
Find the list called `browser_whitelist`. Add words that appear in tabs you want to keep open. For example:
- `"Gmail"` keeps Gmail tabs open
- `"YouTube"` keeps YouTube tabs open

## How to use it

### Running the script:

1. Double-click `minimize_windows.py`
2. The script runs instantly and minimizes matching windows
3. You'll see messages showing what was minimized
4. Press Enter to close the window when done

### What happens:

The script looks at all your open windows and:
1. Checks each window's title
2. If it matches your rules, it gets minimized
3. If it's on your exception list, it stays open
4. Shows you what it did

## Example uses

**Cleaning up after photo viewing:**
- You've been looking at photos and have 20 image windows open
- Run the script and they all minimize to your taskbar
- Your desktop is clean again!

**Maintaining focus:**
- You want to keep certain browser tabs open while minimizing everything else
- Add important sites to the whitelist
- Run the script to minimize distractions

**Quick desktop cleanup:**
- You have File Explorer windows everywhere
- Run the script to minimize them all at once

## Customization examples

**To minimize all Notepad windows:**
Add `"Notepad"` to the `keywords_to_minimize` list

**To protect a specific file:**
Add the window title (like `"important-document.pdf"`) to the `exceptions` list

**To keep Netflix open in browser:**
Add `"Netflix"` to the `browser_whitelist`

## Things to know

- **Safe operation:** The script only minimizes windows - it doesn't close them
- **Instant effect:** Changes happen immediately when you run it
- **Customizable:** The lists at the bottom of the script control everything
- **Reversible:** Minimized windows are still in your taskbar - just click to bring them back
- **Current state only:** It only affects windows that are open when you run it
