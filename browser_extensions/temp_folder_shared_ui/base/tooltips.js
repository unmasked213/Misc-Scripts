// /config/www/base/tooltips.js

// ============================================================
// TOOLTIP SYSTEM
// Material Design 3 Expressive-inspired tooltips
// ============================================================
//
// NOTE: Tooltips are appended to document.body (not shadow DOM)
// and use CSS classes from components.js with design system tokens.
//
// USAGE PATTERNS:
//
// 1. Programmatic (JavaScript):
//    import { showTooltip, showRichTooltip } from '/local/base/tooltips.js';
//    showTooltip(anchorElement, 'Tooltip text', { position: 'top' });
//
// 2. Data Attribute (Declarative):
//    <button data-tooltip="Add to favorites">Icon</button>
//    Call initTooltips(shadowRoot) to activate
//
// 3. Auto-initialization:
//    initTooltips() is called on page load for light DOM
//
// ============================================================

// ============================================================
// TOOLTIP STATE MANAGEMENT
// ============================================================

let currentTooltip = null;
let showTimeout = null;
let hideTimeout = null;
let autoDismissTimeout = null;

// Check for reduced motion preference
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Calculates optimal tooltip position relative to anchor element
 */
function calculatePosition(anchor, tooltip, preferredPosition = 'top') {
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gap = 8;
  const viewportMargin = 8;

  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };

  const space = {
    top: anchorRect.top - viewportMargin,
    bottom: viewport.height - anchorRect.bottom - viewportMargin,
    left: anchorRect.left - viewportMargin,
    right: viewport.width - anchorRect.right - viewportMargin,
  };

  let position = preferredPosition;

  if (preferredPosition === 'top' && space.top < tooltipRect.height + gap) {
    position = space.bottom > space.top ? 'bottom' : 'top';
  } else if (preferredPosition === 'bottom' && space.bottom < tooltipRect.height + gap) {
    position = space.top > space.bottom ? 'top' : 'bottom';
  } else if (preferredPosition === 'left' && space.left < tooltipRect.width + gap) {
    position = space.right > space.left ? 'right' : 'left';
  } else if (preferredPosition === 'right' && space.right < tooltipRect.width + gap) {
    position = space.left > space.right ? 'left' : 'right';
  }

  let top, left;

  switch (position) {
    case 'top':
      top = anchorRect.top - tooltipRect.height - gap;
      left = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
      break;
    case 'bottom':
      top = anchorRect.bottom + gap;
      left = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
      break;
    case 'left':
      top = anchorRect.top + (anchorRect.height / 2) - (tooltipRect.height / 2);
      left = anchorRect.left - tooltipRect.width - gap;
      break;
    case 'right':
      top = anchorRect.top + (anchorRect.height / 2) - (tooltipRect.height / 2);
      left = anchorRect.right + gap;
      break;
  }

  left = Math.max(viewportMargin, Math.min(left, viewport.width - tooltipRect.width - viewportMargin));
  top = Math.max(viewportMargin, Math.min(top, viewport.height - tooltipRect.height - viewportMargin));

  return { top, left, actualPosition: position };
}

/**
 * Dismisses the currently visible tooltip
 */
function dismissTooltip() {
  if (currentTooltip) {
    currentTooltip.classList.remove('ui-tooltip--visible');

    const removeDelay = prefersReducedMotion() ? 0 : 150;
    setTimeout(() => {
      if (currentTooltip && currentTooltip.parentNode) {
        currentTooltip.parentNode.removeChild(currentTooltip);
      }
      currentTooltip = null;
    }, removeDelay);
  }

  if (showTimeout) {
    clearTimeout(showTimeout);
    showTimeout = null;
  }
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  if (autoDismissTimeout) {
    clearTimeout(autoDismissTimeout);
    autoDismissTimeout = null;
  }
}

// ============================================================
// PUBLIC API: PLAIN TOOLTIP
// ============================================================

/**
 * Shows a plain tooltip
 */
export function showTooltip(anchor, text, options = {}) {
  const {
    position = 'top',
    caret = false,
    delay = 400,
    autoDismiss = null,
  } = options;

  dismissTooltip();

  const tooltip = document.createElement('div');
  tooltip.className = 'ui-tooltip';
  tooltip.textContent = text;
  tooltip.setAttribute('role', 'tooltip');

  // Add caret if requested
  if (caret) {
    const caretEl = document.createElement('div');
    caretEl.className = `ui-tooltip__caret ui-tooltip__caret--${position}`;
    tooltip.appendChild(caretEl);
  }

  document.body.appendChild(tooltip);

  const pos = calculatePosition(anchor, tooltip, position);
  tooltip.style.top = `${pos.top}px`;
  tooltip.style.left = `${pos.left}px`;

  // Update caret class if position changed due to viewport constraints
  if (caret && pos.actualPosition !== position) {
    const caretEl = tooltip.querySelector('.ui-tooltip__caret');
    if (caretEl) {
      caretEl.className = `ui-tooltip__caret ui-tooltip__caret--${pos.actualPosition}`;
    }
  }

  const tooltipId = `tooltip-${Date.now()}`;
  tooltip.id = tooltipId;
  anchor.setAttribute('aria-describedby', tooltipId);

  currentTooltip = tooltip;

  const showDelay = prefersReducedMotion() ? 0 : delay;
  showTimeout = setTimeout(() => {
    tooltip.classList.add('ui-tooltip--visible');

    if (autoDismiss) {
      autoDismissTimeout = setTimeout(dismissTooltip, autoDismiss);
    }
  }, showDelay);
}

/**
 * Hides the current tooltip
 */
export function hideTooltip(delay = 100) {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
  }
  hideTimeout = setTimeout(dismissTooltip, delay);
}

// ============================================================
// PUBLIC API: RICH TOOLTIP
// ============================================================

/**
 * Shows a rich tooltip with title, body, and optional action
 */
export function showRichTooltip(anchor, content, options = {}) {
  const {
    position = 'top',
    caret = false,
    persistent = false,
    delay = 400,
  } = options;

  // Auto-enable persistent mode if there's an action button
  const isPersistent = persistent || !!content.action;

  dismissTooltip();

  const tooltip = document.createElement('div');
  tooltip.className = 'ui-tooltip ui-tooltip--rich';

  if (isPersistent) {
    tooltip.setAttribute('role', 'dialog');
  } else {
    tooltip.setAttribute('role', 'tooltip');
  }

  // Build content using semantic classes
  if (content.title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'ui-tooltip__title';
    titleEl.textContent = content.title;
    tooltip.appendChild(titleEl);
  }

  if (content.body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'ui-tooltip__body';
    bodyEl.textContent = content.body;
    tooltip.appendChild(bodyEl);
  }

  if (content.action) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'ui-tooltip__actions';

    const actionBtn = document.createElement('button');
    actionBtn.className = 'ui-tooltip__link';
    actionBtn.textContent = content.action.label;
    actionBtn.onclick = () => {
      content.action.onClick?.();
      dismissTooltip();
    };

    actionsEl.appendChild(actionBtn);
    tooltip.appendChild(actionsEl);
  }

  // Add caret if requested
  if (caret) {
    const caretEl = document.createElement('div');
    caretEl.className = `ui-tooltip__caret ui-tooltip__caret--${position}`;
    tooltip.appendChild(caretEl);
  }

  document.body.appendChild(tooltip);

  const pos = calculatePosition(anchor, tooltip, position);
  tooltip.style.top = `${pos.top}px`;
  tooltip.style.left = `${pos.left}px`;

  // Update caret class if position changed due to viewport constraints
  if (caret && pos.actualPosition !== position) {
    const caretEl = tooltip.querySelector('.ui-tooltip__caret');
    if (caretEl) {
      caretEl.className = `ui-tooltip__caret ui-tooltip__caret--${pos.actualPosition}`;
    }
  }

  const tooltipId = `rich-tooltip-${Date.now()}`;
  tooltip.id = tooltipId;
  anchor.setAttribute('aria-describedby', tooltipId);

  currentTooltip = tooltip;

  const showDelay = prefersReducedMotion() ? 0 : delay;
  showTimeout = setTimeout(() => {
    tooltip.classList.add('ui-tooltip--visible');
  }, showDelay);

  // Handle persistent mode click-outside dismiss
  if (isPersistent) {
    const handleClickOutside = (e) => {
      if (!tooltip.contains(e.target) && !anchor.contains(e.target)) {
        dismissTooltip();
        document.removeEventListener('click', handleClickOutside);
      }
    };

    setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);
  }
}

/**
 * Hides the current rich tooltip
 */
export function hideRichTooltip() {
  dismissTooltip();
}

// ============================================================
// CUSTOM ELEMENT: <ui-tooltip>
// ============================================================

class UITooltip extends HTMLElement {
  constructor() {
    super();
    this._anchor = null;
  }

  connectedCallback() {
    this._anchor = this.children[0];

    if (!this._anchor) {
      console.warn('ui-tooltip requires a child element as anchor');
      return;
    }

    const text = this.getAttribute('text');
    const position = this.getAttribute('position') || 'top';
    const caret = this.hasAttribute('caret');

    this._anchor.addEventListener('mouseenter', () => {
      showTooltip(this._anchor, text, { position, caret });
    });

    this._anchor.addEventListener('mouseleave', () => {
      hideTooltip();
    });

    this._anchor.addEventListener('focus', () => {
      showTooltip(this._anchor, text, { position, caret, delay: 0 });
    });

    this._anchor.addEventListener('blur', () => {
      hideTooltip();
    });

    this._anchor.addEventListener('touchstart', () => {
      showTooltip(this._anchor, text, { position, caret, delay: 0, autoDismiss: 1500 });
    }, { passive: true });
  }
}

customElements.define('ui-tooltip', UITooltip);

// ============================================================
// AUTO-INITIALIZATION: Data Attributes
// ============================================================

/**
 * Initializes tooltips for elements with data-tooltip attributes
 */
export function initTooltips(root = document) {
  // Plain tooltips
  root.querySelectorAll('[data-tooltip]').forEach(el => {
    const text = el.getAttribute('data-tooltip');
    const position = el.getAttribute('data-tooltip-position') || 'top';
    const caret = el.hasAttribute('data-tooltip-caret');

    const oldEnter = el._tooltipEnter;
    const oldLeave = el._tooltipLeave;
    const oldFocus = el._tooltipFocus;
    const oldBlur = el._tooltipBlur;
    const oldTouch = el._tooltipTouch;

    if (oldEnter) el.removeEventListener('mouseenter', oldEnter);
    if (oldLeave) el.removeEventListener('mouseleave', oldLeave);
    if (oldFocus) el.removeEventListener('focus', oldFocus);
    if (oldBlur) el.removeEventListener('blur', oldBlur);
    if (oldTouch) el.removeEventListener('touchstart', oldTouch);

    el._tooltipEnter = () => showTooltip(el, text, { position, caret });
    el._tooltipLeave = () => hideTooltip();
    el._tooltipFocus = () => showTooltip(el, text, { position, caret, delay: 0 });
    el._tooltipBlur = () => hideTooltip();
    el._tooltipTouch = () => showTooltip(el, text, { position, caret, delay: 0, autoDismiss: 1500 });

    el.addEventListener('mouseenter', el._tooltipEnter);
    el.addEventListener('mouseleave', el._tooltipLeave);
    el.addEventListener('focus', el._tooltipFocus);
    el.addEventListener('blur', el._tooltipBlur);
    el.addEventListener('touchstart', el._tooltipTouch, { passive: true });
  });

  // Rich tooltips
  root.querySelectorAll('[data-tooltip-title], [data-tooltip-body]').forEach(el => {
    const title = el.getAttribute('data-tooltip-title');
    const body = el.getAttribute('data-tooltip-body');
    const actionLabel = el.getAttribute('data-tooltip-action');
    const position = el.getAttribute('data-tooltip-position') || 'top';
    const caret = el.hasAttribute('data-tooltip-caret');
    const persistent = el.hasAttribute('data-tooltip-persistent');

    const content = { title, body };

    if (actionLabel) {
      content.action = {
        label: actionLabel,
        onClick: () => {
          const event = new CustomEvent('tooltip-action', { detail: { el } });
          el.dispatchEvent(event);
        },
      };
    }

    const oldEnter = el._richTooltipEnter;
    const oldLeave = el._richTooltipLeave;
    const oldClick = el._richTooltipClick;

    if (oldEnter) el.removeEventListener('mouseenter', oldEnter);
    if (oldLeave) el.removeEventListener('mouseleave', oldLeave);
    if (oldClick) el.removeEventListener('click', oldClick);

    if (persistent) {
      el._richTooltipClick = () => showRichTooltip(el, content, { position, caret, persistent: true, delay: 0 });
      el.addEventListener('click', el._richTooltipClick);
    } else {
      el._richTooltipEnter = () => showRichTooltip(el, content, { position, caret });
      el._richTooltipLeave = () => hideRichTooltip();

      el.addEventListener('mouseenter', el._richTooltipEnter);
      el.addEventListener('mouseleave', el._richTooltipLeave);
    }
  });
}

// ============================================================
// INJECT TOOLTIP STYLES INTO DOCUMENT HEAD
// ============================================================
// Tooltips are appended to document.body (light DOM), so they need
// styles injected into the document head, not just in shadow DOM.

const TOOLTIP_STYLES = `
  .ui-tooltip {
    position: fixed;
    z-index: var(--ui-z-tooltip, 10);
    background: var(--ui-tooltip-bg, rgb(24, 24, 32));
    color: var(--ui-tooltip-text, rgb(245, 245, 255));
    border-radius: var(--ui-radius-s, 8px);
    padding: var(--ui-space-1, 4px) var(--ui-space-2, 8px);
    font-size: var(--ui-font-s, 0.86rem);
    font-weight: var(--ui-font-weight-m, 400);
    line-height: var(--ui-font-line-height-s, 1.2);
    pointer-events: none;
    white-space: nowrap;
    max-width: 200px;
    box-shadow: var(--ui-shadow-2, 0 2px 8px rgba(0, 0, 0, 0.14));
    font-family: var(--ha-font-family, system-ui, sans-serif);
    -webkit-font-smoothing: antialiased;
    transition: opacity var(--ui-motion-fast, 120ms cubic-bezier(0.2, 0, 0.2, 1)),
                transform var(--ui-motion-fast, 120ms cubic-bezier(0.2, 0, 0.2, 1));
    opacity: 0;
    transform: translateY(4px) scale(0.96);
  }

  .ui-tooltip--visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .ui-tooltip--rich {
    background: var(--ui-rich-tooltip-bg, var(--ui-elevated-3, rgb(214, 214, 225)));
    color: var(--ui-rich-tooltip-text, var(--ui-text, rgb(48, 50, 60)));
    border-radius: var(--ui-radius-l, 18px);
    padding: var(--ui-space-3, 12px) var(--ui-space-4, 16px);
    white-space: normal;
    max-width: 320px;
    pointer-events: auto;
    cursor: auto;
    box-shadow: var(--ui-shadow-3, 0 4px 12px rgba(0, 0, 0, 0.18));
  }

  .ui-tooltip__title {
    font-size: var(--ui-font-m, 1rem);
    font-weight: var(--ui-font-weight-l, 500);
    margin-bottom: var(--ui-space-2, 8px);
    color: var(--ui-rich-tooltip-text, var(--ui-text, rgb(48, 50, 60)));
  }

  .ui-tooltip__body {
    font-size: var(--ui-font-s, 0.86rem);
    line-height: var(--ui-font-line-height-m, 1.4);
    color: var(--ui-text-mute, rgb(92, 94, 106));
    word-wrap: break-word;
  }

  .ui-tooltip__actions {
    margin-top: var(--ui-space-3, 12px);
    padding-top: var(--ui-space-3, 12px);
    border-top: 1px solid var(--ui-border-color-light, rgba(48, 50, 60, 0.06));
  }

  .ui-tooltip__link {
    background: none;
    border: none;
    font-size: var(--ui-font-s, 0.86rem);
    font-weight: var(--ui-font-weight-l, 500);
    cursor: pointer;
    padding: var(--ui-space-1, 4px) 0;
    color: var(--ui-accent, rgb(0, 104, 128));
    transition: opacity var(--ui-motion-fast, 120ms cubic-bezier(0.2, 0, 0.2, 1));
  }

  .ui-tooltip__link:hover {
    opacity: 0.8;
  }

  /* Tooltip Carets */
  .ui-tooltip__caret {
    position: absolute;
    width: 0;
    height: 0;
    border: 6px solid transparent;
  }

  .ui-tooltip__caret--top {
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    border-bottom-color: var(--ui-tooltip-bg, rgb(24, 24, 32));
  }

  .ui-tooltip__caret--bottom {
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border-top-color: var(--ui-tooltip-bg, rgb(24, 24, 32));
  }

  .ui-tooltip__caret--left {
    right: 100%;
    top: 50%;
    transform: translateY(-50%);
    border-right-color: var(--ui-tooltip-bg, rgb(24, 24, 32));
  }

  .ui-tooltip__caret--right {
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    border-left-color: var(--ui-tooltip-bg, rgb(24, 24, 32));
  }

  /* Rich tooltip caret colors */
  .ui-tooltip--rich .ui-tooltip__caret--top {
    border-bottom-color: var(--ui-rich-tooltip-bg, var(--ui-elevated-3, rgb(214, 214, 225)));
  }

  .ui-tooltip--rich .ui-tooltip__caret--bottom {
    border-top-color: var(--ui-rich-tooltip-bg, var(--ui-elevated-3, rgb(214, 214, 225)));
  }

  .ui-tooltip--rich .ui-tooltip__caret--left {
    border-right-color: var(--ui-rich-tooltip-bg, var(--ui-elevated-3, rgb(214, 214, 225)));
  }

  .ui-tooltip--rich .ui-tooltip__caret--right {
    border-left-color: var(--ui-rich-tooltip-bg, var(--ui-elevated-3, rgb(214, 214, 225)));
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .ui-tooltip {
      transition: none;
    }
  }

  /* Dark mode support */
  @media (prefers-color-scheme: dark) {
    .ui-tooltip {
      --ui-tooltip-bg: rgb(10, 10, 16);
      --ui-tooltip-text: rgb(228, 228, 242);
    }
    .ui-tooltip--rich {
      --ui-rich-tooltip-bg: rgb(56, 60, 72);
      --ui-rich-tooltip-text: rgb(228, 228, 242);
    }
    .ui-tooltip__body {
      --ui-text-mute: rgb(145, 147, 159);
    }
    .ui-tooltip__actions {
      --ui-border-color-light: rgba(228, 228, 242, 0.10);
    }
    .ui-tooltip__link {
      --ui-accent: rgb(30, 171, 208);
    }
  }
`;

function injectTooltipStyles() {
  if (document.getElementById('ui-tooltip-styles')) return;

  const styleEl = document.createElement('style');
  styleEl.id = 'ui-tooltip-styles';
  styleEl.textContent = TOOLTIP_STYLES;
  document.head.appendChild(styleEl);
}

// Auto-initialize on load
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectTooltipStyles();
      initTooltips();
    });
  } else {
    injectTooltipStyles();
    initTooltips();
  }
}

// ============================================================
// EXPORT STYLESHEET (for compatibility)
// ============================================================

// Empty stylesheet for compatibility with existing imports
// All styles now come from components.js CSS classes
export const uiTooltips = new CSSStyleSheet();
uiTooltips.replaceSync('/* Tooltip styles are in components.js */');
