// /config/www/cards/ui-test-interactions.js
import "/local/base/foundation.js";
import { uiComponents, handleCopyButton } from "/local/base/components.js";

class UITestInteractionsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      selectedOption: "Optimize",
    };
  }

  setConfig(config) {
    this.config = config || {};
    this.render();
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents];
  }

  disconnectedCallback() {
    if (this._outsideHandler) {
      window.removeEventListener("click", this._outsideHandler);
      this._outsideHandler = null;
    }
    if (this._fabOutsideHandler) {
      window.removeEventListener("click", this._fabOutsideHandler);
      this._fabOutsideHandler = null;
    }
  }

  getCardSize() {
    return 2;
  }

  // ─────────────────────────────────────────────────────────────
  // Test Section Definitions
  // ─────────────────────────────────────────────────────────────

  get testSections() {
    return [
      {
        id: "action-buttons",
        title: "Buttons",
        description: null,
        content: this.renderActionButtons,
      },
      {
        id: "button-variants",
        title: null,
        description: null,
        content: this.renderButtonVariants,
      },
      {
        id: "split-button",
        title: null,
        description: null,
        content: this.renderSplitButton,
      },
      {
        id: "copy-button",
        title: null,
        description: null,
        content: this.renderCopyButton,
      },
      {
        id: "fabs",
        title: "FABs",
        description: null,
        content: this.renderFABs,
      },
      {
        id: "toggle-buttons",
        title: "Toggle Buttons",
        description: null,
        content: this.renderToggleButtons,
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────
  // Section Renderers
  // ─────────────────────────────────────────────────────────────

  renderActionButtons() {
    return `
      <div class="test-row">
        <button class="ui-btn ui-btn--accent">Default</button>
        <button class="ui-btn ui-btn--accent ui-btn--filled">Filled</button>
        <button class="ui-btn ui-btn--danger">Danger</button>
        <button class="ui-btn ui-btn--danger ui-btn--filled">Danger (Filled)</button>
      </div>
    `;
  }

  renderButtonVariants() {
    return `
      <div class="test-row">
        <button class="ui-btn ui-btn--accent ui-btn--small">Small</button>
        <button class="ui-btn ui-btn--accent ui-btn--large">Large</button>
        <button class="ui-btn ui-btn--accent ui-btn--icon" aria-label="Icon button">
          <span class="ui-btn__icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </span>
        </button>
        <button class="ui-btn ui-btn--accent" disabled>Disabled</button>
      </div>
    `;
  }

  renderSplitButton() {
    const options = [
      { label: "Example option 1" },
      { label: "Example option 2" },
      { label: "Example option 3" },
      { label: "Example option 4" },
      { label: "Example option 5" },
    ];

    const menuItems = options
      .map((opt) => {
        const selected = this.state.selectedOption === opt.label ? " ui-menu__item--selected" : "";
        return `<button class="ui-menu__item${selected}">${opt.label}</button>`;
      })
      .join("");

    return `
      <div class="test-row">
        <div class="split-wrapper">
          <div class="ui-split" id="split">
            <button class="ui-split__main" id="split-main">${this.state.selectedOption}</button>
            <button class="ui-split__arrow" id="split-arrow" aria-label="Open menu">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
          </div>
          <div class="ui-menu" id="split-menu">${menuItems}</div>
        </div>
      </div>
    `;
  }

  renderCopyButton() {
    return `
      <div class="test-row">
        <button id="copyBtn" class="ui-copy-btn" aria-label="Copy test">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
    `;
  }

  renderFABs() {
    return `
      <div class="test-row" style="gap: var(--ui-space-5); align-items: center;">
        <button class="ui-fab ui-fab--small" aria-label="Small FAB">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button class="ui-fab ui-fab--regular" aria-label="Regular FAB">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button class="ui-fab ui-fab--extended">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Extended FAB
        </button>
        <div style="position: relative;">
          <button class="ui-fab ui-fab--regular" id="fabMenuTrigger" aria-label="FAB with menu">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="12" cy="5" r="1"></circle>
              <circle cx="12" cy="19" r="1"></circle>
            </svg>
          </button>
          <div class="fab-menu fab-menu--up" id="fabMenu">
            <button class="ui-btn ui-btn--accent">
              <span class="ui-btn__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                </svg>
              </span>
              Edit
            </button>
            <button class="ui-btn ui-btn--accent">
              <span class="ui-btn__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="8.5" cy="7" r="4"></circle>
                  <line x1="20" y1="8" x2="20" y2="14"></line>
                  <line x1="23" y1="11" x2="17" y2="11"></line>
                </svg>
              </span>
              Share
            </button>
            <button class="ui-btn ui-btn--accent">
              <span class="ui-btn__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </span>
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }

  renderToggleButtons() {
    return `
      <div class="test-row">
        <button class="ui-btn ui-btn--accent ui-btn--icon toggle-btn" data-toggle="icon1" aria-label="Toggle icon 1">
          <span class="ui-btn__icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
            </svg>
          </span>
        </button>
        <button class="ui-btn ui-btn--accent ui-btn--icon toggle-btn is-selected" data-toggle="icon2" aria-label="Toggle icon 2">
          <span class="ui-btn__icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </span>
        </button>
        <button class="ui-btn ui-btn--accent toggle-btn" data-toggle="text1">Toggle Text</button>
        <button class="ui-btn ui-btn--accent toggle-btn is-selected" data-toggle="text2">Selected</button>
        <button class="ui-btn ui-btn--accent toggle-btn" data-toggle="icontext1">
          <span class="ui-btn__icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
          </span>
          Document
        </button>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // Main Render
  // ─────────────────────────────────────────────────────────────

  render() {
    const sections = this.testSections
      .map((section) => {
        const header =
          section.title || section.description
            ? `
              <div class="section-header">
                ${section.title ? `<div class="section-title">${section.title}</div>` : ""}
                ${section.description ? `<div class="section-desc">${section.description}</div>` : ""}
              </div>
            `
            : "";
        return `
          <div class="test-section" data-section="${section.id}">
            ${header}
            ${section.content.call(this)}
          </div>
        `;
      })
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        .test-container {
          padding: var(--ui-space-4);
          display: flex;
          flex-direction: column;
          gap: var(--ui-space-4);
        }
        .test-section {
          display: flex;
          flex-direction: column;
          gap: var(--ui-space-3);
        }
        .section-header {
          display: flex;
          flex-direction: column;
          gap: var(--ui-space-1);
        }
        .section-title {
          font-size: var(--ui-font-l);
          font-weight: 600;
        }
        .section-desc {
          font-size: var(--ui-font-s);
          color: var(--ui-text-mute);
        }
        .test-row {
          display: flex;
          gap: var(--ui-space-3);
          flex-wrap: wrap;
          align-items: center;
        }
        .split-wrapper {
          position: relative;
        }
      </style>
      <div class="ui-surface test-container">${sections}</div>
    `;

    this.attachEvents();
  }

  // ─────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────

  attachEvents() {
    const root = this.shadowRoot;
    if (!root) return;

    this.attachCopyButton(root);
    this.attachSplitMenu(root);
    this.attachFABMenu(root);
    this.attachToggleButtons(root);
  }

  attachCopyButton(root) {
    const btn = root.querySelector("#copyBtn");
    if (!btn) return;

    btn.onclick = async () => {
      await handleCopyButton(btn, "Action button test", {
        onSuccess: () => console.log("Copied successfully!"),
        onError: () => console.error("Copy failed"),
      });
    };
  }

  attachSplitMenu(root) {
    const split = root.getElementById("split");
    const arrow = root.getElementById("split-arrow");
    const main = root.getElementById("split-main");
    const menu = root.getElementById("split-menu");
    if (!split || !arrow || !main || !menu) return;

    const toggleMenu = () => {
      const open = menu.classList.toggle("ui-menu--open");
      split.classList.toggle("ui-split--open", open);
    };

    const closeMenu = () => {
      menu.classList.remove("ui-menu--open");
      split.classList.remove("ui-split--open");
    };

    arrow.onclick = (e) => {
      e.stopPropagation();
      toggleMenu();
    };

    main.onclick = (e) => {
      e.stopPropagation();
      console.log("Primary split action clicked");
    };

    menu.querySelectorAll(".ui-menu__item").forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        this.state.selectedOption = item.textContent?.trim() || "Optimize";
        console.log("Menu item selected:", this.state.selectedOption);
        closeMenu();
        this.render();
      };
    });

    this._outsideHandler = (ev) => {
      const path = ev.composedPath?.() || [];
      if (!path.includes(menu) && !path.includes(split)) closeMenu();
    };
    window.addEventListener("click", this._outsideHandler);
  }

  attachFABMenu(root) {
    const trigger = root.querySelector("#fabMenuTrigger");
    const menu = root.querySelector("#fabMenu");
    if (!trigger || !menu) return;

    const toggleMenu = () => {
      menu.classList.toggle("fab-menu--open");
    };

    const closeMenu = () => {
      menu.classList.remove("fab-menu--open");
    };

    trigger.onclick = (e) => {
      e.stopPropagation();
      toggleMenu();
    };

    menu.querySelectorAll(".ui-btn").forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        console.log("FAB menu action clicked:", item.textContent?.trim());
        closeMenu();
      };
    });

    this._fabOutsideHandler = (ev) => {
      const path = ev.composedPath?.() || [];
      if (!path.includes(menu) && !path.includes(trigger)) closeMenu();
    };
    window.addEventListener("click", this._fabOutsideHandler);
  }

  attachToggleButtons(root) {
    const toggleBtns = root.querySelectorAll(".toggle-btn");
    toggleBtns.forEach((btn) => {
      btn.onclick = () => {
        btn.classList.toggle("is-selected");
        const toggleId = btn.dataset.toggle;
        console.log(`Toggle ${toggleId} is now ${btn.classList.contains("is-selected") ? "selected" : "unselected"}`);
      };
    });
  }
}

customElements.define("ui-test-interactions", UITestInteractionsCard);
