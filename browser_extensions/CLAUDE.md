# CLAUDE - Browser Extensions

Development guidelines for browser extensions in this repository.

---

## Overview

This folder contains native browser extensions using Chrome's Manifest V3 format. Extensions work on Chrome, Brave, Edge, and other Chromium-based browsers.

---

## Structure

```
browser_extensions/
├── CLAUDE.md                          # This file
├── README.md                          # User-facing documentation
└── media-downloader-extension/        # Image batch downloader
    ├── manifest.json                  # Extension manifest
    ├── background.js                  # Service worker
    ├── popup.html                     # Popup UI
    ├── popup.js                       # Popup logic
    ├── icons/                         # Extension icons
    │   ├── icon16.png
    │   ├── icon48.png
    │   └── icon128.png
    └── README.md                      # Extension documentation
```

---

## Manifest V3 Requirements

### Service Workers (not Background Pages)

Extensions must use service workers, not persistent background pages:

```json
{
  "manifest_version": 3,
  "background": {
    "service_worker": "background.js"
  }
}
```

Service worker restrictions:
- No DOM access (use `OffscreenCanvas`, not `document`)
- No `XMLHttpRequest` (use `fetch`)
- No `URL.createObjectURL` (use data URLs or `chrome.downloads`)
- Workers terminate when idle (persist state in `chrome.storage`)

### Permissions

Declare minimal permissions:

```json
{
  "permissions": [
    "tabs",           // Only if querying/modifying tabs
    "downloads",      // Only if downloading files
    "storage",        // Only if persisting data
    "activeTab",      // Preferred over broad host permissions
    "scripting"       // Only if injecting content scripts
  ],
  "host_permissions": [
    "<all_urls>"      // Only if fetching from arbitrary sites
  ]
}
```

Prefer `activeTab` over `host_permissions` when possible - it grants temporary access only when the user invokes the extension.

---

## Code Conventions

### File Organization

```
extension-folder/
├── manifest.json       # Required: extension configuration
├── background.js       # Service worker (background tasks)
├── popup.html          # Popup UI markup
├── popup.js            # Popup logic
├── content.js          # Content script (page interaction)
├── options.html        # Options page (if needed)
├── options.js          # Options page logic
├── icons/              # Required icons
│   ├── icon16.png      # Toolbar icon
│   ├── icon48.png      # Extensions page
│   └── icon128.png     # Installation dialog
└── README.md           # Extension documentation
```

### JavaScript Style

Use consistent structure across scripts:

```javascript
/**
 * Extension Name - Script Purpose
 * Brief description of what this script does.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const Config = {
    // User-configurable settings at top
    featureEnabled: true,
    timeout: 5000
};

// =============================================================================
// UTILITIES
// =============================================================================

const Utils = {
    log(...args) {
        console.log('[ExtensionName]', ...args);
    },

    // Pure utility functions
};

// =============================================================================
// MAIN LOGIC
// =============================================================================

// Feature implementation

// =============================================================================
// EVENT LISTENERS
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Message handling
    return true; // Keep channel open for async
});

chrome.runtime.onInstalled.addListener(() => {
    // Initialization
});
```

### HTML/CSS Style

Use design tokens for consistent theming:

```css
:root {
    /* Spacing */
    --ui-space-1: 4px;
    --ui-space-2: 8px;
    --ui-space-3: 12px;

    /* Colors */
    --ui-surface: rgb(11, 14, 23);
    --ui-text: rgb(228, 228, 242);
    --ui-accent: rgb(30, 171, 208);

    /* Motion */
    --ui-motion-fast: 120ms cubic-bezier(0.2, 0, 0.2, 1);
}
```

---

## Communication Patterns

### Popup to Background

```javascript
// popup.js
const response = await chrome.runtime.sendMessage({
    action: 'do-something',
    options: { key: 'value' }
});

// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'do-something') {
        doSomething(message.options).then(result => {
            sendResponse(result);
        });
        return true; // Keep channel open for async
    }
});
```

### Background to Content Script

```javascript
// background.js
const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
        // This runs in page context
        return document.title;
    }
});

// Or for more complex scripts
const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
});
```

---

## Storage Patterns

### Saving Settings

```javascript
// Save
await chrome.storage.local.set({
    settingName: value,
    anotherSetting: otherValue
});

// Load
const result = await chrome.storage.local.get(['settingName', 'anotherSetting']);
const value = result.settingName ?? defaultValue;
```

### Caching with Expiry

```javascript
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedValue(key) {
    const result = await chrome.storage.local.get([key, `${key}_timestamp`]);

    if (result[key] && result[`${key}_timestamp`]) {
        if (Date.now() - result[`${key}_timestamp`] < CACHE_TTL) {
            return result[key];
        }
    }
    return null;
}

async function setCachedValue(key, value) {
    await chrome.storage.local.set({
        [key]: value,
        [`${key}_timestamp`]: Date.now()
    });
}
```

---

## Testing Extensions

### Manual Testing Checklist

- [ ] Extension loads without errors in console
- [ ] Popup opens and displays correctly
- [ ] All buttons/controls function
- [ ] Settings persist after browser restart
- [ ] Keyboard shortcuts work
- [ ] Error states handled gracefully
- [ ] Works on various page types

### Debugging

1. Open `chrome://extensions/`
2. Click "Service Worker" link to open DevTools for background script
3. Right-click popup and "Inspect" for popup DevTools
4. Check "Errors" button for manifest/loading issues

---

## Icon Requirements

| Size | Usage |
|------|-------|
| 16x16 | Browser toolbar |
| 48x48 | Extensions management page |
| 128x128 | Chrome Web Store, installation |

Use PNG format with transparency. Icons should be recognizable at 16px.

---

## Documentation Requirements

Each extension must have a README.md with:

1. **Title and description** - What the extension does
2. **Features** - List of capabilities
3. **Installation** - Step-by-step guide
4. **Usage** - How to use the extension
5. **Configuration** - Available settings
6. **Permissions** - What permissions are needed and why
7. **Troubleshooting** - Common issues and solutions

---

## Security Considerations

- Never store sensitive data in `chrome.storage.sync` (syncs to cloud)
- Sanitize any data injected into pages
- Use CSP-compliant code (no inline scripts in HTML)
- Validate all message data before processing
- Prefer `activeTab` over broad host permissions
