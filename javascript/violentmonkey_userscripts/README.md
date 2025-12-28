# Browser Userscripts

Userscripts that enhance your web browsing experience. Requires [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).

---

## Table of Contents

### Scripts
| Script | Description |
|--------|-------------|
| [Global Short Video Hider](#global-short-video-hider) | Hide videos under 60 seconds on any site |
| [Page Hopper](#page-hopper) | Navigate paginated sites with `[` and `]` keys |
| [Rectangle Link Selector](#rectangle-link-selector) | Select multiple links by drawing a rectangle |
| [Universal Image Downloader](#universal-image-downloader) | Download images with double-click |
| [Reddit to Redlib Redirector](#reddit-to-redlib-redirector) | Redirect Reddit to privacy-friendly Redlib |
| [Video Management Template](#video-management-template) | Template for site-specific video controls |

### Other Sections
- [Installation](#installation)
- [Development Guidelines](#development-guidelines)

---

## Installation

1. Install [Violentmonkey](https://violentmonkey.github.io/) (recommended) or [Tampermonkey](https://www.tampermonkey.net/)
2. Click the **Raw** button on any `.user.js` file in GitHub
3. Violentmonkey will prompt to install - click **Confirm**

Scripts auto-update when new versions are pushed to this repository.

---

## Global Short Video Hider

> **File:** [`global_short_video_hider.user.js`](global_short_video_hider.user.js)

Hide short videos globally across any website. Automatically detects and hides videos under a configurable duration threshold.

### Details

| Property | Value |
|----------|-------|
| Version | 2.3 |
| Match | All sites (`*://*/*`) |
| Grants | None |
| Run At | `document-idle` |

### Features

- Hides videos under 59 seconds based on visible duration text
- Protects containers with confirmed long videos from being hidden
- Uses WeakSet for efficient memory management
- Works on dynamically loaded content via MutationObserver
- Detects duration in `MM:SS` format from overlay text

### How It Works

The script scans for duration text (e.g., "0:45", "1:30") near video elements. If the duration is below the threshold, it hides the containing card/container. Once a container shows a long video, it's permanently protected from hiding.

---

## Page Hopper

> **File:** [`page_hopper.user.js`](page_hopper.user.js)

Navigate paginated websites using keyboard shortcuts. Press `]` for next page, `[` for previous page.

### Details

| Property | Value |
|----------|-------|
| Version | 7.1 |
| Match | All sites (excludes ChatGPT, Gmail, Google Docs) |
| Grants | `GM_setValue`, `GM_getValue` |
| Run At | `document-start` |

### Features

- Press `]` for next page, `[` for previous page
- Advanced pagination detection with minimal false positives
- Handles high page numbers and embedded digits correctly
- Supports URL parameters, hash fragments, and path-based pagination
- Visual indicator shows page navigation feedback
- Configurable step size and key bindings

### Supported Pagination Patterns

| Pattern | Example |
|---------|---------|
| Query parameter | `?page=5`, `?p=3`, `?pg=10` |
| Hash fragment | `#page=5` |
| Path-based | `/page/5/`, `/p/3` |

### Excluded Sites

ChatGPT, Gmail, and Google Docs are excluded to prevent interference with their own keyboard shortcuts.

---

## Rectangle Link Selector

> **File:** [`rectangle_link_selector.user.js`](rectangle_link_selector.user.js)

Select multiple links by drawing a rectangle with right-click drag. Opens all selected links in new tabs.

### Details

| Property | Value |
|----------|-------|
| Version | 1.2 |
| Match | All sites (`*://*/*`) |
| Grants | `GM_openInTab` |
| Run At | `document-end` |

### Features

- Right-click and drag to draw selection rectangle
- All links within rectangle are highlighted in green
- Release to open all selected links in new tabs
- Configurable colors, drag threshold, and max links
- Works with both text links and image links

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `DRAG_THRESHOLD` | 15px | Minimum drag distance to activate |
| `MAX_LINKS` | 99 | Maximum links to open at once |
| `TAB_OPEN_DELAY` | 1000ms | Delay between opening tabs |

### Usage

1. Hold right mouse button and drag to draw a rectangle
2. Links inside the rectangle are highlighted
3. Release to open all highlighted links in new tabs
4. If drag distance is below threshold, normal context menu appears

---

## Universal Image Downloader

> **File:** [`universal_image_downloader.user.js`](universal_image_downloader.user.js)

Download images from any website with a simple double-click. Handles various image types and prevents duplicates.

### Details

| Property | Value |
|----------|-------|
| Version | 6.1 |
| Match | All sites (`*://*/*`) |
| Grants | `GM_download`, `GM_xmlhttpRequest`, `GM_setValue`, `GM_getValue`, `GM_notification`, `GM_listValues`, `GM_deleteValue` |
| Run At | `document-start` |

### Features

- Double-click any image to download
- Prevents duplicate downloads (tracks downloaded URLs)
- Handles background images and hidden images
- Multiple download methods (direct, fetch, GM_download)
- Optional timestamp in filename
- Queue system for multiple downloads

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `closeTabAfterDownload` | false | Close tab after downloading |
| `useTimestampInFilename` | true | Add timestamp to filename |
| `showNotifications` | false | Show download notifications |
| `maxParallelDownloads` | 1 | Concurrent download limit |

### Supported Image Sources

- Regular `<img>` elements
- CSS background images
- Lazy-loaded images (`data-src`, `data-lazy`)
- `<picture>` and `<source>` elements

---

## Reddit to Redlib Redirector

> **File:** [`reddit_to_redlib_redirector.user.js`](reddit_to_redlib_redirector.user.js)

Automatically redirects Reddit URLs to privacy-friendly Redlib instances. Uses smart instance discovery and health checking.

### Details

| Property | Value |
|----------|-------|
| Version | 5.0 |
| Match | `reddit.com`, `www.reddit.com`, `old.reddit.com` |
| Grants | `GM_xmlhttpRequest` |
| Run At | `document-start` |

### Features

- Hybrid auto-discovery from official Redlib instance list
- Caches working instances (1 hour TTL)
- Health checks with smart fallback
- Static fallback instances when cache is empty
- Preserves Reddit URL path structure

### How It Works

1. On page load, fetches the official Redlib instance list
2. Health-checks instances to find a working one
3. Caches the working instance for 1 hour
4. Redirects Reddit URL to the cached instance
5. Falls back to static list if discovery fails

### Fallback Instances

If auto-discovery fails, these static instances are used:
- `redlib.seasi.dev`
- `rl.bloat.cat`
- `redlib.freedit.eu`
- `redlib.perennialte.ch`

---

## Video Management Template

> **File:** [`video_management_examplesite.user.js`](video_management_examplesite.user.js)

A template for creating site-specific video management scripts. Customize the match pattern and selectors for your target site.

### Details

| Property | Value |
|----------|-------|
| Version | 5.1 |
| Match | Example pattern (customize for your site) |
| Grants | None |
| Run At | (default) |

### Features

- Play/pause all videos on page
- Jump to video midpoint
- Hide short videos (configurable threshold)
- Toggle image visibility
- Hide unloaded videos
- Keyboard shortcuts for all actions

### Customization

To use this template:

1. Copy the script
2. Change the `@include` pattern to match your target site
3. Adjust selectors in the code to match your site's HTML structure
4. Modify the duration threshold as needed

### Default Keyboard Shortcuts

| Key | Action |
|-----|--------|
| (customize) | Play/pause all videos |
| (customize) | Jump to midpoint |
| (customize) | Toggle short video visibility |
| (customize) | Toggle image visibility |

---

## Development Guidelines

See [CLAUDE.md](../../CLAUDE.md) for complete userscript conventions.

### Header Requirements (Mandatory)

All userscripts must include:

```javascript
// ==UserScript==
// @name         Script Name
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      1.0
// @description  Brief description
// @author       Unmasked213
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/.../script.user.js
// @downloadURL  https://raw.githubusercontent.com/.../script.user.js
// ==/UserScript==
```

### Key Rules

| Rule | Requirement |
|------|-------------|
| `@namespace` | Must be `https://github.com/unmasked213/Misc-Scripts` |
| `@version` | Must increment on every change |
| `@run-at` | Must be explicitly set |
| Header position | Must start at byte 0 (no blank lines before) |
| `@grant` | Minimal and explicit (no unused grants) |

### Code Structure

```javascript
(function() {
    'use strict';

    const CONFIG = {
        // User-configurable options at top
    };

    // Main script logic
})();
```
