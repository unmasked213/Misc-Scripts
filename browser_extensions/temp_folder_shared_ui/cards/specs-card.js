// /config/www/cards/specs-card.js
import "/local/base/foundation.js";
import { uiComponents, initCollapsibleSections, toggleAllSections, handleCopyButton } from "/local/base/components.js";

class SpecsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._isRendered = false;
  }

  setConfig(config) {
    // Parse config with defaults
    this._config = {
      card_title: config.card_title || "Specifications",
      copy_title: config.copy_title || "System Information",
      entities: config.entities || {},
      sections: config.sections || {}
    };

    if (this._hass) {
      this.render();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) {
      // Only render once on first hass set, then update values
      if (!this._isRendered) {
        this.render();
      } else {
        this.updateValues();
      }
    }
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents];
  }

  disconnectedCallback() {
    this._isRendered = false;
  }

  getCardSize() {
    return 6;
  }

  /**
   * Sanitize label for use as data attribute
   * @param {string} label - Label to sanitize
   * @returns {string} - Sanitized label
   */
  sanitizeLabel(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  /**
   * Parse entity template strings with filter support
   * @param {string} template - Template string to parse
   * @param {object} hass - Home Assistant object
   * @returns {string} - Processed value
   */
  parseEntityTemplate(template, hass) {
    if (!template || typeof template !== 'string') return template;
    if (!template.includes('{{')) return template;

    return template.replace(/\{\{\s*(.+?)\s*\}\}/g, (match, expression) => {
      try {
        // Extract entity reference and any filters/operations
        // STRICT SYNTAX: Requires states['entity_id'] format
        const entityMatch = expression.match(/states\['([^']+)'\]\.?(state|attributes\.[\w]+)?/);
        if (!entityMatch) return 'Unknown';

        const entityId = entityMatch[1];
        const accessor = entityMatch[2];
        const entity = hass?.states?.[entityId];
        if (!entity) return 'Unknown';

        // Get base value
        let value;
        if (!accessor || accessor === 'state') {
          value = entity.state;
        } else {
          const attrName = accessor.replace('attributes.', '');
          value = entity.attributes?.[attrName];
        }

        if (value === undefined || value === null) return 'Unknown';

        // Check for filters and operations after the entity reference
        const afterEntity = expression.substring(entityMatch[0].length).trim();

        if (afterEntity) {
          // Convert to float if filter present
          if (afterEntity.includes('| float')) {
            value = parseFloat(value);
            if (isNaN(value)) return 'Unknown';
          }

          // Handle division
          const divMatch = afterEntity.match(/\/\s*([\d.]+)/);
          if (divMatch) {
            value = value / parseFloat(divMatch[1]);
          }

          // Handle multiplication
          const multMatch = afterEntity.match(/\*\s*([\d.]+)/);
          if (multMatch) {
            value = value * parseFloat(multMatch[1]);
          }

          // Handle round filter
          const roundMatch = afterEntity.match(/\|\s*round\((\d+)\)/);
          if (roundMatch) {
            const decimals = parseInt(roundMatch[1]);
            value = value.toFixed(decimals);
          }
        }

        return value.toString();
      } catch (e) {
        console.error('Template parse error:', e);
        return 'Unknown';
      }
    });
  }

  /**
   * Update only the values without re-rendering the entire card
   */
  updateValues() {
    if (!this._config || !this._hass || !this._isRendered) return;

    const root = this.shadowRoot;
    if (!root) return;

    // Update all data row values
    for (const [sectionKey, section] of Object.entries(this._config.sections)) {
      const sectionEl = root.querySelector(`.ui-collapsible-section[data-section-id="${sectionKey}"]`);
      if (!sectionEl) continue;

      for (const [label, value] of Object.entries(section.data)) {
        const dataLabel = this.sanitizeLabel(label);
        const valueEl = sectionEl.querySelector(`[data-label="${dataLabel}"] .ui-data-row__value`);
        if (valueEl) {
          const processedValue = this.parseEntityTemplate(value, this._hass);
          valueEl.textContent = processedValue;
        }
      }
    }
  }




  /**
   * Generate clipboard text for copy button
   * @returns {string} - Formatted text for clipboard
   */
  generateClipboardText() {
    const labelColumnWidth = 28;

    let text = '```\n';
    text += `${this._config.copy_title}\n`;
    text += `Generated: ${new Date().toLocaleString()}\n`;
    text += `${'═'.repeat(30)}\n\n`;

    const sections = Object.entries(this._config.sections);
    for (let i = 0; i < sections.length; i++) {
      const [sectionKey, section] = sections[i];

      text += `${'-'.repeat(10)} ${section.title.toUpperCase()}\n`;

      for (const [label, value] of Object.entries(section.data)) {
        const processedValue = this.parseEntityTemplate(value, this._hass);
        const dots = '.'.repeat(Math.max(1, labelColumnWidth - label.length));
        text += `${label}${dots} ${processedValue}\n`;
      }

      text += `${'-'.repeat(labelColumnWidth)}\n`;

      // Four empty lines between sections (except after last section)
      if (i < sections.length - 1) {
        text += `\n\n\n\n`;
      }
    }

    text += '```';
    return text;
  }



  /**
   * Render sections with collapsible headers and data rows
   * @returns {string} - HTML string for sections
   */
  renderSections() {
    return Object.entries(this._config.sections)
      .map(([sectionKey, section]) => {
        const dataRows = Object.entries(section.data)
          .map(([label, value]) => {
            const processedValue = this.parseEntityTemplate(value, this._hass);
            const dataLabel = this.sanitizeLabel(label);
            return `<div class="ui-data-row ui-data-row--compact" data-label="${dataLabel}"> <span class="ui-data-row__label">${label}</span> <span class="ui-data-row__value">${processedValue}</span> </div>`;
          })
          .join('');

        return `<div class="ui-collapsible-section" data-section-id="${sectionKey}" data-initial-state="expanded"> <button class="ui-collapsible-section__header"> <span class="ui-collapsible-section__title">${section.title}</span> <span class="ui-collapsible-section__arrow"></span> </button> <div class="ui-collapsible-section__content"> ${dataRows} </div> </div>`;
      })
      .join('');
  }

  render() {
    if (!this._config || !this._hass) return;

    const sectionsHTML = this.renderSections();

    this.shadowRoot.innerHTML = `
      <style>
        /* Card-specific styles */
        .sections-container {
          height: 400px;
        }
      </style>

      <div class="ui-card">
        <div class="ui-card-header">
          <div class="ui-card-header__accent"></div>
          <h2 class="ui-card-header__title">${this._config.card_title}</h2>
        </div>

        <div class="ui-card-actions">
          <button id="copyBtn" class="ui-copy-btn" aria-label="Copy specifications">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="ui-btn ui-btn--accent ui-btn--icon ui-btn--large" id="toggleAllBtn" aria-label="Toggle all sections">
            <span class="ui-btn__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </span>
          </button>
        </div>

        <div class="sections-container ui-scrollable ui-scrollable--hidden">
          ${sectionsHTML}
        </div>
      </div>
    `;

    this._isRendered = true;
    this.attachEvents();
  }

  attachEvents() {
    const root = this.shadowRoot;
    if (!root) return;

    // Initialize collapsible sections
    initCollapsibleSections(root);

    // Copy button
    const copyBtn = root.querySelector("#copyBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const clipboardText = this.generateClipboardText();
        await handleCopyButton(copyBtn, clipboardText);
      });
    }

    // Toggle all button
    const toggleAllBtn = root.querySelector("#toggleAllBtn");
    const toggleIcon = toggleAllBtn?.querySelector('.ui-btn__icon svg');
    let isExpanded = true;

    if (toggleAllBtn && toggleIcon) {
      toggleAllBtn.addEventListener("click", () => {
        isExpanded = !isExpanded;
        toggleAllSections(root, isExpanded);

        // Update icon: minus when expanded, plus when collapsed
        if (isExpanded) {
          toggleIcon.innerHTML = '<line x1="5" y1="12" x2="19" y2="12"></line>';
        } else {
          toggleIcon.innerHTML = '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>';
        }
      });
    }
  }
}

customElements.define("specs-card", SpecsCard);
