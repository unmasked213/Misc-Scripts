// /config/www/cards/ui-test-tooltips.js
import "/local/base/foundation.js";
import { uiComponents } from "/local/base/components.js";
import { uiTooltips, showTooltip, hideTooltip, showRichTooltip, initTooltips } from "/local/base/tooltips.js";

class UITestTooltipsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    this.config = config || {};
    this.render();
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents, uiTooltips];
  }

  getCardSize() {
    return 3;
  }

  // ─────────────────────────────────────────────────────────────
  // Test Section Definitions
  // ─────────────────────────────────────────────────────────────

  get testSections() {
    return [
      {
        id: "plain-positions",
        title: "Plain Tooltip - Positions",
        description: "Hover over buttons to see tooltips in different positions",
        content: this.renderPlainPositions,
      },
      {
        id: "plain-caret",
        title: "Plain Tooltip - With Caret",
        description: "Tooltips with directional arrows/carets",
        content: this.renderPlainCaret,
      },
      {
        id: "plain-delay",
        title: "Plain Tooltip - Custom Delay",
        description: "Immediate show (0ms) vs default delay (400ms)",
        content: this.renderPlainDelay,
      },
      {
        id: "rich-default",
        title: "Rich Tooltip - Default Behavior",
        description: "Shows on hover, hides on mouse leave",
        content: this.renderRichDefault,
      },
      {
        id: "rich-persistent",
        title: "Rich Tooltip - Persistent",
        description: "Click to show, click outside to dismiss",
        content: this.renderRichPersistent,
      },
      {
        id: "rich-action",
        title: "Rich Tooltip - With Action",
        description: "Rich tooltip with title, body, and action button",
        content: this.renderRichAction,
      },
      {
        id: "viewport-edge",
        title: "Viewport Edge Behavior",
        description: "Tooltips automatically reposition when near viewport edges",
        content: this.renderViewportEdge,
      },
      {
        id: "disabled-element",
        title: "Disabled Element Pattern",
        description: "How to show tooltips on disabled elements (wrap in span)",
        content: this.renderDisabledElement,
      },
      {
        id: "keyboard-support",
        title: "Keyboard Accessibility",
        description: "Tooltips appear on focus for keyboard navigation",
        content: this.renderKeyboardSupport,
      },
      {
        id: "data-attributes",
        title: "Data Attribute Pattern",
        description: "Declarative tooltips using data-tooltip attributes",
        content: this.renderDataAttributes,
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────
  // Section Renderers
  // ─────────────────────────────────────────────────────────────

  renderPlainPositions() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="tooltip-top">
          Top
        </button>
        <button class="ui-btn ui-btn--accent" id="tooltip-bottom">
          Bottom
        </button>
        <button class="ui-btn ui-btn--accent" id="tooltip-left">
          Left
        </button>
        <button class="ui-btn ui-btn--accent" id="tooltip-right">
          Right
        </button>
      </div>
    `;
  }

  renderPlainCaret() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="caret-top">
          Top with caret
        </button>
        <button class="ui-btn ui-btn--accent" id="caret-bottom">
          Bottom with caret
        </button>
        <button class="ui-btn ui-btn--accent" id="caret-left">
          Left with caret
        </button>
        <button class="ui-btn ui-btn--accent" id="caret-right">
          Right with caret
        </button>
      </div>
    `;
  }

  renderPlainDelay() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="delay-immediate">
          Immediate (0ms)
        </button>
        <button class="ui-btn ui-btn--accent" id="delay-default">
          Default (400ms)
        </button>
        <button class="ui-btn ui-btn--accent" id="delay-slow">
          Slow (1000ms)
        </button>
      </div>
    `;
  }

  renderRichDefault() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="rich-simple">
          Hover me
        </button>
        <button class="ui-btn ui-btn--accent" id="rich-title-only">
          Title only
        </button>
        <button class="ui-btn ui-btn--accent" id="rich-body-only">
          Body only
        </button>
      </div>
    `;
  }

  renderRichPersistent() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="rich-persistent">
          Click me (persistent)
        </button>
        <button class="ui-btn ui-btn--accent" id="rich-persistent-caret">
          Click me (with caret)
        </button>
      </div>
    `;
  }

  renderRichAction() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="rich-action">
          With action button
        </button>
      </div>
      <div id="action-log" class="action-log"></div>
    `;
  }

  renderViewportEdge() {
    return `
      <div class="viewport-test">
        <button class="ui-btn ui-btn--accent edge-top-left" id="edge-top-left">
          Top Left
        </button>
        <button class="ui-btn ui-btn--accent edge-top-right" id="edge-top-right">
          Top Right
        </button>
        <button class="ui-btn ui-btn--accent edge-bottom-left" id="edge-bottom-left">
          Bottom Left
        </button>
        <button class="ui-btn ui-btn--accent edge-bottom-right" id="edge-bottom-right">
          Bottom Right
        </button>
      </div>
    `;
  }

  renderDisabledElement() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" disabled>
          Disabled (no tooltip)
        </button>
        <span id="disabled-wrapper" style="display: inline-block;">
          <button class="ui-btn ui-btn--accent" disabled style="pointer-events: none;">
            Disabled (with tooltip)
          </button>
        </span>
      </div>
    `;
  }

  renderKeyboardSupport() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent" id="keyboard-1">
          Tab to focus
        </button>
        <button class="ui-btn ui-btn--accent" id="keyboard-2">
          Tab to focus
        </button>
        <button class="ui-btn ui-btn--accent" id="keyboard-3">
          Tab to focus
        </button>
      </div>
      <div class="helper-text">
        Use Tab key to navigate between buttons
      </div>
    `;
  }

  renderDataAttributes() {
    return `
      <div class="test-grid">
        <button class="ui-btn ui-btn--accent"
                data-tooltip="Simple tooltip text"
                data-tooltip-position="top">
          Data attribute
        </button>
        <button class="ui-btn ui-btn--accent"
                data-tooltip="With caret"
                data-tooltip-position="bottom"
                data-tooltip-caret>
          With caret
        </button>
        <button class="ui-btn ui-btn--accent"
                data-tooltip-title="Rich Tooltip"
                data-tooltip-body="This is a rich tooltip created with data attributes">
          Rich tooltip
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
          gap: var(--ui-space-5);
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

        .test-grid {
          display: flex;
          gap: var(--ui-space-3);
          flex-wrap: wrap;
          align-items: center;
        }

        .helper-text {
          font-size: var(--ui-font-s);
          color: var(--ui-text-mute);
          font-style: italic;
          margin-top: var(--ui-space-2);
        }

        .action-log {
          margin-top: var(--ui-space-3);
          padding: var(--ui-space-3);
          background: var(--ui-surface-alt);
          border-radius: var(--ui-radius-m);
          font-size: var(--ui-font-s);
          min-height: 40px;
          color: var(--ui-text-mute);
        }

        .action-log:empty::before {
          content: "Action log will appear here...";
        }

        /* Viewport edge test layout */
        .viewport-test {
          position: relative;
          min-height: 200px;
          border: 2px dashed var(--ui-border-med);
          border-radius: var(--ui-radius-m);
          padding: var(--ui-space-2);
        }

        .edge-top-left {
          position: absolute;
          top: var(--ui-space-2);
          left: var(--ui-space-2);
        }

        .edge-top-right {
          position: absolute;
          top: var(--ui-space-2);
          right: var(--ui-space-2);
        }

        .edge-bottom-left {
          position: absolute;
          bottom: var(--ui-space-2);
          left: var(--ui-space-2);
        }

        .edge-bottom-right {
          position: absolute;
          bottom: var(--ui-space-2);
          right: var(--ui-space-2);
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

    // Plain tooltip positions
    this.attachPlainTooltip(root, 'tooltip-top', 'Tooltip positioned on top', { position: 'top' });
    this.attachPlainTooltip(root, 'tooltip-bottom', 'Tooltip positioned on bottom', { position: 'bottom' });
    this.attachPlainTooltip(root, 'tooltip-left', 'Tooltip positioned on left', { position: 'left' });
    this.attachPlainTooltip(root, 'tooltip-right', 'Tooltip positioned on right', { position: 'right' });

    // Plain tooltip with caret
    this.attachPlainTooltip(root, 'caret-top', 'Top with caret', { position: 'top', caret: true });
    this.attachPlainTooltip(root, 'caret-bottom', 'Bottom with caret', { position: 'bottom', caret: true });
    this.attachPlainTooltip(root, 'caret-left', 'Left with caret', { position: 'left', caret: true });
    this.attachPlainTooltip(root, 'caret-right', 'Right with caret', { position: 'right', caret: true });

    // Plain tooltip delays
    this.attachPlainTooltip(root, 'delay-immediate', 'Shows immediately (0ms delay)', { delay: 0 });
    this.attachPlainTooltip(root, 'delay-default', 'Default 400ms delay', { delay: 400 });
    this.attachPlainTooltip(root, 'delay-slow', 'Slow 1000ms delay', { delay: 1000 });

    // Rich tooltips - default
    this.attachRichTooltip(root, 'rich-simple', {
      title: 'Simple Rich Tooltip',
      body: 'This is a rich tooltip with both title and body text. It can contain longer descriptions.',
    });

    this.attachRichTooltip(root, 'rich-title-only', {
      title: 'Title Only',
    });

    this.attachRichTooltip(root, 'rich-body-only', {
      body: 'This rich tooltip only has body text, no title.',
    });

    // Rich tooltips - persistent
    this.attachRichTooltipPersistent(root, 'rich-persistent', {
      title: 'Persistent Tooltip',
      body: 'Click outside or press Escape to dismiss. You can interact with this tooltip.',
    });

    this.attachRichTooltipPersistent(root, 'rich-persistent-caret', {
      title: 'With Caret',
      body: 'This persistent tooltip includes a directional caret pointing to the button.',
    }, { caret: true });

    // Rich tooltip with action
    this.attachRichTooltipWithAction(root);

    // Viewport edge tests
    this.attachPlainTooltip(root, 'edge-top-left', 'Prefers bottom due to space', { position: 'top' });
    this.attachPlainTooltip(root, 'edge-top-right', 'Prefers bottom due to space', { position: 'top' });
    this.attachPlainTooltip(root, 'edge-bottom-left', 'Prefers top due to space', { position: 'bottom' });
    this.attachPlainTooltip(root, 'edge-bottom-right', 'Prefers top due to space', { position: 'bottom' });

    // Disabled element wrapper
    const disabledWrapper = root.getElementById('disabled-wrapper');
    if (disabledWrapper) {
      disabledWrapper.addEventListener('mouseenter', () => {
        showTooltip(disabledWrapper, 'Tooltip on disabled button (via wrapper)', { position: 'top' });
      });
      disabledWrapper.addEventListener('mouseleave', () => {
        hideTooltip();
      });
    }

    // Keyboard support
    this.attachPlainTooltip(root, 'keyboard-1', 'Keyboard accessible (focus/blur)', { position: 'top' });
    this.attachPlainTooltip(root, 'keyboard-2', 'Use Tab to navigate', { position: 'top' });
    this.attachPlainTooltip(root, 'keyboard-3', 'Shows on focus, hides on blur', { position: 'top' });

    // Initialize data attribute tooltips
    initTooltips(root);
  }

  attachPlainTooltip(root, id, text, options = {}) {
    const el = root.getElementById(id);
    if (!el) return;

    el.addEventListener('mouseenter', () => {
      showTooltip(el, text, options);
    });

    el.addEventListener('mouseleave', () => {
      hideTooltip();
    });

    // Keyboard support
    el.addEventListener('focus', () => {
      showTooltip(el, text, { ...options, delay: 0 });
    });

    el.addEventListener('blur', () => {
      hideTooltip();
    });
  }

  attachRichTooltip(root, id, content, options = {}) {
    const el = root.getElementById(id);
    if (!el) return;

    el.addEventListener('mouseenter', () => {
      showRichTooltip(el, content, options);
    });

    el.addEventListener('mouseleave', () => {
      hideTooltip();
    });
  }

  attachRichTooltipPersistent(root, id, content, options = {}) {
    const el = root.getElementById(id);
    if (!el) return;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showRichTooltip(el, content, { ...options, persistent: true, delay: 0 });
    });
  }

  attachRichTooltipWithAction(root) {
    const el = root.getElementById('rich-action');
    const log = root.getElementById('action-log');
    if (!el || !log) return;

    el.addEventListener('mouseenter', () => {
      showRichTooltip(el, {
        title: 'Feature Highlight',
        body: 'This tooltip demonstrates the action button pattern. Click the button below to trigger an action.',
        action: {
          label: 'Learn More',
          onClick: () => {
            const timestamp = new Date().toLocaleTimeString();
            log.innerHTML = `<strong>Action clicked at ${timestamp}</strong><br>In a real app, this would navigate or trigger a feature.`;
          },
        },
      });
      // Note: No mouseleave handler - action tooltips are persistent and dismiss on click-outside
    });
  }
}

customElements.define("ui-test-tooltips", UITestTooltipsCard);
