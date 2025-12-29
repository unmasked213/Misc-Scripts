/* ========================================================================
 *  SHARED UI FOUNDATION v1.0
 * ========================================================================
 *
 *  Token-driven foundation for Home Assistant custom cards.
 *  Migrated to v1 token system with fixed elevation tiers.
 *
 *  CHANGES FROM v0:
 *  - Replaced color-mix elevation with fixed --ui-elevated-* tokens
 *  - Replaced color-mix state layers with fixed --ui-state-* tokens
 *  - Added theme classes (.light-theme and .dark-theme)
 *  - Aligned all token names with v1 specification
 *  - Added missing spacing tokens (--ui-space-7 through --ui-space-10)
 *  - Fixed menu padding to use separate X/Y tokens
 *  - Removed danger variant (not in v1 spec)
 *
 * ======================================================================== */

const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  /* ── RESET ──────────────────────────────────────────────────────────────── */
  *,
  *::before,
  *::after {
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
  }

  :focus-visible {
    outline-offset: 2px;
  }

  :focus:not(:focus-visible) {
    outline: none;
  }

  svg {
    shape-rendering: geometricPrecision;
  }

  :host {
    all: initial;
    display: block;
    font-family: var(--ha-font-family, system-ui, sans-serif);
    line-height: 1.45;
    color: var(--ui-text);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    font-kerning: normal;
  }

  /* ── ROOT TOKENS ────────────────────────────────────────────────────────── */
  :host {

    /* -- SPACING SCALE ------------------------------------------------- */
    --ui-space-1: 4px;
    --ui-space-2: 8px;
    --ui-space-3: 12px;
    --ui-space-4: 16px;
    --ui-space-5: 20px;
    --ui-space-6: 24px;
    --ui-space-7: 28px;
    --ui-space-8: 32px;
    --ui-space-9: 40px;
    --ui-space-10: 48px;


    /* -- RADII --------------------------------------------------------- */
    --ui-radius-s: 8px;
    --ui-radius-m: 12px;
    --ui-radius-l: 18px;
    --ui-radius-xl: 32px;
    --ui-radius-pill: 999px;


    /* -- BORDER WIDTHS ------------------------------------------------- */
    --ui-border-width-s: 1px;
    --ui-border-width-m: 2px;
    --ui-border-width-l: 3px;
    --ui-border-style: solid;


    /* -- TYPOGRAPHY ---------------------------------------------------- */
    --ui-font-xs: 0.75rem;      /* 12px */
    --ui-font-s: 0.86rem;       /* ~14px */
    --ui-font-m: 1rem;          /* 16px base */
    --ui-font-l: 1.15rem;       /* ~18px */
    --ui-font-xl: 1.32rem;      /* ~21px */

    /* Weights */
    --ui-font-weight-s: 300;
    --ui-font-weight-m: 400;
    --ui-font-weight-l: 500;

    /* Line heights */
    --ui-font-line-height-s: 1.2;
    --ui-font-line-height-m: 1.4;
    --ui-font-line-height-l: 1.6;

    /* Letter spacing */
    --ui-font-letter-spacing-s: 0.8px;
    --ui-font-letter-spacing-m: 0.5px;
    --ui-font-letter-spacing-l: 0.2px;


    /* -- MOTION -------------------------------------------------------- */
    --ui-motion-fast: 120ms cubic-bezier(0.2, 0, 0.2, 1);
    --ui-motion-med: 240ms cubic-bezier(0.2, 0, 0.2, 1);
    --ui-motion-slow: 360ms cubic-bezier(0.2, 0, 0.2, 1);
    --ui-switch-motion: 350ms cubic-bezier(0.34, 1.56, 0.64, 1);
    --ui-switch-secondary-motion: 250ms ease-out;


    /* -- ANIMATION PRIMITIVES ------------------------------------------ */
    --ui-anim-translate: 6px;
    --ui-anim-scale: 0.96;


    /* -- Z-INDEX SCALE ------------------------------------------------- */
    --ui-z-base: 0;
    --ui-z-tooltip: 10;
    --ui-z-menu: 20;
    --ui-z-dialog: 30;
    --ui-z-toast: 40;
    --ui-z-max: 50;


    /* -- LAYOUTS ------------------------------------------------------- */
    --ui-layout-card-padding: var(--ui-space-4);
    --ui-layout-section-gap: var(--ui-space-4);
    --ui-layout-row-gap: var(--ui-space-3);
    --ui-layout-col-gap: var(--ui-space-3);
    --ui-layout-header-padding: var(--ui-space-3);
    --ui-layout-footer-padding: var(--ui-space-3);


    /* -- INPUT FIELDS -------------------------------------------------- */
    --ui-input-height: 50px;
    --ui-input-padding-x: var(--ui-space-4);
    --ui-input-padding-y: var(--ui-space-2);


    /* -- SWITCHES / TOGGLES -------------------------------------------- */
    --ui-switch-track-width: 48px;
    --ui-switch-track-height: 32px;
    --ui-switch-track-radius: 16px;
    --ui-switch-outline-width: 2px;
    --ui-switch-thumb-size-off: 16px;
    --ui-switch-thumb-size-on: 24px;
    --ui-switch-thumb-radius: 50%;
    --ui-switch-gap: var(--ui-space-2);
    --ui-switch-touch-target: 48px;


    /* -- SLIDERS ------------------------------------------------------- */
    --ui-slider-track-height: 24px;
    --ui-slider-track-radius: 12px;
    --ui-slider-thumb-height: 44px;
    --ui-slider-thumb-width-rest: 6px;
    --ui-slider-thumb-width-pressed: 4px;
    --ui-slider-thumb-radius: 4px;
    --ui-slider-gap-rest: 4px;
    --ui-slider-gap-pressed: 3px;
    --ui-slider-motion-duration: 200ms;
    --ui-slider-motion-easing: cubic-bezier(0.4, 0, 0.2, 1);
    --ui-slider-container-height: 48px;
    --ui-slider-vertical-height: 300px;
    --ui-slider-value-size: 36px;
    --ui-slider-value-offset-y: 12px;
    --ui-slider-value-offset-x: 8px;


    /* -- SPINNERS ------------------------------------------------------ */
    --ui-spinner-color: rgb(255, 46, 146);


    /* -- CHIPS / TAGS -------------------------------------------------- */
    --ui-chip-height: 32px;
    --ui-chip-radius: var(--ui-radius-pill);
    --ui-chip-padding-x: var(--ui-space-3);
    --ui-chip-padding-y: 0;
    --ui-chip-gap: var(--ui-space-2);
    --ui-chip-font-size: var(--ui-font-s);


    /* -- TOASTS -------------------------------------------------------- */
    --ui-toast-radius: var(--ui-radius-m);
    --ui-toast-padding-x: var(--ui-space-4);
    --ui-toast-padding-y: var(--ui-space-3);
    --ui-toast-gap: var(--ui-space-2);
    --ui-toast-duration-in: 180ms;
    --ui-toast-duration-out: 150ms;


    /* -- MODALS -------------------------------------------------------- */
    --ui-modal-radius: var(--ui-radius-l);
    --ui-modal-padding: var(--ui-space-5);
    --ui-modal-max-width-s: 480px;
    --ui-modal-max-width-m: 720px;
    --ui-modal-max-width-l: 960px;
    --ui-modal-header-gap: var(--ui-space-3);
    --ui-modal-footer-gap: var(--ui-space-3);


    /* -- FAB BUTTONS --------------------------------------------------- */
    --ui-fab-size: 60px;
    --ui-fab-radius: 50%;


    /* -- SPLIT BUTTONS ------------------------------------------------- */
    --ui-split-height: 40px;
    --ui-split-gap: 2px;
    --ui-split-radius-outer: 20px;
    --ui-split-radius-inner: 3px;


    /* -- BADGES -------------------------------------------------------- */
    --ui-badge-size: 20px;
    --ui-badge-font-size: 11px;
    --ui-badge-offset-x: -6px;
    --ui-badge-offset-y: -6px;


    /* -- PROGRESS BARS ------------------------------------------------- */
    --ui-progress-height: 4px;
    --ui-progress-radius: 999px;


    /* -- CHECKBOXES / RADIOS ------------------------------------------- */
    --ui-control-size: 18px;
    --ui-control-border-width: 2px;
    --ui-control-border-radius: 6px;
    --ui-control-checked-icon-size: 12px;


    /* -- SCROLLBARS ---------------------------------------------------- */
    --ui-scrollbar-width: 6px;


    /* -- ICON SIZES ---------------------------------------------------- */
    --ui-icon-xs: 14px;
    --ui-icon-s: 18px;
    --ui-icon-m: 20px;
    --ui-icon-l: 24px;


    /* -- MENUS --------------------------------------------------------- */
    --ui-menu-radius: var(--ui-radius-xl);
    --ui-menu-padding-x: var(--ui-space-3);
    --ui-menu-padding-y: var(--ui-space-2);
    --ui-menu-min-width: 200px;
    --ui-menu-max-width: 320px;
    --ui-menu-max-height: 320px;
    --ui-menu-item-height: 50px;
    --ui-menu-item-radius: var(--ui-radius-xl);
    --ui-menu-item-padding-x: var(--ui-space-4);
    --ui-menu-item-font-size: var(--ui-font-m);
    --ui-menu-offset: 4px;


    /* -- TOOLTIPS ------------------------------------------------------ */
    --ui-tooltip-radius: var(--ui-radius-s);
    --ui-tooltip-padding-x: var(--ui-space-2);
    --ui-tooltip-padding-y: var(--ui-space-1);
    --ui-tooltip-max-width: 220px;
    --ui-tooltip-gap: var(--ui-space-2);
    --ui-tooltip-delay-show: 400ms;
    --ui-tooltip-delay-hide: 100ms;
    --ui-tooltip-duration: 1500ms;

    --ui-rich-tooltip-radius: var(--ui-radius-l);
    --ui-rich-tooltip-padding-x: var(--ui-space-4);
    --ui-rich-tooltip-padding-y: var(--ui-space-3);
    --ui-rich-tooltip-max-width: 320px;
    --ui-rich-tooltip-title-size: var(--ui-font-m);
    --ui-rich-tooltip-body-size: var(--ui-font-s);


    /* -- STATE LAYERS -------------------------------------------------- */
    --ui-state-disabled-opacity: 0.4;


    /* -- OVERLAY / SCRIM / OPACITY ------------------------------------- */
    --ui-overlay-blur: 12px;


    /* -- LIST ROWS ----------------------------------------------------- */
    --ui-listrow-height: 48px;
    --ui-listrow-padding-x: var(--ui-space-4);
    --ui-listrow-padding-y: var(--ui-space-2);
    --ui-listrow-gap: var(--ui-space-3);
    --ui-listrow-label-min-width: 140px;


    /* -- SECTION HEADERS ----------------------------------------------- */
    --ui-section-header-padding-y: var(--ui-space-3);
    --ui-section-header-gap: var(--ui-space-1);
    --ui-section-header-title-size: var(--ui-font-m);
    --ui-section-header-subtitle-size: var(--ui-font-s);


    /* -- EMPTY STATES -------------------------------------------------- */
    --ui-emptystate-icon-size: 48px;
    --ui-emptystate-text-size: var(--ui-font-m);
    --ui-emptystate-padding-y: var(--ui-space-6);
    --ui-emptystate-gap: var(--ui-space-3);
    --ui-emptystate-max-width: 360px;


    /* -- BASE COLORS (FALLBACK TO HA THEME) ---------------------------- */
    --ui-surface: var(--ha-card-background, var(--card-background-color));
    --ui-surface-alt: var(--secondary-background-color);
    --ui-text: var(--primary-text-color);
    --ui-text-mute: var(--secondary-text-color);
    --ui-accent: var(--primary-color);
  }


  /* ── LIGHT THEME (DEFAULT) ───────────────────────────────────────────────── */
  :host {

    /* -- BASE SURFACES ------------------------------------------------- */
    --ui-surface: rgb(243, 243, 255);
    --ui-surface-alt: rgb(236, 236, 248);
    --ui-surface-alt-2: rgb(226, 226, 238);


    /* -- TEXT ROLES ---------------------------------------------------- */
    --ui-text: rgb(48, 50, 60);
    --ui-text-mute: rgb(92, 94, 106);
    --ui-text-strong: rgb(28, 30, 40);


    /* -- ACCENT -------------------------------------------------------- */
    --ui-accent: var(--primary-color, rgb(0, 104, 128));
    --ui-accent-soft: rgba(0, 104, 128, 0.32);
    --ui-accent-faint: rgba(0, 104, 128, 0.16);


    /* -- SEMANTIC ROLES ------------------------------------------------ */
    --ui-success: var(--success-color, rgb(0, 162, 103));
    --ui-success-soft: rgba(0, 162, 103, 0.32);
    --ui-success-faint: rgba(0, 162, 103, 0.16);

    --ui-warning: var(--warning-color, rgb(232, 177, 0));
    --ui-warning-soft: rgba(232, 177, 0, 0.32);
    --ui-warning-faint: rgba(232, 177, 0, 0.16);

    --ui-error: var(--error-color, rgb(187, 27, 27));
    --ui-error-soft: rgba(187, 27, 27, 0.32);
    --ui-error-faint: rgba(187, 27, 27, 0.16);

    --ui-info: var(--info-color, rgb(0, 158, 211));
    --ui-info-soft: rgba(0, 158, 211, 0.32);
    --ui-info-faint: rgba(0, 158, 211, 0.16);

    --ui-text-on-accent: rgb(241, 250, 255);
    --ui-text-on-danger: rgb(255, 247, 246);


    /* -- ELEVATION TIERS ----------------------------------------------- */
    --ui-elevated-0: rgb(243, 243, 255);
    --ui-elevated-1: rgb(236, 236, 248);
    --ui-elevated-2: rgb(226, 226, 238);
    --ui-elevated-3: rgb(214, 214, 225);
    --ui-elevated-4: rgb(196, 196, 208);


    /* -- SHADOWS ------------------------------------------------------- */
    --ui-shadow-0: none;
    --ui-shadow-1: 0 1px 3px rgba(0, 0, 0, 0.10);
    --ui-shadow-2: 0 2px 8px rgba(0, 0, 0, 0.14);
    --ui-shadow-3: 0 4px 12px rgba(0, 0, 0, 0.18);
    --ui-shadow-4: 0 6px 18px rgba(0, 0, 0, 0.22);


    /* -- STATE LAYERS -------------------------------------------------- */
    --ui-state-hover: rgba(48, 50, 60, 0.06);
    --ui-state-pressed: rgba(48, 50, 60, 0.12);
    --ui-state-active: rgba(48, 50, 60, 0.16);
    --ui-state-focus-ring: rgba(0, 104, 128, 0.50);


    /* -- BORDER COLORS ------------------------------------------------- */
    --ui-border-color-light: rgba(48, 50, 60, 0.06);
    --ui-border-color-med: rgba(48, 50, 60, 0.16);
    --ui-border-color-strong: rgba(48, 50, 60, 0.28);


    /* -- OVERLAY / SCRIM ----------------------------------------------- */
    --ui-overlay-scrim: rgba(0, 0, 0, 0.40);
    --ui-overlay-scrim-strong: rgba(0, 0, 0, 0.60);
    --ui-overlay-transparent: rgba(0, 0, 0, 0.0);


    /* -- INPUT FIELDS -------------------------------------------------- */
    --ui-input-bg: rgb(236, 236, 248);


    /* -- SWITCHES / TOGGLES -------------------------------------------- */
    --ui-switch-track-off: rgb(236, 236, 248);
    --ui-switch-track-on: var(--ui-accent);
    --ui-switch-outline-off: rgba(48, 50, 60, 0.22);
    --ui-switch-outline-on: var(--ui-accent);
    --ui-switch-outline: var(--ui-switch-outline-off);
    --ui-switch-thumb-off: rgb(92, 94, 106);
    --ui-switch-thumb-on: rgb(243, 243, 255);
    --ui-switch-icon-off: rgb(236, 236, 248);
    --ui-switch-icon-on: var(--ui-accent);


    /* -- CHIPS / TAGS -------------------------------------------------- */
    --ui-chip-bg: var(--ui-elevated-1);
    --ui-chip-selected-bg: var(--ui-accent-soft);
    --ui-chip-selected-text: var(--ui-text-strong);


    /* -- MENUS --------------------------------------------------------- */
    --ui-menu-item-color: var(--ui-text);
    --ui-menu-item-hover-bg: rgba(48, 50, 60, 0.06);
    --ui-menu-item-selected-bg: var(--ui-accent);
    --ui-menu-item-selected-color: var(--ui-text-on-accent);


    /* -- TOOLTIPS ------------------------------------------------------ */
    --ui-tooltip-bg: rgb(24, 24, 32);
    --ui-tooltip-text: rgb(245, 245, 255);
    --ui-rich-tooltip-bg: var(--ui-elevated-3);
    --ui-rich-tooltip-text: var(--ui-text);


    /* -- TOASTS -------------------------------------------------------- */
    --ui-toast-bg: var(--ui-elevated-4);
    --ui-toast-text: var(--ui-text);


    /* -- FAB BUTTONS --------------------------------------------------- */
    --ui-fab-bg: var(--ui-accent);
    --ui-fab-hover-bg: rgb(102, 122, 240);
    --ui-fab-active-bg: rgb(92, 112, 230);
    --ui-fab-shadow: var(--ui-shadow-3);


    /* -- BADGES -------------------------------------------------------- */
    --ui-badge-bg: rgb(244, 67, 54);
    --ui-badge-text: rgb(255, 255, 255);


    /* -- PROGRESS BARS ------------------------------------------------- */
    --ui-progress-track: rgba(48, 50, 60, 0.14);
    --ui-progress-fill: var(--ui-accent);


    /* -- CHECKBOXES / RADIOS ------------------------------------------- */
    --ui-control-bg: var(--ui-surface);
    --ui-control-checked-bg: var(--ui-accent);


    /* -- SCROLLBARS ---------------------------------------------------- */
    --ui-scrollbar-track: rgba(48, 50, 60, 0.06);
    --ui-scrollbar-thumb: rgba(48, 50, 60, 0.26);


    /* -- EMPTY STATES -------------------------------------------------- */
    --ui-emptystate-text: var(--ui-text);
    --ui-emptystate-subtext: var(--ui-text-mute);
  }


  /* ── DARK THEME (MEDIA QUERY) ────────────────────────────────────────────── */
  @media (prefers-color-scheme: dark) {
    :host {

      /* -- BASE SURFACES ------------------------------------------------- */
      --ui-surface: rgb(11, 14, 23);
      --ui-surface-alt: rgb(24, 28, 38);
      --ui-surface-alt-2: rgb(32, 36, 48);


    /* -- TEXT ROLES ---------------------------------------------------- */
    --ui-text: rgb(228, 228, 242);
    --ui-text-mute: rgb(145, 147, 159);
    --ui-text-strong: rgb(240, 240, 252);


    /* -- ACCENT -------------------------------------------------------- */
    --ui-accent: var(--primary-color, rgb(30, 171, 208));
    --ui-accent-soft: rgba(30, 171, 208, 0.32);
    --ui-accent-faint: rgba(30, 171, 208, 0.16);


    /* -- SEMANTIC ROLES ------------------------------------------------ */
    --ui-success: var(--success-color, rgb(0, 162, 103));
    --ui-success-soft: rgba(0, 162, 103, 0.32);
    --ui-success-faint: rgba(0, 162, 103, 0.16);

    --ui-warning: var(--warning-color, rgb(232, 177, 0));
    --ui-warning-soft: rgba(232, 177, 0, 0.32);
    --ui-warning-faint: rgba(232, 177, 0, 0.16);

    --ui-error: var(--error-color, rgb(255, 113, 100));
    --ui-error-soft: rgba(255, 113, 100, 0.32);
    --ui-error-faint: rgba(255, 113, 100, 0.16);

    --ui-info: var(--info-color, rgb(0, 158, 211));
    --ui-info-soft: rgba(0, 158, 211, 0.32);
    --ui-info-faint: rgba(0, 158, 211, 0.16);

    --ui-text-on-accent: rgb(0, 36, 46);
    --ui-text-on-danger: rgb(74, 0, 2);


    /* -- ELEVATION TIERS ----------------------------------------------- */
    --ui-elevated-0: rgb(11, 14, 23);
    --ui-elevated-1: rgb(17, 19, 28);
    --ui-elevated-2: rgb(40, 43, 54);
    --ui-elevated-3: rgb(56, 60, 72);
    --ui-elevated-4: rgb(74, 78, 92);


    /* -- SHADOWS ------------------------------------------------------- */
    --ui-shadow-0: none;
    --ui-shadow-1: 0 1px 3px rgba(0, 0, 0, 0.60);
    --ui-shadow-2: 0 2px 8px rgba(0, 0, 0, 0.70);
    --ui-shadow-3: 0 4px 12px rgba(0, 0, 0, 0.78);
    --ui-shadow-4: 0 6px 18px rgba(0, 0, 0, 0.86);


    /* -- STATE LAYERS -------------------------------------------------- */
    --ui-state-hover: rgba(228, 228, 242, 0.08);
    --ui-state-pressed: rgba(228, 228, 242, 0.16);
    --ui-state-active: rgba(228, 228, 242, 0.20);
    --ui-state-focus-ring: rgb(80, 210, 240);


    /* -- BORDER COLORS ------------------------------------------------- */
    --ui-border-color-light: rgba(228, 228, 242, 0.10);
    --ui-border-color-med: rgba(228, 228, 242, 0.22);
    --ui-border-color-strong: rgba(228, 228, 242, 0.34);


    /* -- OVERLAY / SCRIM ----------------------------------------------- */
    --ui-overlay-scrim: rgba(0, 0, 0, 0.55);
    --ui-overlay-scrim-strong: rgba(0, 0, 0, 0.78);
    --ui-overlay-transparent: rgba(0, 0, 0, 0.0);


    /* -- INPUT FIELDS -------------------------------------------------- */
    --ui-input-bg: rgb(28, 31, 41);


    /* -- SWITCHES / TOGGLES -------------------------------------------- */
    --ui-switch-track-off: rgb(35, 37, 47);
    --ui-switch-track-on: var(--ui-accent);
    --ui-switch-outline-off: rgb(115, 117, 129);
    --ui-switch-outline-on: var(--ui-accent);
    --ui-switch-outline: var(--ui-switch-outline-off);
    --ui-switch-thumb-off: rgb(115, 117, 129);
    --ui-switch-thumb-on: rgb(0, 36, 46);
    --ui-switch-icon-off: rgb(35, 37, 47);
    --ui-switch-icon-on: var(--ui-accent);


    /* -- CHIPS / TAGS -------------------------------------------------- */
    --ui-chip-bg: var(--ui-elevated-1);
    --ui-chip-selected-bg: var(--ui-accent-soft);
    --ui-chip-selected-text: var(--ui-text);


    /* -- MENUS --------------------------------------------------------- */
    --ui-menu-item-color: var(--ui-text);
    --ui-menu-item-hover-bg: rgba(228, 228, 242, 0.06);
    --ui-menu-item-selected-bg: var(--ui-accent);
    --ui-menu-item-selected-color: var(--ui-text-on-accent);


    /* -- TOOLTIPS ------------------------------------------------------ */
    --ui-tooltip-bg: rgb(10, 10, 16);
    --ui-tooltip-text: rgb(228, 228, 242);
    --ui-rich-tooltip-bg: var(--ui-elevated-3);
    --ui-rich-tooltip-text: var(--ui-text);


    /* -- TOASTS -------------------------------------------------------- */
    --ui-toast-bg: var(--ui-elevated-4);
    --ui-toast-text: var(--ui-text);


    /* -- FAB BUTTONS --------------------------------------------------- */
    --ui-fab-bg: var(--ui-accent);
    --ui-fab-hover-bg: rgb(120, 140, 250);
    --ui-fab-active-bg: rgb(112, 132, 240);
    --ui-fab-shadow: var(--ui-shadow-3);


    /* -- BADGES -------------------------------------------------------- */
    --ui-badge-bg: rgb(239, 83, 80);
    --ui-badge-text: rgb(10, 10, 16);


    /* -- PROGRESS BARS ------------------------------------------------- */
    --ui-progress-track: rgba(228, 228, 242, 0.18);
    --ui-progress-fill: var(--ui-accent);


    /* -- CHECKBOXES / RADIOS ------------------------------------------- */
    --ui-control-bg: var(--ui-surface);
    --ui-control-checked-bg: var(--ui-accent);


    /* -- SCROLLBARS ---------------------------------------------------- */
    --ui-scrollbar-track: rgba(228, 228, 242, 0.08);
    --ui-scrollbar-thumb: rgba(228, 228, 242, 0.30);


    /* -- EMPTY STATES -------------------------------------------------- */
    --ui-emptystate-text: var(--ui-text);
    --ui-emptystate-subtext: var(--ui-text-mute);
    }
  }


  /* ── UTILITY CLASSES ─────────────────────────────────────────────────────── */

  /* Surface container */
  .ui-surface {
    background: var(--ui-surface);
    color: var(--ui-text);
    border-radius: var(--ui-radius-m);
  }

  /* Elevated surfaces */
  .ui-surface-1 { background: var(--ui-elevated-1); }
  .ui-surface-2 { background: var(--ui-elevated-2); }
  .ui-surface-3 { background: var(--ui-elevated-3); }
  .ui-surface-4 { background: var(--ui-elevated-4); }
`);

// Export as global for backwards compatibility
window.uiFoundation = sheet;

export { sheet as sharedStyles };