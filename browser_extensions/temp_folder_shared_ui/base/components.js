// /config/www/base/components.js

// Shared UI Components Library v1.0
// Builds on top of foundation.js (tokens + primitives).
// Migrated to v1 token system with fixed state layers.

export const uiComponents = new CSSStyleSheet();

uiComponents.replaceSync(`

  /* ============================================================
   * COPY BUTTON
   * Extracted from prompt-manager.js with values converted to tokens
   * ============================================================ */

  .ui-copy-btn {
    background: none;
    border: none;
    width: var(--ui-space-10);
    height: var(--ui-space-10);
    border-radius: 50%;
    padding: 0;
    cursor: pointer;
    position: relative;
    transition: color var(--ui-motion-med), background var(--ui-motion-slow), transform var(--ui-motion-slow), box-shadow var(--ui-motion-slow);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .ui-copy-btn:hover {
    background-color: var(--ui-accent-faint);
  }

  .ui-copy-btn svg {
    width: 16px;
    height: 16px;
    pointer-events: none;
  }

  .ui-copy-btn--copied {
    background: var(--ui-surface);
    color: var(--ui-success);
    transform: translateY(-1px);
    box-shadow: var(--ui-shadow-3), inset 0 0 0 2px currentColor;
    transition: all var(--ui-motion-slow);
  }

  .ui-copy-btn--copied::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--ui-space-3);
    height: var(--ui-space-3);
    background: radial-gradient(circle, rgba(var(--ui-success-rgb), .35) 0%, rgba(var(--ui-success-rgb), 0) 70%);
    border-radius: 50%;
    transform: translate(-50%, -50%) scale(1);
    animation: ui-copy-pulse 600ms ease-out forwards;
    pointer-events: none;
  }

  @keyframes ui-copy-pulse {
    0% {
      opacity: .9;
      transform: translate(-50%, -50%) scale(1);
    }
    100% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(14);
    }
  }


  /* ============================================================
   * ACTION BUTTONS - BASE (Material 3 Expressive)
   * Layer-based, borderless button system with state layers
   * ============================================================ */

  .ui-btn {
    --_ui-btn-height: 40px;
    --_ui-btn-radius: var(--ui-radius-pill);
    --_ui-btn-padding-x: var(--ui-space-5);

    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--ui-space-2);

    height: var(--_ui-btn-height);
    padding: 0 var(--_ui-btn-padding-x);
    border-radius: var(--_ui-btn-radius);

    font-size: var(--ui-font-m);
    font-weight: 500;

    border: none;
    background: transparent;
    color: var(--ui-text);

    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    box-shadow: var(--ui-shadow-0);

    transition:
      background var(--ui-motion-med),
      color var(--ui-motion-med),
      box-shadow var(--ui-motion-med);
  }

  .ui-btn::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--ui-state-hover);
    opacity: 0;
    transition: opacity var(--ui-motion-fast);
    pointer-events: none;
  }

  /* Desktop hover → hover layer + elevation */
  @media (hover: hover) and (pointer: fine) {
    .ui-btn:hover:not(.ui-btn--disabled):not(:disabled)::before {
      opacity: 1;
    }

    .ui-btn:hover:not(.ui-btn--disabled):not(:disabled) {
      box-shadow: var(--ui-shadow-1);
    }
  }

  /* Active/pressed state → pressed layer + elevation */
  .ui-btn:active:not(.ui-btn--disabled):not(:disabled)::before,
  .ui-btn.active:not(.ui-btn--disabled):not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-btn:active:not(.ui-btn--disabled):not(:disabled),
  .ui-btn.active:not(.ui-btn--disabled):not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }

  .ui-btn:focus-visible {
    outline: 2px solid var(--ui-state-focus-ring);
    outline-offset: 2px;
  }

  /* Icon container */
  .ui-btn__icon {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }


  /* ============================================================
   * ACTION BUTTONS - ACCENT VARIANT
   * Borderless with accent color and state layers
   * ============================================================ */

  .ui-btn--accent {
  }

  .ui-btn--accent::before {
    background: var(--ui-accent-faint);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-btn--accent:hover:not(.ui-btn--disabled):not(:disabled)::before {
      opacity: 1;
    }

    .ui-btn--accent:hover:not(.ui-btn--disabled):not(:disabled) {
      box-shadow: var(--ui-shadow-1);
    }
  }

  .ui-btn--accent:active:not(.ui-btn--disabled):not(:disabled)::before,
  .ui-btn--accent.active:not(.ui-btn--disabled):not(:disabled)::before {
    background: var(--ui-accent-soft);
    opacity: 1;
  }

  .ui-btn--accent:active:not(.ui-btn--disabled):not(:disabled),
  .ui-btn--accent.active:not(.ui-btn--disabled):not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }

  /* Filled accent button */
  .ui-btn--accent.ui-btn--filled {
    background: var(--ui-accent);
    color: var(--ui-text-on-accent);
  }

  .ui-btn--accent.ui-btn--filled::before {
    background: var(--ui-state-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-btn--accent.ui-btn--filled:hover:not(.ui-btn--disabled):not(:disabled)::before {
      opacity: 1;
    }

    .ui-btn--accent.ui-btn--filled:hover:not(.ui-btn--disabled):not(:disabled) {
      box-shadow: var(--ui-shadow-1);
    }
  }

  .ui-btn--accent.ui-btn--filled:active:not(.ui-btn--disabled):not(:disabled)::before,
  .ui-btn--accent.ui-btn--filled.active:not(.ui-btn--disabled):not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-btn--accent.ui-btn--filled:active:not(.ui-btn--disabled):not(:disabled),
  .ui-btn--accent.ui-btn--filled.active:not(.ui-btn--disabled):not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }


  /* ============================================================
   * ACTION BUTTONS - DANGER VARIANT
   * Text-only and filled variants for destructive actions
   * ============================================================ */

  .ui-btn--danger {
    color: var(--ui-error);
  }

  .ui-btn--danger::before {
    background: var(--ui-error-faint);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-btn--danger:hover:not(.ui-btn--disabled):not(:disabled)::before {
      opacity: 1;
    }

    .ui-btn--danger:hover:not(.ui-btn--disabled):not(:disabled) {
      box-shadow: var(--ui-shadow-1);
    }
  }

  .ui-btn--danger:active:not(.ui-btn--disabled):not(:disabled)::before,
  .ui-btn--danger.active:not(.ui-btn--disabled):not(:disabled)::before {
    background: var(--ui-error-soft);
    opacity: 1;
  }

  .ui-btn--danger:active:not(.ui-btn--disabled):not(:disabled),
  .ui-btn--danger.active:not(.ui-btn--disabled):not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }

  /* Filled danger button */
  .ui-btn--danger.ui-btn--filled {
    background: var(--ui-error);
    color: var(--ui-text-on-danger);
  }

  .ui-btn--danger.ui-btn--filled::before {
    background: var(--ui-state-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-btn--danger.ui-btn--filled:hover:not(.ui-btn--disabled):not(:disabled)::before {
      opacity: 1;
    }

    .ui-btn--danger.ui-btn--filled:hover:not(.ui-btn--disabled):not(:disabled) {
      box-shadow: var(--ui-shadow-1);
    }
  }

  .ui-btn--danger.ui-btn--filled:active:not(.ui-btn--disabled):not(:disabled)::before,
  .ui-btn--danger.ui-btn--filled.active:not(.ui-btn--disabled):not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-btn--danger.ui-btn--filled:active:not(.ui-btn--disabled):not(:disabled),
  .ui-btn--danger.ui-btn--filled.active:not(.ui-btn--disabled):not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }


  /* ============================================================
   * ACTION BUTTONS - SIZE VARIANTS
   * ============================================================ */

  .ui-btn--small {
    --_ui-btn-height: 32px;
    --_ui-btn-padding-x: var(--ui-space-3);
    font-size: var(--ui-font-s);
  }

  .ui-btn--large {
    --_ui-btn-height: 48px;
    --_ui-btn-padding-x: var(--ui-space-6);
    font-size: var(--ui-font-l);
  }


  /* ============================================================
   * ACTION BUTTONS - ICON-ONLY VARIANT
   * Circular 40×40px button
   * ============================================================ */

  .ui-btn--icon {
    --_ui-btn-height: 40px;
    --_ui-btn-radius: 50%;
    width: 40px;
    padding: 0;
  }

  .ui-btn--icon.ui-btn--small {
    --_ui-btn-height: 32px;
    width: 32px;
  }

  .ui-btn--icon.ui-btn--large {
    --_ui-btn-height: 48px;
    width: 48px;
  }


  /* ============================================================
   * ACTION BUTTONS - DISABLED STATE
   * ============================================================ */

  .ui-btn--disabled,
  .ui-btn:disabled {
    cursor: not-allowed;
    pointer-events: none;
    opacity: var(--ui-state-disabled-opacity);
    box-shadow: none;
  }


  /* ============================================================
   * TOGGLE BUTTONS
   * Supports icon-only, text-only, and icon+text variants
   * Unselected state has subtle border, selected state has filled background
   * Similar visual logic to toggle switches
   * ============================================================ */

  .ui-btn.toggle-btn {
    border: 2px solid var(--ui-border-color-med);
    background: transparent;
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-btn.toggle-btn:hover:not(.ui-btn--disabled):not(:disabled):not(.is-selected)::before {
      opacity: 1;
    }

    .ui-btn.toggle-btn:hover:not(.ui-btn--disabled):not(:disabled):not(.is-selected) {
      border-color: var(--ui-border-color-strong);
      box-shadow: var(--ui-shadow-1);
    }
  }

  .ui-btn.toggle-btn:active:not(.ui-btn--disabled):not(:disabled):not(.is-selected)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-btn.toggle-btn:active:not(.ui-btn--disabled):not(:disabled):not(.is-selected) {
    box-shadow: var(--ui-shadow-1);
  }

  /* Selected state - filled like switch track */
  .ui-btn.toggle-btn.is-selected {
    background: var(--ui-accent);
    color: var(--ui-text-on-accent);
    border-color: transparent;
    box-shadow: var(--ui-shadow-1);
  }

  .ui-btn.toggle-btn.is-selected::before {
    background: var(--ui-state-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-btn.toggle-btn.is-selected:hover:not(.ui-btn--disabled):not(:disabled)::before {
      opacity: 1;
    }

    .ui-btn.toggle-btn.is-selected:hover:not(.ui-btn--disabled):not(:disabled) {
      box-shadow: var(--ui-shadow-2);
    }
  }

  .ui-btn.toggle-btn.is-selected:active:not(.ui-btn--disabled):not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-btn.toggle-btn.is-selected:active:not(.ui-btn--disabled):not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }


  /* ============================================================
   * SPLIT BUTTON (Material 3 Expressive)
   * Borderless with M3 curvature (outer 20px, seam 12px)
   * ============================================================ */

  .ui-split {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    gap: var(--ui-split-gap);
    height: var(--ui-split-height);
    background: transparent;
    cursor: pointer;
    isolation: isolate;
  }

  .ui-split__main,
  .ui-split__arrow {
    position: relative;
    border: none;
    background: var(--ui-accent);
    color: var(--ui-text-on-accent);
    font-size: var(--ui-font-m);
    font-weight: 500;
    padding: 0 var(--ui-space-4);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      background var(--ui-motion-med),
      box-shadow var(--ui-motion-med);
  }

  /* Left segment - outer left radius 20px, inner right radius 3px */
  .ui-split__main {
    padding-left: var(--ui-space-5);
    padding-right: var(--ui-space-3);
    border-top-left-radius: var(--ui-split-radius-outer);
    border-bottom-left-radius: var(--ui-split-radius-outer);
    border-top-right-radius: var(--ui-split-radius-inner);
    border-bottom-right-radius: var(--ui-split-radius-inner);
  }

  /* Right segment - outer right radius 20px, inner left radius 3px */
  .ui-split__arrow {
    padding-left: var(--ui-space-3);
    padding-right: var(--ui-space-4);
    border-top-right-radius: var(--ui-split-radius-outer);
    border-bottom-right-radius: var(--ui-split-radius-outer);
    border-top-left-radius: var(--ui-split-radius-inner);
    border-bottom-left-radius: var(--ui-split-radius-inner);
  }

  .ui-split__arrow svg {
    position: relative;
    z-index: 1;
    pointer-events: none;
  }

  /* State layers using ::before pseudo-elements */
  .ui-split__main::before,
  .ui-split__arrow::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--ui-state-hover);
    opacity: 0;
    transition: opacity var(--ui-motion-fast);
    pointer-events: none;
  }

  /* Hover state layers */
  @media (hover: hover) and (pointer: fine) {
    .ui-split__main:hover:not(:disabled)::before,
    .ui-split__arrow:hover:not(:disabled)::before {
      opacity: 1;
    }
  }

  /* Pressed state layers */
  .ui-split__main:active:not(:disabled)::before,
  .ui-split__arrow:active:not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  /* Open state */
  .ui-split--open .ui-split__arrow::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }


  /* ============================================================
   * DROPDOWN MENU
   * Elevated menu with rounded items, used with split buttons
   * ============================================================ */

  .ui-menu {
    position: absolute;
    bottom: calc(100% + var(--ui-menu-offset));
    right: 0;
    min-width: var(--ui-menu-min-width);
    max-width: var(--ui-menu-max-width);
    max-height: var(--ui-menu-max-height);
    background: var(--ui-elevated-4);
    border-radius: var(--ui-menu-radius);
    box-shadow: var(--ui-shadow-4);
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--ui-menu-padding-y) var(--ui-menu-padding-x);
    margin: 0;
    opacity: 0;
    pointer-events: none;
    transform: translateY(4px);
    transition:
      opacity var(--ui-motion-med) ease-out,
      transform var(--ui-motion-med) ease-out;
    will-change: transform, opacity;
    z-index: var(--ui-z-menu);

    /* Hide scrollbar but keep functionality */
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .ui-menu::-webkit-scrollbar {
    display: none;
  }

  .ui-menu--open {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .ui-menu__item {
    position: relative;
    width: 100%;
    height: var(--ui-menu-item-height);
    padding: 0 var(--ui-menu-item-padding-x);
    margin: 0;
    background: transparent;
    color: var(--ui-menu-item-color);
    border: none;
    display: flex;
    align-items: center;
    gap: var(--ui-space-2);
    text-align: left;
    font-size: var(--ui-menu-item-font-size);
    cursor: pointer;
    border-radius: var(--ui-menu-item-radius);
    -webkit-font-smoothing: antialiased;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      background-color var(--ui-motion-fast),
      color var(--ui-motion-fast);
  }

  .ui-menu__item::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--ui-menu-item-hover-bg);
    opacity: 0;
    transition: opacity var(--ui-motion-fast);
    pointer-events: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-menu__item:hover::before {
      opacity: 1;
    }
  }

  .ui-menu__item--selected {
    background: var(--ui-menu-item-selected-bg);
    color: var(--ui-menu-item-selected-color);
  }

  .ui-menu__item--selected::before {
    background: var(--ui-state-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-menu__item--selected:hover::before {
      opacity: 1;
    }
  }


  /* ============================================================
   * FAB (Floating Action Buttons)
   * Small (40px), Regular (56px), Extended (pill with icon+text)
   * Persistent elevation with M3 expressive behavior
   * ============================================================ */

  .ui-fab {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--ui-space-2);

    border: none;
    background: var(--ui-accent);
    color: var(--ui-text-on-accent);

    cursor: pointer;
    user-select: none;
    white-space: nowrap;

    font-size: var(--ui-font-m);
    font-weight: 500;

    transition:
      box-shadow var(--ui-motion-med),
      background var(--ui-motion-med);
  }

  .ui-fab::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--ui-state-hover);
    opacity: 0;
    transition: opacity var(--ui-motion-fast);
    pointer-events: none;
  }

  /* Small FAB - 40px circular */
  .ui-fab--small {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    box-shadow: var(--ui-shadow-3);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-fab--small:hover:not(:disabled)::before {
      opacity: 1;
    }

    .ui-fab--small:hover:not(:disabled) {
      box-shadow: var(--ui-shadow-4);
    }
  }

  .ui-fab--small:active:not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-fab--small:active:not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }

  /* Regular FAB - 56px circular */
  .ui-fab--regular {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    box-shadow: var(--ui-shadow-3);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-fab--regular:hover:not(:disabled)::before {
      opacity: 1;
    }

    .ui-fab--regular:hover:not(:disabled) {
      box-shadow: var(--ui-shadow-4);
    }
  }

  .ui-fab--regular:active:not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-fab--regular:active:not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }

  /* Extended FAB - 56px tall pill shape with icon + text */
  .ui-fab--extended {
    height: 56px;
    padding: 0 var(--ui-space-6);
    border-radius: 28px;
    box-shadow: var(--ui-shadow-3);
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-fab--extended:hover:not(:disabled)::before {
      opacity: 1;
    }

    .ui-fab--extended:hover:not(:disabled) {
      box-shadow: var(--ui-shadow-4);
    }
  }

  .ui-fab--extended:active:not(:disabled)::before {
    background: var(--ui-state-pressed);
    opacity: 1;
  }

  .ui-fab--extended:active:not(:disabled) {
    box-shadow: var(--ui-shadow-2);
  }

  .ui-fab:disabled {
    cursor: not-allowed;
    pointer-events: none;
    opacity: var(--ui-state-disabled-opacity);
  }

  .ui-fab:focus-visible {
    outline: 2px solid var(--ui-state-focus-ring);
    outline-offset: 2px;
  }


  /* ============================================================
   * LOADING SPINNER
   * Pink animated 3-dot loading indicator (svg-spinners:3-dots-move)
   * ============================================================ */

  .ui-spinner {
    color: var(--ui-spinner-color);
  }


  /* ============================================================
   * INPUT FIELD
   * Pill-shaped text input with floating label (WhatsApp style)
   * ============================================================ */

  .ui-input-wrapper {
    position: relative;
    width: 100%;
    height: var(--ui-input-height);
  }

  .ui-input-pill {
    position: relative;
    width: 100%;
    height: var(--ui-input-height);
    border-radius: var(--ui-input-height);
    border: var(--ui-border-width-l) solid transparent;
    background: var(--ui-input-bg);
    box-sizing: border-box;
    display: flex;
    align-items: center;
    transition: border-color var(--ui-motion-med);
    overflow: visible;
  }

  .ui-input-pill:focus-within {
    border-color: var(--ui-accent);
  }

  .ui-input-label {
    position: absolute;
    left: var(--ui-input-padding-x);
    top: 50%;
    transform: translateY(-50%);
    transform-origin: left center;
    background: transparent;
    font-size: var(--ui-font-m);
    font-weight: 400;
    line-height: 1.5;
    color: var(--ui-text-mute);
    pointer-events: none;
    white-space: nowrap;
    z-index: 1;
    transition:
      transform var(--ui-motion-med),
      color var(--ui-motion-med);
    -webkit-font-smoothing: antialiased;
  }

  /* Elevated state - label moves above input and shrinks */
  .ui-input-pill.has-value .ui-input-label,
  .ui-input-pill:focus-within .ui-input-label {
    transform: translateY(calc(-1 * var(--ui-input-height) * 0.85)) scale(0.75);
    color: var(--ui-text);
  }

  .ui-input-field {
    position: relative;
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    padding: var(--ui-input-padding-y) var(--ui-input-padding-x);
    font-size: var(--ui-font-m);
    font-weight: 400;
    color: var(--ui-text);
    -webkit-font-smoothing: antialiased;
    z-index: 1;
  }

  .ui-input-field::placeholder {
    color: transparent;
  }


  /* ============================================================
   * HORIZONTAL SLIDER
   * Material 3 Expressive style with carved-out thumb geometry
   * ============================================================ */

  .ui-slider {
    position: relative;
    width: 100%;
    height: var(--ui-slider-container-height);
    display: flex;
    align-items: center;
    cursor: pointer;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }

  .ui-slider__container {
    position: relative;
    width: 100%;
    height: var(--ui-slider-track-height);
    display: flex;
    align-items: center;
  }

  /* Active track (left side) */
  .ui-slider__track-active {
    position: absolute;
    left: 0;
    height: var(--ui-slider-track-height);
    background: var(--ui-accent);
    border-radius: var(--ui-slider-track-radius);
    /* Width and border-radius will be controlled by JS */
    transition:
      width var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-top-right-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-bottom-right-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing);
  }

  /* Inactive track (right side) */
  .ui-slider__track-inactive {
    position: absolute;
    right: 0;
    height: var(--ui-slider-track-height);
    background: var(--ui-border-color-med);
    border-radius: var(--ui-slider-track-radius);
    /* Width and border-radius will be controlled by JS */
    transition:
      width var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-top-left-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-bottom-left-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing);
  }

  /* Thumb */
  .ui-slider__thumb {
    position: absolute;
    height: var(--ui-slider-thumb-height);
    width: var(--ui-slider-thumb-width-rest);
    background: var(--ui-accent);
    border-radius: var(--ui-slider-thumb-radius);
    top: 50%;
    transform: translate(-50%, -50%);
    /* Left position will be controlled by JS */
    transition:
      width var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      left var(--ui-slider-motion-duration) var(--ui-slider-motion-easing);
    pointer-events: none;
  }

  /* Pressed state - thumb shrinks */
  .ui-slider--pressed .ui-slider__thumb {
    width: var(--ui-slider-thumb-width-pressed);
  }

  /* Value bubble */
  .ui-slider__value {
    position: absolute;
    bottom: calc(100% + var(--ui-slider-value-offset-y));
    left: 50%;
    transform: translate(-50%, var(--ui-slider-value-offset-x));
    background: var(--ui-elevated-3);
    color: var(--ui-text);
    width: var(--ui-slider-value-size);
    height: var(--ui-slider-value-size);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: var(--ui-font-s);
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    box-shadow: var(--ui-shadow-1);
    transition:
      opacity var(--ui-motion-slow),
      transform var(--ui-motion-slow);
  }

  .ui-slider--pressed .ui-slider__value {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  /* Hidden native input for accessibility */
  .ui-slider__input {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    z-index: 10;
    margin: 0;
  }

  .ui-slider__input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--ui-slider-container-height);
    height: var(--ui-slider-container-height);
    cursor: pointer;
  }

  .ui-slider__input::-moz-range-thumb {
    width: var(--ui-slider-container-height);
    height: var(--ui-slider-container-height);
    cursor: pointer;
    border: none;
    background: transparent;
  }


  /* ============================================================
   * VERTICAL SLIDER VARIANT
   * ============================================================ */

  .ui-slider--vertical {
    width: var(--ui-slider-container-height);
    height: var(--ui-slider-vertical-height);
    flex-direction: column;
  }

  .ui-slider--vertical .ui-slider__container {
    width: var(--ui-slider-track-height);
    height: 100%;
  }

  /* Vertical active track (bottom side) */
  .ui-slider--vertical .ui-slider__track-active {
    left: auto;
    bottom: 0;
    width: var(--ui-slider-track-height);
    height: auto;
    /* Height and border-radius will be controlled by JS */
    transition:
      height var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-top-left-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-top-right-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing);
  }

  /* Vertical inactive track (top side) */
  .ui-slider--vertical .ui-slider__track-inactive {
    right: auto;
    top: 0;
    width: var(--ui-slider-track-height);
    height: auto;
    /* Height and border-radius will be controlled by JS */
    transition:
      height var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-bottom-left-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      border-bottom-right-radius var(--ui-slider-motion-duration) var(--ui-slider-motion-easing);
  }

  /* Vertical thumb - HORIZONTAL orientation (rotated 90 degrees from regular) */
  .ui-slider--vertical .ui-slider__thumb {
    left: 50%;
    top: auto;
    width: var(--ui-slider-thumb-height);
    height: var(--ui-slider-thumb-width-rest);
    transform: translate(-50%, 50%);
    /* Bottom position will be controlled by JS */
    transition:
      height var(--ui-slider-motion-duration) var(--ui-slider-motion-easing),
      bottom var(--ui-slider-motion-duration) var(--ui-slider-motion-easing);
  }

  /* Vertical pressed state - thumb shrinks in height instead of width */
  .ui-slider--vertical.ui-slider--pressed .ui-slider__thumb {
    height: var(--ui-slider-thumb-width-pressed);
  }

  /* Vertical value bubble */
  .ui-slider--vertical .ui-slider__value {
    bottom: auto;
    left: calc(100% + var(--ui-slider-value-offset-y));
    top: 50%;
    transform: translate(var(--ui-slider-value-offset-x), -50%);
  }

  .ui-slider--vertical.ui-slider--pressed .ui-slider__value {
    transform: translate(0, -50%);
  }


  /* ============================================================
   * SLIDER STATE VARIANTS (LEGACY COMPATIBILITY)
   * ============================================================ */

  /* Legacy used state - for backwards compatibility with old code */
  .ui-slider--used .ui-slider__track-active {
    background: var(--ui-accent);
  }


  /* ============================================================
   * CIRCULAR SLIDER
   * Radial slider with SVG progress ring
   * ============================================================ */

  .ui-circle-slider {
    position: relative;
    width: var(--ui-circle-size, 90px);
    height: var(--ui-circle-size, 90px);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    cursor: pointer;
    user-select: none;
  }

  .ui-circle-slider--disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .ui-circle-slider__svg {
    position: absolute;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
    overflow: visible;
  }

  .ui-circle-slider__track {
    fill: none;
    stroke: var(--ui-border-color-light);
    stroke-width: var(--ui-circle-stroke-width, 3px);
    stroke-linecap: round;
  }

  .ui-circle-slider__fill {
    fill: none;
    stroke: var(--ui-accent);
    stroke-width: var(--ui-circle-stroke-width, 3px);
    stroke-linecap: round;
    transition: stroke-dashoffset 0.1s ease;
  }

  .ui-circle-slider__rollback {
    fill: none;
    stroke: var(--ui-error);
    stroke-width: var(--ui-circle-stroke-width, 3px);
    stroke-linecap: round;
    opacity: 0;
    transition: opacity var(--ui-motion-fast);
  }

  .ui-circle-slider__rollback.visible {
    opacity: 0.6;
  }

  .ui-circle-slider__value {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: var(--ui-space-1);
    font-size: var(--ui-font-l);
    font-weight: 600;
    color: var(--ui-text);
    pointer-events: none;
    z-index: 1;
  }

  .ui-circle-slider__value-number {
    font-size: var(--ui-font-l);
  }

  .ui-circle-slider__unit {
    font-size: var(--ui-font-xs);
    color: var(--ui-text-mute);
    font-weight: 400;
  }

  .ui-circle-slider__input {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    opacity: 0;
    cursor: pointer;
    z-index: 2;
    border-radius: 50%;
  }

  .ui-circle-slider--disabled .ui-circle-slider__input {
    cursor: not-allowed;
  }

  .ui-circle-slider__input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--ui-circle-size, 90px);
    height: var(--ui-circle-size, 90px);
    cursor: pointer;
    border-radius: 50%;
  }

  .ui-circle-slider__input::-moz-range-thumb {
    width: var(--ui-circle-size, 90px);
    height: var(--ui-circle-size, 90px);
    cursor: pointer;
    border: none;
    background: transparent;
    border-radius: 50%;
  }

  .ui-circle-slider__tooltip {
    position: absolute;
    top: calc(100% + var(--ui-space-2));
    left: 50%;
    transform: translateX(-50%) translateY(4px);
    padding: var(--ui-tooltip-padding-y) var(--ui-tooltip-padding-x);
    background: var(--ui-tooltip-bg);
    color: var(--ui-tooltip-text);
    border-radius: var(--ui-tooltip-radius);
    font-size: var(--ui-font-s);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition:
      opacity var(--ui-motion-fast),
      transform var(--ui-motion-fast);
    z-index: 10;
  }

  .ui-circle-slider__tooltip.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  .ui-circle-slider__tooltip::before {
    content: "";
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-bottom: 4px solid var(--ui-tooltip-bg);
  }

  .ui-circle-slider.active {
    transform: scale(1.05);
    transition: transform 0.15s ease;
  }


  /* ============================================================
   * LOADING ICON
   * svg-spinners:3-dots-move animated loading indicator
   * Respects currentColor for automatic theming
   * ============================================================ */

  .ui-icon-loading {
    display: inline-block;
    width: 24px;
    height: 24px;
    --svg: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='4' cy='12' r='0' fill='%23000'%3E%3Canimate fill='freeze' attributeName='r' begin='0;SVGUppsBdVN.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='0;3'/%3E%3Canimate fill='freeze' attributeName='cx' begin='SVGqCgsydxJ.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='4;12'/%3E%3Canimate fill='freeze' attributeName='cx' begin='SVG3PwDNd6F.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='12;20'/%3E%3Canimate id='SVG3V8yEdYE' fill='freeze' attributeName='r' begin='SVG6wCQhd9Q.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='3;0'/%3E%3Canimate id='SVGUppsBdVN' fill='freeze' attributeName='cx' begin='SVG3V8yEdYE.end' dur='0.001s' values='20;4'/%3E%3C/circle%3E%3Ccircle cx='4' cy='12' r='3' fill='%23000'%3E%3Canimate fill='freeze' attributeName='cx' begin='0;SVGUppsBdVN.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='4;12'/%3E%3Canimate fill='freeze' attributeName='cx' begin='SVGqCgsydxJ.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='12;20'/%3E%3Canimate id='SVG4PgJdbds' fill='freeze' attributeName='r' begin='SVG3PwDNd6F.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='3;0'/%3E%3Canimate id='SVG6wCQhd9Q' fill='freeze' attributeName='cx' begin='SVG4PgJdbds.end' dur='0.001s' values='20;4'/%3E%3Canimate fill='freeze' attributeName='r' begin='SVG6wCQhd9Q.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='0;3'/%3E%3C/circle%3E%3Ccircle cx='12' cy='12' r='3' fill='%23000'%3E%3Canimate fill='freeze' attributeName='cx' begin='0;SVGUppsBdVN.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='12;20'/%3E%3Canimate id='SVG38aCdcdI' fill='freeze' attributeName='r' begin='SVGqCgsydxJ.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='3;0'/%3E%3Canimate id='SVG3PwDNd6F' fill='freeze' attributeName='cx' begin='SVG38aCdcdI.end' dur='0.001s' values='20;4'/%3E%3Canimate fill='freeze' attributeName='r' begin='SVG3PwDNd6F.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='0;3'/%3E%3Canimate fill='freeze' attributeName='cx' begin='SVG6wCQhd9Q.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='4;12'/%3E%3C/circle%3E%3Ccircle cx='20' cy='12' r='3' fill='%23000'%3E%3Canimate id='SVGwaWzveSq' fill='freeze' attributeName='r' begin='0;SVGUppsBdVN.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='3;0'/%3E%3Canimate id='SVGqCgsydxJ' fill='freeze' attributeName='cx' begin='SVGwaWzveSq.end' dur='0.001s' values='20;4'/%3E%3Canimate fill='freeze' attributeName='r' begin='SVGqCgsydxJ.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='0;3'/%3E%3Canimate fill='freeze' attributeName='cx' begin='SVG3PwDNd6F.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='4;12'/%3E%3Canimate fill='freeze' attributeName='cx' begin='SVG6wCQhd9Q.end' calcMode='spline' dur='0.5s' keySplines='.36,.6,.31,1' values='12;20'/%3E%3C/circle%3E%3C/svg%3E");
    background-color: currentColor;
    -webkit-mask-image: var(--svg);
    mask-image: var(--svg);
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
  }


  /* ============================================================
   * COLLAPSIBLE SECTION COMPONENT
   * Clickable header that toggles visibility of content
   * ============================================================ */

  .ui-collapsible-section {
    margin-bottom: var(--ui-space-6);
  }

  /* Header (Button) */
  .ui-collapsible-section__header {
    /* Reset button styles */
    width: 100%;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;

    /* Layout */
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--ui-space-2) 0 var(--ui-space-2) 0;
    border-bottom: var(--ui-border-width-s) solid var(--ui-border-color-light);

    /* Touch target */
    min-height: 48px;

    /* Typography */
    font-weight: 600;
    font-size: var(--ui-font-s);
    text-transform: uppercase;
    letter-spacing: var(--ui-font-letter-spacing-m);
    text-align: left;

    /* Interaction */
    user-select: none;
    transition: background-color var(--ui-motion-med);
    border-radius: var(--ui-radius-s) var(--ui-radius-s) 0 0;

    /* Touch optimization */
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-collapsible-section__header:hover {
      background-color: var(--ui-state-hover);
    }
  }

  .ui-collapsible-section__header:focus-visible {
    outline: 2px solid var(--ui-state-focus-ring);
    outline-offset: 2px;
  }

  /* Title */
  .ui-collapsible-section__title {
    padding-left: var(--ui-space-6);
    flex: 1;
  }

  /* Arrow Indicator (CSS-only) */
  .ui-collapsible-section__arrow {
    width: var(--ui-space-2);
    height: var(--ui-space-2);
    margin-right: var(--ui-space-4);
    border-right: var(--ui-border-width-s) solid var(--ui-border-color-strong);
    border-bottom: var(--ui-border-width-s) solid var(--ui-border-color-strong);
    transform: rotate(45deg);
    transform-origin: center;
    transition: transform var(--ui-motion-med);
    opacity: 0.9;
  }

  .ui-collapsible-section--collapsed .ui-collapsible-section__arrow {
    transform: rotate(-45deg);
  }

  /* Content Wrapper */
  .ui-collapsible-section__content {
    overflow: hidden;
    transition: height var(--ui-motion-med);
    padding-left: var(--ui-space-6);
    padding-right: var(--ui-space-6);
    padding-top: var(--ui-space-1);
  }

  .ui-collapsible-section--collapsed .ui-collapsible-section__content {
    height: 0;
    padding-top: 0;
  }


  /* ============================================================
   * SCROLLABLE CONTAINER PATTERN
   * Standardized scrollbar styling for overflow containers
   * ============================================================ */

  .ui-scrollable {
    overflow: auto;
    scrollbar-width: thin; /* Firefox */
    scrollbar-color: var(--ui-scrollbar-thumb) transparent;
    scroll-behavior: smooth;
  }

  /* Webkit scrollbar styling (Chrome, Safari, Edge) */
  .ui-scrollable::-webkit-scrollbar {
    width: var(--ui-space-2);
    height: var(--ui-space-2);
  }

  .ui-scrollable::-webkit-scrollbar-track {
    background: transparent;
    border-radius: var(--ui-radius-s);
    margin-top: var(--ui-space-2);
    margin-bottom: var(--ui-space-2);
  }

  .ui-scrollable::-webkit-scrollbar-thumb {
    background: var(--ui-scrollbar-thumb);
    border-radius: var(--ui-radius-s);
    border: 2px solid transparent;
    background-clip: content-box;
  }

  @media (hover: hover) and (pointer: fine) {
    .ui-scrollable::-webkit-scrollbar-thumb:hover {
      background: var(--ui-scrollbar-thumb-hover);
    }
  }

  .ui-scrollable::-webkit-scrollbar-button {
    display: none;
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .ui-scrollable {
      scroll-behavior: auto;
    }
  }

  /* Variant: Vertical only */
  .ui-scrollable--vertical {
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* Variant: Horizontal only */
  .ui-scrollable--horizontal {
    overflow-x: auto;
    overflow-y: hidden;
  }

  /* Variant: Hidden scrollbar (still functional) */
  .ui-scrollable--hidden {
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  .ui-scrollable--hidden::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  /* Variant: Compact scrollbar (thinner) */
  .ui-scrollable--compact::-webkit-scrollbar {
    width: var(--ui-space-1);
    height: var(--ui-space-1);
  }

  .ui-scrollable--compact::-webkit-scrollbar-thumb {
    background: var(--ui-scrollbar-thumb);
    border-radius: var(--ui-radius-s);
    border: 1px solid transparent;
    background-clip: content-box;
  }

  /* Scrollbar corner */
  .ui-scrollable::-webkit-scrollbar-corner {
    background: transparent;
  }


  /* ============================================================
   * DATA ROW COMPONENT
   * Label-value pairs for specs displays and configuration panels
   * ============================================================ */

  .ui-data-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--ui-space-4);
    padding: var(--ui-space-2) 0;
    font-size: var(--ui-font-s);
    line-height: 1.5;
  }

  .ui-data-row__label {
    color: var(--ui-text-mute);
    flex-shrink: 0;
    min-width: 120px;
    font-weight: 500;
  }

  .ui-data-row__value {
    color: var(--ui-text);
    text-align: right;
    word-break: break-word;
    flex: 1;
  }

  /* Variant: Compact (smaller spacing) */
  .ui-data-row--compact {
    padding: var(--ui-space-1) 0;
    gap: var(--ui-space-1);
  }

  .ui-data-row--compact .ui-data-row__label {
    min-width: 100px;
  }

  /* Variant: Stacked (vertical layout) */
  .ui-data-row--stacked {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--ui-space-1);
  }

  .ui-data-row--stacked .ui-data-row__label {
    min-width: auto;
  }

  .ui-data-row--stacked .ui-data-row__value {
    text-align: left;
  }

  /* Variant: Emphasized value */
  .ui-data-row--emphasized .ui-data-row__value {
    font-weight: 600;
    color: var(--ui-text-strong);
  }

  /* Variant: Monospace value */
  .ui-data-row--mono .ui-data-row__value {
    font-family: 'SF Mono', 'Roboto Mono', 'Consolas', 'Monaco', monospace;
    font-size: calc(var(--ui-font-s) * 0.95);
    letter-spacing: -0.01em;
  }

  /* Variant: Bordered rows */
  .ui-data-row--bordered {
    border-bottom: var(--ui-border-width-s) solid var(--ui-border-color-light);
    padding-bottom: var(--ui-space-3);
    margin-bottom: var(--ui-space-3);
  }

  .ui-data-row--bordered:last-child {
    border-bottom: none;
    margin-bottom: 0;
  }

  /* Mobile responsive behavior */
  @media (max-width: 480px) {
    .ui-data-row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--ui-space-1);
    }

    .ui-data-row__label {
      min-width: auto;
    }

    .ui-data-row__value {
      text-align: left;
    }
  }

  /* ============================================================
   * CARD BASE COMPONENT
   * Standard container for custom Home Assistant cards
   * ============================================================ */

  .ui-card {
    padding: var(--ui-space-6);
    background: var(--ui-elevated-1);
    border-radius: var(--ui-radius-xl);
    position: relative;
  }

  /* Card Header with Accent Sidebar */
  .ui-card-header {
    display: flex;
    align-items: center;
    gap: var(--ui-space-3);
    margin-bottom: var(--ui-space-5);
    padding-left: var(--ui-space-2);
  }

  .ui-card-header__accent {
    width: 3px;
    height: 36px;
    background: var(--ui-accent);
    border-radius: var(--ui-radius-s);
    flex-shrink: 0;
  }

  .ui-card-header__title {
    font-size: var(--ui-font-xl);
    font-weight: 500;
    margin: 0;
    color: var(--ui-text);
    flex: 1;
  }

  /* Card Action Buttons (Top Right) */
  .ui-card-actions {
    display: flex;
    gap: var(--ui-space-2);
    position: absolute;
    top: var(--ui-space-6);
    right: var(--ui-space-6);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     TOOLTIPS
     ═══════════════════════════════════════════════════════════════════════════ */

  .ui-tooltip {
    position: fixed;
    z-index: var(--ui-z-tooltip);
    background: var(--ui-tooltip-bg);
    color: var(--ui-tooltip-text);
    border-radius: var(--ui-radius-s);
    padding: var(--ui-space-1) var(--ui-space-2);
    font-size: var(--ui-font-s);
    font-weight: var(--ui-font-weight-m);
    line-height: var(--ui-font-line-height-s);
    pointer-events: none;
    white-space: nowrap;
    max-width: 200px;
    box-shadow: var(--ui-shadow-2);
    font-family: var(--ha-font-family, system-ui, sans-serif);
    -webkit-font-smoothing: antialiased;
    transition: opacity var(--ui-motion-fast), transform var(--ui-motion-fast);
    opacity: 0;
    transform: translateY(4px) scale(0.96);
  }

  .ui-tooltip--visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .ui-tooltip--rich {
    background: var(--ui-rich-tooltip-bg);
    color: var(--ui-rich-tooltip-text);
    border-radius: var(--ui-radius-l);
    padding: var(--ui-space-3) var(--ui-space-4);
    white-space: normal;
    max-width: 320px;
    pointer-events: auto;
    cursor: auto;
    box-shadow: var(--ui-shadow-3);
  }

  .ui-tooltip__title {
    font-size: var(--ui-font-m);
    font-weight: var(--ui-font-weight-l);
    margin-bottom: var(--ui-space-2);
    color: var(--ui-rich-tooltip-text);
  }

  .ui-tooltip__body {
    font-size: var(--ui-font-s);
    line-height: var(--ui-font-line-height-m);
    color: var(--ui-text-mute);
    word-wrap: break-word;
  }

  .ui-tooltip__actions {
    margin-top: var(--ui-space-3);
    padding-top: var(--ui-space-3);
    border-top: 1px solid var(--ui-border-color-light);
  }

  .ui-tooltip__link {
    background: none;
    border: none;
    font-size: var(--ui-font-s);
    font-weight: var(--ui-font-weight-l);
    cursor: pointer;
    padding: var(--ui-space-1) 0;
    transition: opacity var(--ui-motion-fast);
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
    border-bottom-color: var(--ui-tooltip-bg);
  }

  .ui-tooltip__caret--bottom {
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border-top-color: var(--ui-tooltip-bg);
  }

  .ui-tooltip__caret--left {
    right: 100%;
    top: 50%;
    transform: translateY(-50%);
    border-right-color: var(--ui-tooltip-bg);
  }

  .ui-tooltip__caret--right {
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    border-left-color: var(--ui-tooltip-bg);
  }

  /* Rich tooltip caret colors */
  .ui-tooltip--rich .ui-tooltip__caret--top {
    border-bottom-color: var(--ui-rich-tooltip-bg);
  }

  .ui-tooltip--rich .ui-tooltip__caret--bottom {
    border-top-color: var(--ui-rich-tooltip-bg);
  }

  .ui-tooltip--rich .ui-tooltip__caret--left {
    border-right-color: var(--ui-rich-tooltip-bg);
  }

  .ui-tooltip--rich .ui-tooltip__caret--right {
    border-left-color: var(--ui-rich-tooltip-bg);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     REDUCED MOTION ACCESSIBILITY
     ═══════════════════════════════════════════════════════════════════════════ */

  @media (prefers-reduced-motion: reduce) {
    .ui-btn,
    .ui-fab,
    .ui-menu,
    .ui-menu__item,
    .ui-slider__thumb,
    .ui-slider__track,
    .ui-slider__track-active,
    .ui-slider__track-inactive,
    .ui-tooltip,
    .ui-collapsible__content,
    .ui-copy-btn,
    .ui-spinner {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }


`);


// ============================================================
// COLLAPSIBLE SECTION COMPONENT - JAVASCRIPT
// ============================================================

/**
 * Initialize collapsible sections within a given root element
 * @param {Document|ShadowRoot} root - Root element to search for sections (defaults to document)
 */
export function initCollapsibleSections(root = document) {
  const sections = root.querySelectorAll('.ui-collapsible-section');

  sections.forEach(section => {
    const sectionId = section.dataset.sectionId;
    const header = section.querySelector('.ui-collapsible-section__header');
    const content = section.querySelector('.ui-collapsible-section__content');

    if (!sectionId || !header || !content) return;

    // Check localStorage for saved state
    const savedState = localStorage.getItem(`ui-section-${sectionId}`);
    const initialState = savedState || section.dataset.initialState || 'expanded';

    // Set initial state
    if (initialState === 'collapsed') {
      section.classList.add('ui-collapsible-section--collapsed');
      content.style.height = '0px';
      header.setAttribute('aria-expanded', 'false');
    } else {
      content.style.height = 'auto';
      header.setAttribute('aria-expanded', 'true');
    }

    // Toggle handler
    header.addEventListener('click', () => {
      toggleSection(section, sectionId, header, content);
    });

    // Keyboard handler
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSection(section, sectionId, header, content);
      }
    });
  });
}

/**
 * Toggle a single section between expanded and collapsed states
 * @param {HTMLElement} section - The section container
 * @param {string} sectionId - The section ID for localStorage
 * @param {HTMLElement} header - The header button element
 * @param {HTMLElement} content - The content wrapper element
 */
function toggleSection(section, sectionId, header, content) {
  const isCollapsed = section.classList.contains('ui-collapsible-section--collapsed');

  if (isCollapsed) {
    // Expand
    section.classList.remove('ui-collapsible-section--collapsed');
    content.style.height = content.scrollHeight + 'px';
    header.setAttribute('aria-expanded', 'true');
    localStorage.setItem(`ui-section-${sectionId}`, 'expanded');

    // Reset to auto after animation completes
    setTimeout(() => {
      if (!section.classList.contains('ui-collapsible-section--collapsed')) {
        content.style.height = 'auto';
      }
    }, 240); // Match --ui-motion-med duration
  } else {
    // Collapse
    const currentHeight = content.scrollHeight;
    content.style.height = currentHeight + 'px';

    // Force reflow
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        section.classList.add('ui-collapsible-section--collapsed');
        content.style.height = '0px';
        header.setAttribute('aria-expanded', 'false');
        localStorage.setItem(`ui-section-${sectionId}`, 'collapsed');
      });
    });
  }
}

/**
 * Toggle all sections to expanded or collapsed state with staggered animation
 * @param {Document|ShadowRoot} root - Root element to search for sections
 * @param {boolean} expand - True to expand all, false to collapse all
 */
export function toggleAllSections(root, expand = true) {
  const sections = root.querySelectorAll('.ui-collapsible-section');

  sections.forEach((section, index) => {
    const sectionId = section.dataset.sectionId;
    const header = section.querySelector('.ui-collapsible-section__header');
    const content = section.querySelector('.ui-collapsible-section__content');

    if (!sectionId || !header || !content) return;

    // Stagger animations by 50ms per section
    setTimeout(() => {
      const isCollapsed = section.classList.contains('ui-collapsible-section--collapsed');

      if (expand && isCollapsed) {
        section.classList.remove('ui-collapsible-section--collapsed');
        content.style.height = content.scrollHeight + 'px';
        header.setAttribute('aria-expanded', 'true');
        localStorage.setItem(`ui-section-${sectionId}`, 'expanded');

        setTimeout(() => {
          if (!section.classList.contains('ui-collapsible-section--collapsed')) {
            content.style.height = 'auto';
          }
        }, 240);
      } else if (!expand && !isCollapsed) {
        const currentHeight = content.scrollHeight;
        content.style.height = currentHeight + 'px';

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            section.classList.add('ui-collapsible-section--collapsed');
            content.style.height = '0px';
            header.setAttribute('aria-expanded', 'false');
            localStorage.setItem(`ui-section-${sectionId}`, 'collapsed');
          });
        });
      }
    }, index * 50);
  });
}


// ============================================================
// COPY BUTTON COMPONENT - JAVASCRIPT
// Extracted from prompt-manager.js copyPrompt() method
// ============================================================

/**
 * Copies text to clipboard with fallback for older browsers
 * Extracted from prompt-manager.js lines 532-545
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - Success status
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const el = document.createElement("textarea");
      Object.assign(el, { value: text });
      Object.assign(el.style, {
        position: "fixed",
        opacity: "0",
      });
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    return true;
  } catch (err) {
    console.error("Copy failed:", err);
    return false;
  }
}

/**
 * Handles copy button click with visual feedback
 * Extracted from prompt-manager.js lines 552-577
 * @param {HTMLButtonElement} button - The copy button element
 * @param {string} text - Text to copy
 * @param {Object} options - Configuration options
 * @param {number} options.resetDelay - Milliseconds before resetting (default: 3000)
 * @param {Function} options.onSuccess - Callback on successful copy
 * @param {Function} options.onError - Callback on failed copy
 */
export async function handleCopyButton(button, text, options = {}) {
  const {
    resetDelay = 3000,
    onSuccess = () => {},
    onError = () => {},
  } = options;

  const success = await copyToClipboard(text);

  if (success) {
    const orig = button.getAttribute("aria-label") || "Copy";
    button.classList.add("ui-copy-btn--copied");
    button.setAttribute("aria-label", "Done");
    button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20,6 9,17 4,12"></polyline></svg>';

    onSuccess();

    setTimeout(() => {
      button.classList.remove("ui-copy-btn--copied");
      button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a 2 2 0 0 1-2-2V4a 2 2 0 0 1 2-2h9a 2 2 0 0 1 2 2v1"></path></svg>';
      button.setAttribute("aria-label", orig);
    }, resetDelay);
  } else {
    onError();
  }
}
