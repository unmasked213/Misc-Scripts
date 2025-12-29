// /config/www/cards/ui-test-collapsible.js
import "/local/base/foundation.js";
import { uiComponents, initCollapsibleSections, toggleAllSections } from "/local/base/components.js";

class UITestCollapsibleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    this.config = config || {};
    this.render();
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents];
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
        id: "collapsible-basic",
        title: "Basic Sections",
        description: "Simple collapsible sections with default state",
        content: this.renderBasicSections,
      },
      {
        id: "collapsible-initial-collapsed",
        title: "Initially Collapsed",
        description: "Sections that start in collapsed state",
        content: this.renderInitiallyCollapsed,
      },
      {
        id: "collapsible-toggle-all",
        title: "Toggle All",
        description: "Batch operations with staggered animation",
        content: this.renderToggleAll,
      },
      {
        id: "collapsible-persistence",
        title: "localStorage Persistence",
        description: "State persists after reload (try refreshing the page)",
        content: this.renderPersistence,
      },
      {
        id: "scrollable-pattern",
        title: "Scrollable Container Pattern",
        description: "Styled scrollbars for overflow content",
        content: this.renderScrollablePattern,
      },
      {
        id: "data-row-pattern",
        title: "Data Row Pattern",
        description: "Label-value pairs for specs displays",
        content: this.renderDataRowPattern,
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────
  // Section Renderers
  // ─────────────────────────────────────────────────────────────

  renderBasicSections() {
    return `
      <div class="ui-collapsible-section" data-section-id="basic-section-1">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">System Information</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <div class="ui-data-row">
            <span class="ui-data-row__label">OS Version</span>
            <span class="ui-data-row__value">Home Assistant 2025.12.1</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Kernel</span>
            <span class="ui-data-row__value">6.12.51</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Platform</span>
            <span class="ui-data-row__value">x86_64</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Python</span>
            <span class="ui-data-row__value">3.12.0</span>
          </div>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="basic-section-2">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Network Configuration</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <div class="ui-data-row ui-data-row--mono">
            <span class="ui-data-row__label">IP Address</span>
            <span class="ui-data-row__value">192.168.1.100</span>
          </div>
          <div class="ui-data-row ui-data-row--mono">
            <span class="ui-data-row__label">Subnet</span>
            <span class="ui-data-row__value">255.255.255.0</span>
          </div>
          <div class="ui-data-row ui-data-row--mono">
            <span class="ui-data-row__label">Gateway</span>
            <span class="ui-data-row__value">192.168.1.1</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">DNS</span>
            <span class="ui-data-row__value">8.8.8.8, 8.8.4.4</span>
          </div>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="basic-section-3">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Resource Usage</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <div class="ui-data-row">
            <span class="ui-data-row__label">CPU</span>
            <span class="ui-data-row__value">12.3%</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Memory</span>
            <span class="ui-data-row__value">2.4 GB / 16 GB</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Disk</span>
            <span class="ui-data-row__value">45.2 GB / 256 GB</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Temperature</span>
            <span class="ui-data-row__value">42°C</span>
          </div>
        </div>
      </div>
    `;
  }

  renderInitiallyCollapsed() {
    return `
      <div class="ui-collapsible-section ui-collapsible-section--collapsed"
           data-section-id="collapsed-section-1"
           data-initial-state="collapsed">
        <button class="ui-collapsible-section__header" aria-expanded="false">
          <span class="ui-collapsible-section__title">Advanced Settings</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content" style="height: 0px;">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Debug Mode: Disabled</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Logging Level: Info</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Auto Update: Enabled</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Telemetry: Disabled</p>
        </div>
      </div>

      <div class="ui-collapsible-section ui-collapsible-section--collapsed"
           data-section-id="collapsed-section-2"
           data-initial-state="collapsed">
        <button class="ui-collapsible-section__header" aria-expanded="false">
          <span class="ui-collapsible-section__title">Developer Tools</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content" style="height: 0px;">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Console Access: Available</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">API Documentation: Enabled</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Webhook Testing: Active</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Error Reporting: Full</p>
        </div>
      </div>
    `;
  }

  renderToggleAll() {
    return `
      <div style="margin-bottom: var(--ui-space-4);">
        <button class="ui-btn ui-btn--accent ui-btn--filled" id="expandAllBtn">
          Expand All
        </button>
        <button class="ui-btn ui-btn--accent" id="collapseAllBtn">
          Collapse All
        </button>
      </div>

      <div class="ui-collapsible-section" data-section-id="toggle-section-1">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Section 1</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Content for section 1</p>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="toggle-section-2">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Section 2</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Content for section 2</p>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="toggle-section-3">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Section 3</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Content for section 3</p>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="toggle-section-4">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Section 4</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Content for section 4</p>
        </div>
      </div>
    `;
  }

  renderPersistence() {
    return `
      <div style="margin-bottom: var(--ui-space-4); padding: var(--ui-space-4); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
        <p style="margin: 0; color: var(--ui-text); font-size: var(--ui-font-s);">
          Try toggling these sections, then refresh the page. Their state will be restored from localStorage.
        </p>
      </div>

      <div class="ui-collapsible-section" data-section-id="persist-section-1">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Persistent Section A</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">This section remembers if it was open or closed.</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Storage key: ui-section-persist-section-1</p>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="persist-section-2">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Persistent Section B</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">State is saved per section ID.</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Storage key: ui-section-persist-section-2</p>
        </div>
      </div>

      <div class="ui-collapsible-section" data-section-id="persist-section-3">
        <button class="ui-collapsible-section__header" aria-expanded="true">
          <span class="ui-collapsible-section__title">Persistent Section C</span>
          <span class="ui-collapsible-section__arrow"></span>
        </button>
        <div class="ui-collapsible-section__content">
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">localStorage survives page reloads.</p>
          <p style="margin: var(--ui-space-3) 0; color: var(--ui-text);">Storage key: ui-section-persist-section-3</p>
        </div>
      </div>

      <div style="margin-top: var(--ui-space-4);">
        <button class="ui-btn ui-btn--danger" id="clearStorageBtn">
          Clear localStorage
        </button>
      </div>
    `;
  }

  renderScrollablePattern() {
    return `
      <div style="margin-bottom: var(--ui-space-4); padding: var(--ui-space-4); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
        <p style="margin: 0 0 var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">
          Pure CSS pattern for styled scrollbars. Works in both light and dark themes.
        </p>
        <p style="margin: 0 0 var(--ui-space-1) 0; color: var(--ui-text-mute); font-size: var(--ui-font-xs);">
          Hover over scrollbar thumbs to see increased opacity
        </p>
        <p style="margin: 0; color: var(--ui-warning); font-size: var(--ui-font-xs);">
          Note: Webkit scrollbar styling may not work in Shadow DOM on some browsers. Test in regular DOM context if styling doesn't appear.
        </p>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--ui-space-4);">
        <!-- Vertical Scrollable -->
        <div>
          <h4 style="margin: 0 0 var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Vertical Scroll</h4>
          <div class="ui-scrollable ui-scrollable--vertical" style="
            max-height: 200px;
            padding: var(--ui-space-3);
            background: var(--ui-elevated-1);
            border-radius: var(--ui-radius-m);
          ">
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 1: Scrollable content</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 2: More content here</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 3: Keep scrolling</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 4: Even more content</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 5: Testing overflow</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 6: Scrollbar visible</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 7: Keep going</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 8: Almost there</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 9: Nearly done</p>
            <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Line 10: Last line</p>
          </div>
        </div>

        <!-- Horizontal Scrollable -->
        <div>
          <h4 style="margin: 0 0 var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Horizontal Scroll</h4>
          <div class="ui-scrollable ui-scrollable--horizontal" style="
            max-width: 200px;
            padding: var(--ui-space-3);
            background: var(--ui-elevated-1);
            border-radius: var(--ui-radius-m);
          ">
            <div style="width: 800px; white-space: nowrap; color: var(--ui-text); font-size: var(--ui-font-s);">
              This content is wider than the container and will scroll horizontally. Keep scrolling to see more text that extends beyond the visible area. More content here to make it obviously scrollable.
            </div>
          </div>
        </div>
      </div>

      <div style="margin-top: var(--ui-space-4);">
        <h4 style="margin: 0 0 var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Compact Scrollbar</h4>
        <div class="ui-scrollable ui-scrollable--compact ui-scrollable--vertical" style="
          max-height: 150px;
          padding: var(--ui-space-3);
          background: var(--ui-elevated-1);
          border-radius: var(--ui-radius-m);
        ">
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Thinner 4px scrollbar (--ui-space-1)</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">More content here</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Keep scrolling</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Even more content</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Testing overflow</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Last line</p>
        </div>
      </div>

      <div style="margin-top: var(--ui-space-4);">
        <h4 style="margin: 0 0 var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Hidden Scrollbar (Still Scrollable)</h4>
        <div class="ui-scrollable ui-scrollable--hidden ui-scrollable--vertical" style="
          max-height: 150px;
          padding: var(--ui-space-3);
          background: var(--ui-elevated-1);
          border-radius: var(--ui-radius-m);
        ">
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Scrollbar is hidden but container is still scrollable</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Try scrolling with mouse wheel</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Or keyboard arrows</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Useful for clean UIs</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Without visible scrollbars</p>
          <p style="margin: var(--ui-space-2) 0; color: var(--ui-text); font-size: var(--ui-font-s);">Last line here</p>
        </div>
      </div>
    `;
  }

  renderDataRowPattern() {
    return `
      <div style="margin-bottom: var(--ui-space-4); padding: var(--ui-space-4); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
        <p style="margin: 0; color: var(--ui-text); font-size: var(--ui-font-s);">
          CSS-only pattern for label-value pairs. Responsive on mobile (< 480px switches to stacked layout).
        </p>
      </div>

      <div style="margin-bottom: var(--ui-space-6);">
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Basic Rows</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row">
            <span class="ui-data-row__label">Operating System</span>
            <span class="ui-data-row__value">Home Assistant OS 12.1</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Core Version</span>
            <span class="ui-data-row__value">2025.12.1</span>
          </div>
          <div class="ui-data-row">
            <span class="ui-data-row__label">Supervisor</span>
            <span class="ui-data-row__value">2025.12.0</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: var(--ui-space-6);">
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Compact Variant</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row ui-data-row--compact">
            <span class="ui-data-row__label">Kernel</span>
            <span class="ui-data-row__value">6.12.51</span>
          </div>
          <div class="ui-data-row ui-data-row--compact">
            <span class="ui-data-row__label">Platform</span>
            <span class="ui-data-row__value">x86_64</span>
          </div>
          <div class="ui-data-row ui-data-row--compact">
            <span class="ui-data-row__label">Python</span>
            <span class="ui-data-row__value">3.12.0</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: var(--ui-space-6);">
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Stacked Variant (for long values)</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row ui-data-row--stacked">
            <span class="ui-data-row__label">Docker Version</span>
            <span class="ui-data-row__value">Docker version 20.10.21, build baeda1f82a10204ec33a94bddd3ba2b5a7f76ad4</span>
          </div>
          <div class="ui-data-row ui-data-row--stacked">
            <span class="ui-data-row__label">Installation Path</span>
            <span class="ui-data-row__value">/usr/local/share/home-assistant/core/homeassistant</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: var(--ui-space-6);">
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Emphasized Variant</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row ui-data-row--emphasized">
            <span class="ui-data-row__label">Status</span>
            <span class="ui-data-row__value">Online</span>
          </div>
          <div class="ui-data-row ui-data-row--emphasized">
            <span class="ui-data-row__label">Uptime</span>
            <span class="ui-data-row__value">7 days, 14 hours</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: var(--ui-space-6);">
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Monospace Variant (technical data)</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row ui-data-row--mono">
            <span class="ui-data-row__label">MAC Address</span>
            <span class="ui-data-row__value">00:1B:63:84:45:E6</span>
          </div>
          <div class="ui-data-row ui-data-row--mono">
            <span class="ui-data-row__label">IPv6</span>
            <span class="ui-data-row__value">fe80::21b:63ff:fe84:45e6</span>
          </div>
          <div class="ui-data-row ui-data-row--mono">
            <span class="ui-data-row__label">Container ID</span>
            <span class="ui-data-row__value">a1b2c3d4e5f6</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: var(--ui-space-6);">
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Bordered Variant</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row ui-data-row--bordered">
            <span class="ui-data-row__label">Total Space</span>
            <span class="ui-data-row__value">256 GB</span>
          </div>
          <div class="ui-data-row ui-data-row--bordered">
            <span class="ui-data-row__label">Used Space</span>
            <span class="ui-data-row__value">45.2 GB</span>
          </div>
          <div class="ui-data-row ui-data-row--bordered">
            <span class="ui-data-row__label">Free Space</span>
            <span class="ui-data-row__value">210.8 GB</span>
          </div>
        </div>
      </div>

      <div>
        <h4 style="margin: 0 0 var(--ui-space-3) 0; color: var(--ui-text); font-size: var(--ui-font-m);">Combined Variants</h4>
        <div style="padding: var(--ui-space-3); background: var(--ui-elevated-1); border-radius: var(--ui-radius-m);">
          <div class="ui-data-row ui-data-row--compact ui-data-row--mono">
            <span class="ui-data-row__label">API Key</span>
            <span class="ui-data-row__value">sk_live_a1b2c3d4e5f6g7h8</span>
          </div>
          <div class="ui-data-row ui-data-row--compact ui-data-row--emphasized">
            <span class="ui-data-row__label">Connection</span>
            <span class="ui-data-row__value">Secure (TLS 1.3)</span>
          </div>
          <div class="ui-data-row ui-data-row--bordered ui-data-row--emphasized">
            <span class="ui-data-row__label">License</span>
            <span class="ui-data-row__value">Active</span>
          </div>
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
          gap: var(--ui-space-6);
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
          margin-bottom: var(--ui-space-2);
        }
        .section-title {
          font-size: var(--ui-font-l);
          font-weight: 600;
          color: var(--ui-text-strong);
        }
        .section-desc {
          font-size: var(--ui-font-s);
          color: var(--ui-text-mute);
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

    // Initialize all collapsible sections
    initCollapsibleSections(root);

    // Toggle all buttons
    const expandAllBtn = root.querySelector("#expandAllBtn");
    const collapseAllBtn = root.querySelector("#collapseAllBtn");

    if (expandAllBtn) {
      expandAllBtn.addEventListener("click", () => {
        toggleAllSections(root, true);
      });
    }

    if (collapseAllBtn) {
      collapseAllBtn.addEventListener("click", () => {
        toggleAllSections(root, false);
      });
    }

    // Clear storage button
    const clearStorageBtn = root.querySelector("#clearStorageBtn");
    if (clearStorageBtn) {
      clearStorageBtn.addEventListener("click", () => {
        // Clear all ui-section-* keys from localStorage
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('ui-section-')) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));

        // Show feedback
        const originalText = clearStorageBtn.textContent;
        clearStorageBtn.textContent = "Cleared!";
        clearStorageBtn.classList.add("ui-btn--filled");

        setTimeout(() => {
          clearStorageBtn.textContent = originalText;
          clearStorageBtn.classList.remove("ui-btn--filled");
        }, 2000);
      });
    }
  }
}

customElements.define("ui-test-collapsible", UITestCollapsibleCard);
