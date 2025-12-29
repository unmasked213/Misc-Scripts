# HA-UI-System

A token-driven UI design system for Home Assistant dashboards.

## Overview

HA-UI-System provides a comprehensive design foundation for building consistent, accessible, theme-adaptive custom cards in Home Assistant. Built on Material Design 3 principles, it enforces enterprise-grade precision through immutable tokens and strict implementation rules.

### Features

- **Token-driven architecture** - Every value derives from defined tokens (spacing, colors, radii, motion)
- **4px spacing grid** - Consistent geometric lattice across all components
- **Theme equality** - Light and dark themes receive equal implementation quality
- **Semantic color roles** - Colors chosen by meaning (accent, success, error, warning, info)
- **Fixed component geometry** - Buttons, inputs, switches use immutable dimensions
- **Unified state model** - Consistent hover/pressed/active/disabled behavior
- **Accessibility-first** - WCAG compliant, 48px touch targets, keyboard navigation

## Quick Start

### Installation

1. Copy repository contents to your Home Assistant config directory
2. Ensure `www/` contents are accessible at `/local/` in Home Assistant
3. Add resources to your Lovelace configuration:

```yaml
# In configuration.yaml
lovelace:
  mode: yaml
  resources: !include ui/ui_lovelace_resources.yaml
```

### Usage

Import the core libraries in your custom cards:

```javascript
import { sharedStyles } from '/local/base/foundation.js';
import { UIComponents } from '/local/base/components.js';
```

Use design tokens in your CSS:

```css
.my-card {
  padding: var(--ui-space-4);           /* 16px */
  border-radius: var(--ui-radius-m);    /* 12px */
  background: var(--ui-elevated-1);
  color: var(--ui-text);
}

.my-button {
  padding: var(--ui-space-2) var(--ui-space-5);
  border-radius: var(--ui-radius-pill);
  transition: var(--ui-motion-fast);
}
```

## Token Reference

### Spacing (4px grid)

| Token | Value | Usage |
|-------|-------|-------|
| `--ui-space-1` | 4px | Tight spacing |
| `--ui-space-2` | 8px | Icon gaps, compact |
| `--ui-space-3` | 12px | Row/column gaps |
| `--ui-space-4` | 16px | Standard padding |
| `--ui-space-5` | 20px | Button horizontal |
| `--ui-space-6` | 24px | Section breaks |
| `--ui-space-8` | 32px | Large spacing |
| `--ui-space-10` | 48px | Maximum spacing |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--ui-radius-s` | 8px | Chips, badges |
| `--ui-radius-m` | 12px | Cards |
| `--ui-radius-l` | 18px | Modals |
| `--ui-radius-xl` | 32px | Menus |
| `--ui-radius-pill` | 999px | Buttons |

### Colors (semantic)

| Token | Purpose |
|-------|---------|
| `--ui-accent` | Primary actions |
| `--ui-success` | Confirmations |
| `--ui-error` | Destructive actions |
| `--ui-warning` | Caution states |
| `--ui-info` | Informational |
| `--ui-text` | Main content |
| `--ui-text-mute` | Secondary text |
| `--ui-elevated-0` to `-4` | Surface tiers |

### Motion

| Token | Duration | Usage |
|-------|----------|-------|
| `--ui-motion-fast` | 120ms | Hover, quick feedback |
| `--ui-motion-med` | 240ms | Standard transitions |
| `--ui-motion-slow` | 360ms | Complex animations |

Easing: `cubic-bezier(0.2, 0, 0.2, 1)`

## Project Structure

```
HA-UI-System/
├── www/
│   ├── base/              # Core libraries
│   │   ├── foundation.js  # Tokens, CSS reset
│   │   ├── components.js  # UI components
│   │   ├── helpers.js     # DOM utilities
│   │   ├── utilities.js   # Helper functions
│   │   ├── toggles.js     # Toggle switches
│   │   └── tooltips.js    # Tooltip system
│   └── cards/             # Test catalogue cards
├── ui/                    # Lovelace configuration
├── themes/                # Theme definitions
├── shared_ui_docs/        # Design system documentation
│   ├── spec.md            # Design specification
│   ├── context.md         # System context
│   ├── implementation_guide.md      # AI implementation rules
│   ├── component_authoring.md       # Component authoring patterns
│   ├── implementation_status.md     # Implementation tracking
│   └── CLAUDE.md          # Repository guide for AI assistants
└── components.css         # Reference implementations
```

## Documentation

| Document | Purpose |
|----------|---------|
| [../../shared_ui_docs/spec.md](../../shared_ui_docs/spec.md) | Complete design system specification |
| [token_set.css](token_set.css) | Canonical token definitions |
| [../../shared_ui_docs/implementation_guide.md](../../shared_ui_docs/implementation_guide.md) | Implementation rules for AI assistants |
| [../../shared_ui_docs/context.md](../../shared_ui_docs/context.md) | Current system state and decisions |
| [../../shared_ui_docs/CLAUDE.md](../../shared_ui_docs/CLAUDE.md) | Repository guide for AI assistants |

## Components

### Available

- **Buttons** - Standard, icon, pill variants with states
- **Inputs** - Text fields with validation states
- **Toggles** - Material Design 3 switches
- **Tooltips** - Plain and rich variants
- **Spinners** - Loading indicators
- **Copy buttons** - Clipboard interaction

### Test Cards

Visual component catalogues for verification:
- `ui-test-buttons.js` - Button showcase
- `ui-test-forms.js` - Form components
- `ui-test-feedback.js` - Feedback elements
- `ui-test-tooltips.js` - Tooltip demos

## Themes

The system supports both light and dark themes with equal quality:

```html
<body class="light-theme">  <!-- or class="dark-theme" -->
```

All color tokens automatically adapt to the active theme.

## Development

### Visual Testing

Open `visual_test.html` in a browser for standalone component testing.

### Home Assistant Testing

1. Add test cards to a Lovelace view
2. Verify components in both themes
3. Check touch targets and accessibility

### No Build Required

Direct ES6 module development. Files load via Home Assistant Lovelace resources.

## Current Status

**Foundation complete.** Token system finalized and locked. Specification and implementation guide written.

**Next milestone:** Implement first Home Assistant card using v1 token system to prove end-to-end functionality.

## License

Private repository for Home Assistant dashboard development.
