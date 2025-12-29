// /config/www/base/toggles.js

// ============================================================
// TOGGLE SWITCH SYSTEM
// Material Design 3 Expressive-inspired switches
// ============================================================
//
// COMPONENTS:
// - .ui-switch: Standard toggle switch (binary on/off)
// - .ui-icon-switch: Icon toggle switch (shows icon when on)
//
// USAGE PATTERNS:
//
// 1. Standard Switch:
//    <label class="ui-switch">
//      <input type="checkbox" class="ui-switch__input" />
//      <span class="ui-switch__track">
//        <span class="ui-switch__thumb"></span>
//      </span>
//      <span class="ui-switch__label">Enable Feature</span>
//    </label>
//
// 2. Icon Switch:
//    <label class="ui-icon-switch">
//      <input type="checkbox" class="ui-switch__input" checked />
//      <span class="ui-switch__track">
//        <span class="ui-switch__thumb">
//          <svg class="ui-switch__icon" viewBox="0 0 24 24" fill="currentColor">
//            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
//          </svg>
//        </span>
//      </span>
//      <span class="ui-switch__label">Dark Mode</span>
//    </label>
//
// ============================================================

export const uiToggles = new CSSStyleSheet();

uiToggles.replaceSync(`

  /* ============================================================
   * SWITCH CONTAINER (LABEL WRAPPER)
   * ============================================================ */

  .ui-switch,
  .ui-icon-switch {
    /* Layout */
    display: inline-flex;
    align-items: center;
    gap: var(--ui-switch-gap);
    position: relative;
    cursor: pointer;
    user-select: none;

    /* Ensure minimum touch target */
    min-height: var(--ui-switch-touch-target);
    padding: calc((var(--ui-switch-touch-target) - var(--ui-switch-track-height)) / 2) 0;

    /* Typography */
    font-size: var(--ui-font-m);
    color: var(--ui-text);
    -webkit-font-smoothing: antialiased;
  }

  .ui-switch--disabled,
  .ui-icon-switch--disabled {
    cursor: not-allowed;
    opacity: 0.38;
  }


  /* ============================================================
   * NATIVE CHECKBOX INPUT (VISUALLY HIDDEN)
   * ============================================================ */

  .ui-switch__input {
    /* Position absolutely for accessibility (not display: none) */
    position: absolute;
    opacity: 0;
    width: var(--ui-switch-track-width);
    height: var(--ui-switch-track-height);
    cursor: pointer;
    margin: 0;
    z-index: 1;
  }

  .ui-switch--disabled .ui-switch__input,
  .ui-icon-switch--disabled .ui-switch__input {
    cursor: not-allowed;
    pointer-events: none;
  }

  .ui-switch__input:disabled {
    cursor: not-allowed;
  }


  /* ============================================================
   * TRACK (PILL-SHAPED BACKGROUND)
   * ============================================================ */

  .ui-switch__track {
    /* Dimensions */
    position: relative;
    display: inline-block;
    width: var(--ui-switch-track-width);
    height: var(--ui-switch-track-height);
    border-radius: var(--ui-switch-track-radius);

    /* Default state (off) */
    background: var(--ui-switch-track-off);
    border: var(--ui-switch-outline-width) solid var(--ui-switch-outline);

    /* Transitions */
    transition:
      background-color var(--ui-switch-secondary-motion),
      border-color var(--ui-switch-secondary-motion);

    /* Prevent touch delay on mobile */
    -webkit-tap-highlight-color: transparent;
  }

  /* Checked state (on) */
  .ui-switch__input:checked + .ui-switch__track {
    background: var(--ui-switch-track-on);
    border-color: transparent;
  }


  /* ============================================================
   * THUMB (ROUND INDICATOR)
   * ============================================================ */

  .ui-switch__thumb {
    /* Position */
    position: absolute;
    top: 50%;
    left: 4px;
    transform: translateY(-50%) scale(0.67);

    /* Dimensions - always 24px in DOM, scale to simulate size change */
    width: var(--ui-switch-thumb-size-on);
    height: var(--ui-switch-thumb-size-on);
    border-radius: var(--ui-switch-thumb-radius);

    /* Default state (off) */
    background: var(--ui-switch-thumb-off);

    /* Transitions - smooth bounce animation with nice cubic bezier */
    transition:
      transform var(--ui-switch-motion),
      background-color var(--ui-switch-secondary-motion),
      box-shadow var(--ui-switch-secondary-motion);

    /* Subtle shadow for depth */
    box-shadow: var(--ui-shadow-1);

    /* Icon container setup */
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Checked state (on) - move right and scale to full size */
  .ui-switch__input:checked + .ui-switch__track .ui-switch__thumb {
    transform:
      translateX(calc(var(--ui-switch-track-width) - var(--ui-switch-thumb-size-on) - 8px))
      translateY(-50%)
      scale(1);
    background: var(--ui-switch-thumb-on);
  }


  /* ============================================================
   * ICON (INSIDE THUMB - ICON SWITCH VARIANT ONLY)
   * ============================================================ */

  .ui-switch__icon {
    /* Dimensions */
    width: 16px;
    height: 16px;

    /* Color */
    color: var(--ui-switch-icon-on);
    fill: currentColor;

    /* Hidden by default (off state) */
    opacity: 0;
    transform: scale(0.5);

    /* Transitions - slightly delayed to follow thumb animation */
    transition:
      opacity var(--ui-switch-secondary-motion),
      transform var(--ui-switch-secondary-motion);

    /* Prevent pointer events */
    pointer-events: none;
  }

  /* Show icon when checked */
  .ui-switch__input:checked + .ui-switch__track .ui-switch__icon {
    opacity: 1;
    transform: scale(1);
  }


  /* ============================================================
   * LABEL TEXT
   * ============================================================ */

  .ui-switch__label {
    /* Typography */
    font-size: var(--ui-font-m);
    color: var(--ui-text);
    line-height: 1.4;

    /* Allow selection for copy */
    user-select: text;
    cursor: pointer;

    /* Smooth rendering */
    -webkit-font-smoothing: antialiased;
  }

  .ui-switch--disabled .ui-switch__label,
  .ui-icon-switch--disabled .ui-switch__label {
    color: var(--ui-text-mute);
  }


  /* ============================================================
   * HOVER STATE (DESKTOP ONLY)
   * ============================================================ */

  @media (hover: hover) and (pointer: fine) {
    .ui-switch:hover:not(.ui-switch--disabled) .ui-switch__track,
    .ui-icon-switch:hover:not(.ui-icon-switch--disabled) .ui-switch__track {
      /* Subtle state layer overlay */
      box-shadow:
        0 0 0 8px var(--ui-state-hover),
        var(--ui-shadow-1);
    }

    .ui-switch:hover:not(.ui-switch--disabled) .ui-switch__thumb,
    .ui-icon-switch:hover:not(.ui-icon-switch--disabled) .ui-switch__thumb {
      box-shadow: var(--ui-shadow-2);
    }
  }


  /* ============================================================
   * FOCUS STATE (KEYBOARD NAVIGATION)
   * ============================================================ */

  .ui-switch__input:focus-visible + .ui-switch__track {
    outline: 2px solid var(--ui-state-focus-ring);
    outline-offset: 2px;
  }

  /* Remove focus on mouse click */
  .ui-switch__input:focus:not(:focus-visible) + .ui-switch__track {
    outline: none;
  }


  /* ============================================================
   * ACTIVE/PRESSED STATE
   * ============================================================ */

  .ui-switch:active:not(.ui-switch--disabled) .ui-switch__track,
  .ui-icon-switch:active:not(.ui-icon-switch--disabled) .ui-switch__track {
    /* Subtle scale down for tactile feedback */
    transform: scale(0.98);
    transition: transform var(--ui-motion-fast) ease-out;
  }


  /* ============================================================
   * DISABLED STATE
   * ============================================================ */

  .ui-switch--disabled,
  .ui-icon-switch--disabled {
    pointer-events: none;
  }

  .ui-switch--disabled .ui-switch__track,
  .ui-icon-switch--disabled .ui-switch__track {
    /* Muted appearance */
    opacity: 0.5;
    background: var(--ui-surface-alt);
    border-color: var(--ui-border-color-light);
  }

  .ui-switch--disabled .ui-switch__thumb,
  .ui-icon-switch--disabled .ui-switch__thumb {
    background: var(--ui-border-color-med);
    box-shadow: none;
  }

  .ui-switch__input:disabled + .ui-switch__track {
    opacity: 0.5;
    background: var(--ui-surface-alt);
    border-color: var(--ui-border-color-light);
  }

  .ui-switch__input:disabled + .ui-switch__track .ui-switch__thumb {
    background: var(--ui-border-color-med);
    box-shadow: none;
  }


  /* ============================================================
   * REDUCED MOTION ACCESSIBILITY
   * ============================================================ */

  @media (prefers-reduced-motion: reduce) {
    .ui-switch__thumb,
    .ui-switch__icon,
    .ui-switch__track {
      transition: none !important;
    }
  }


  /* ============================================================
   * LAYOUT VARIANTS
   * ============================================================ */

  /* Reversed layout (label on left, switch on right) */
  .ui-switch--reverse,
  .ui-icon-switch--reverse {
    flex-direction: row-reverse;
  }

  /* No label (switch only) */
  .ui-switch--no-label .ui-switch__label,
  .ui-icon-switch--no-label .ui-switch__label {
    display: none;
  }

`);
