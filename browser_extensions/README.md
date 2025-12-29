# Browser Extensions

Native browser extensions for Chrome, Brave, Edge, and other Chromium-based browsers.

---

## Available Extensions

| Extension | Description | Details |
|-----------|-------------|---------|
| [Image Downloader](image-downloader-extension/) | Batch download images from selected tabs with duplicate detection | [README](image-downloader-extension/README.md) |

---

## Installation

All extensions use Chrome's Manifest V3 format and can be installed in Developer mode:

1. Navigate to your browser's extensions page:
   - Chrome: `chrome://extensions/`
   - Brave: `brave://extensions/`
   - Edge: `edge://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the extension's folder

---

## Extension Architecture

Each extension follows this structure:

```
extension-name/
├── manifest.json       # Extension manifest (permissions, entry points)
├── background.js       # Service worker for background processing
├── popup.html          # Popup UI (if applicable)
├── popup.js            # Popup logic (if applicable)
├── content.js          # Content script (if applicable)
├── icons/              # Extension icons (16, 48, 128px)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           # Extension documentation
```

---

## Comparison: Extensions vs Userscripts

| Aspect | Browser Extensions | Userscripts |
|--------|-------------------|-------------|
| **Installation** | Load unpacked in developer mode | Violentmonkey/Tampermonkey |
| **Permissions** | Declared in manifest, approved once | Granted per-script |
| **Background tasks** | Service workers with full API | Limited to page context |
| **Tab management** | Full chrome.tabs API access | Restricted |
| **Storage** | chrome.storage (sync, local) | GM_setValue (limited) |
| **Updates** | Manual reload or Chrome Web Store | Auto-update via `@updateURL` |

Extensions are preferred for:
- Features requiring tab management
- Background processing
- Complex UI (popups, options pages)
- Cross-tab coordination

Userscripts are preferred for:
- Per-page DOM manipulation
- Quick prototyping
- Simpler distribution

---

## Development Guidelines

See [CLAUDE.md](CLAUDE.md) for detailed development conventions.

### Key Points

- Use Manifest V3 (service workers, not background pages)
- Declare minimal required permissions
- Store user preferences in `chrome.storage.local`
- Use content scripts for page interaction
- Service workers cannot access DOM directly

---

## Adding New Extensions

1. Create a new folder with the extension name
2. Add `manifest.json` with required permissions
3. Implement background/content scripts as needed
4. Add icons in 16x16, 48x48, and 128x128 sizes
5. Create a README.md documenting the extension
6. Update this README's extension table
