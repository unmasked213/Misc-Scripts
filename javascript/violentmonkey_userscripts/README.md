# Browser Userscripts

Userscripts that enhance your web browsing experience. Requires [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/) browser extension.

---

## Installation

1. Install [Violentmonkey](https://violentmonkey.github.io/) (recommended) or [Tampermonkey](https://www.tampermonkey.net/)
2. Click the **Raw** button on any `.user.js` file in GitHub
3. Violentmonkey will prompt you to install - click **Confirm**

Scripts auto-update when new versions are pushed to this repository.

---

## Scripts

### global_short_video_hider.user.js

Hide short videos globally across any website.

| | |
|---|---|
| **Version** | 2.3 |
| **Match** | All sites (`*://*/*`) |
| **Grants** | None |

**Features:**
- Hides videos under 59 seconds based on visible duration text
- Protects containers with confirmed long videos from being hidden
- Uses WeakSet for efficient memory management
- Works on dynamically loaded content via MutationObserver

---

### page_hopper.user.js

Navigate paginated websites using keyboard shortcuts.

| | |
|---|---|
| **Version** | 7.1 |
| **Match** | All sites (excludes ChatGPT, Gmail, Google Docs) |
| **Grants** | `GM_setValue`, `GM_getValue` |

**Features:**
- Press `]` for next page, `[` for previous page
- Advanced pagination detection with minimal false positives
- Handles high page numbers and embedded digits correctly
- Supports URL parameters, hash fragments, and path-based pagination
- Visual indicator shows page navigation feedback

---

### rectangle_link_selector.user.js

Select multiple links by drawing a rectangle with right-click drag.

| | |
|---|---|
| **Version** | 1.2 |
| **Match** | All sites (`*://*/*`) |
| **Grants** | `GM_openInTab` |

**Features:**
- Right-click and drag to draw selection rectangle
- All links within rectangle are highlighted
- Release to open all selected links in new tabs
- Configurable colors, drag threshold, and max links (default 99)

---

### universal_image_downloader.user.js

Download images from any website with a simple double-click.

| | |
|---|---|
| **Version** | 6.1 |
| **Match** | All sites (`*://*/*`) |
| **Grants** | `GM_download`, `GM_xmlhttpRequest`, `GM_setValue`, `GM_getValue`, `GM_notification`, `GM_listValues`, `GM_deleteValue` |

**Features:**
- Double-click any image to download
- Prevents duplicate downloads
- Handles background images and hidden images
- Multiple download methods (direct, fetch, GM_download)
- Optional timestamp in filename

---

### reddit_to_redlib_redirector.user.js

Automatically redirects Reddit URLs to privacy-friendly Redlib instances.

| | |
|---|---|
| **Version** | 5.0 |
| **Match** | `reddit.com`, `www.reddit.com`, `old.reddit.com` |
| **Grants** | `GM_xmlhttpRequest` |

**Features:**
- Hybrid auto-discovery from official Redlib instance list
- Caches working instances (1 hour TTL)
- Health checks with smart fallback
- Static fallback instances when cache is empty

---

### video_management_examplesite.user.js

Video management utilities template for site-specific customization.

| | |
|---|---|
| **Version** | 5.1 |
| **Match** | Example site pattern (customize for your target) |
| **Grants** | None |

**Features:**
- Play/pause all videos
- Jump to video midpoint
- Hide short videos (configurable threshold)
- Toggle image visibility
- Hide unloaded videos

**Note:** This is a template. Modify the `@include` pattern and site-specific selectors for your target website.

---

## Development

See [CLAUDE.md](../../CLAUDE.md) for userscript header requirements and code conventions.

**Key requirements:**
- `@namespace` must be `https://github.com/unmasked213/Misc-Scripts`
- `@version` must increment on every change
- `@run-at` must be explicitly set
- Header must start at byte 0 (no blank lines before it)
