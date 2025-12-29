// /config/www/cards/ui-test-feedback.js
import "/local/base/foundation.js";
import { uiComponents } from "/local/base/components.js";

class UITestFeedbackCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {};
  }

  setConfig(config) {
    this.config = config || {};
    this.render();
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents];
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
        id: "loading-spinner",
        title: "Loaders",
        description: null,
        content: this.renderLoadingSpinner,
      },
      {
        id: "progress-bar",
        title: "Progress Bar",
        description: null,
        content: this.renderProgressBar,
      },
      {
        id: "badges",
        title: "Badges",
        description: null,
        content: this.renderBadges,
      },
      {
        id: "toast",
        title: "Toast Notifications",
        description: null,
        content: this.renderToast,
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────
  // Section Renderers
  // ─────────────────────────────────────────────────────────────

  renderLoadingSpinner() {
    return `
      <div class="test-row">
        <ha-icon icon="svg-spinners:3-dots-move" class="ui-spinner"></ha-icon>
        <button class="ui-btn ui-btn--accent" id="loadingBtn" style="border-color: rgb(255, 46, 146); pointer-events: none;">
          <ha-icon icon="svg-spinners:3-dots-move" class="ui-spinner"></ha-icon>
        </button>
        <button class="ui-btn ui-btn--accent" id="toggleLoadingBtn">Trigger Loader</button>
      </div>
    `;
  }

  renderProgressBar() {
    // Component not implemented yet
    return `
      <div class="test-row">
        <div style="font-size: var(--ui-font-s); color: var(--ui-text-mute);">
          Component not yet implemented
        </div>
      </div>
    `;
  }

  renderBadges() {
    // Component not implemented yet
    return `
      <div class="test-row">
        <div style="font-size: var(--ui-font-s); color: var(--ui-text-mute);">
          Component not yet implemented
        </div>
      </div>
    `;
  }

  renderToast() {
    // Component not implemented yet
    return `
      <div class="test-row">
        <div style="font-size: var(--ui-font-s); color: var(--ui-text-mute);">
          Component not yet implemented
        </div>
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

    this.attachLoadingToggle(root);
  }

  attachLoadingToggle(root) {
    const btn = root.querySelector("#toggleLoadingBtn");
    if (!btn) return;

    btn.onclick = () => {
      const original = btn.innerHTML;
      const originalHeight = btn.offsetHeight;
      btn.style.pointerEvents = 'none';
      btn.style.borderColor = 'rgb(255, 46, 146)';
      btn.style.background = 'transparent';
      btn.style.color = 'rgb(255, 46, 146)';
      btn.style.height = `${originalHeight}px`;
      btn.innerHTML = '<ha-icon icon="svg-spinners:3-dots-move" class="ui-spinner"></ha-icon>';

      setTimeout(() => {
        btn.style.pointerEvents = '';
        btn.style.borderColor = '';
        btn.style.background = '';
        btn.style.color = '';
        btn.style.height = '';
        btn.innerHTML = original;
      }, 3000);
    };
  }
}

customElements.define("ui-test-feedback", UITestFeedbackCard);
