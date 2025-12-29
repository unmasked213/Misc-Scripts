// /config/www/cards/ui-test-forms.js
import "/local/base/foundation.js";
import { uiComponents } from "/local/base/components.js";
import { uiToggles } from "/local/base/toggles.js";
import { initInputs, initSliders } from "/local/base/helpers.js";
import "/local/cards/ui-circle-slider.js";

class UITestFormsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      inputValue: "",
      sliderUsed: 205,
      circleSliderValue: 65,
      interactiveSwitchOn: false,
    };
  }

  setConfig(config) {
    this.config = config || {};
    this.render();
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents, uiToggles];
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
        id: "input-field",
        title: "Inputs",
        description: null,
        content: this.renderInputField,
      },
      {
        id: "sliders",
        title: "Sliders",
        description: null,
        content: this.renderSliders,
      },
      {
        id: "circular-sliders",
        title: "Circular Sliders",
        description: null,
        content: this.renderCircularSliders,
      },
      {
        id: "toggle-switch",
        title: "Toggle Switch",
        description: null,
        content: this.renderToggleSwitch,
      },
      {
        id: "radio-buttons",
        title: "Radio Buttons",
        description: null,
        content: this.renderRadioButtons,
      },
      {
        id: "checkbox",
        title: "Checkbox",
        description: null,
        content: this.renderCheckbox,
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────
  // Section Renderers
  // ─────────────────────────────────────────────────────────────

  renderInputField() {
    const hasValue = this.state.inputValue ? " has-value" : "";
    return `
      <div class="test-row" style="flex-direction: column; gap: var(--ui-space-4); align-items: stretch;">
        <div class="ui-input-wrapper">
          <div class="ui-input-pill${hasValue}">
            <label class="ui-input-label">Example placeholder text...</label>
            <input type="text" class="ui-input-field" id="testInput" value="${this.state.inputValue || ""}" autocomplete="off" />
          </div>
        </div>
        <div id="inputValueDisplay" style="font-size: var(--ui-font-s); color: var(--ui-text-mute);">
          Current value: "${this.state.inputValue || ""}"
        </div>
      </div>
    `;
  }

  renderSliders() {
    return `
      <div class="test-row" style="flex-direction: column; gap: var(--ui-space-4); align-items: stretch;">
        ${this.renderSlider("sliderUsed", "", 0, 300)}
        <div id="sliderValueDisplay" style="font-size: var(--ui-font-s); color: var(--ui-text-mute);">
          Current value: "${this.state.sliderUsed}"
        </div>
      </div>
    `;
  }

  renderSlider(id, label, min, max) {
    const value = this.state[id];
    const percentage = ((value - min) / (max - min)) * 100;

    return `
      <div class="ui-slider" data-slider="${id}">
        <div class="ui-slider__container">
          <div class="ui-slider__track-active"></div>
          <div class="ui-slider__track-inactive"></div>
          <div class="ui-slider__thumb">
            <div class="ui-slider__value">${Math.round(value)}</div>
          </div>
        </div>
        <input
          type="range"
          class="ui-slider__input"
          min="${min}"
          max="${max}"
          value="${value}"
          data-slider-id="${id}"
        />
      </div>
    `;
  }

  renderCircularSliders() {
    return `
      <div class="test-row" style="gap: var(--ui-space-6); align-items: flex-start;">
        <div class="circle-slider-demo">
          <ui-circle-slider
            id="circleSliderDisabled"
            value="30"
            disabled
            label="Disabled slider"
          ></ui-circle-slider>
          <span class="demo-label">Disabled</span>
        </div>
        <div class="circle-slider-demo">
          <ui-circle-slider
            id="circleSliderZero"
            value="0"
            label="Zero value slider"
          ></ui-circle-slider>
          <span class="demo-label">0%</span>
        </div>
        <div class="circle-slider-demo">
          <ui-circle-slider
            id="circleSliderFull"
            value="100"
            label="Full value slider"
          ></ui-circle-slider>
          <span class="demo-label">100%</span>
        </div>
        <div class="circle-slider-demo">
          <ui-circle-slider
            id="circleSliderInteractive"
            value="${this.state.circleSliderValue}"
            label="Interactive slider"
          ></ui-circle-slider>
          <span class="demo-label">Interactive</span>
        </div>
      </div>
      <div id="circleSliderValueDisplay" style="font-size: var(--ui-font-s); color: var(--ui-text-mute); margin-top: var(--ui-space-3);">
        Interactive value: "${this.state.circleSliderValue}" · Last event: none
      </div>
    `;
  }

  renderToggleSwitch() {
    return `
      <div class="test-row" style="flex-direction: column; gap: var(--ui-space-4); align-items: stretch;">

        <!-- Basic states -->
        <div style="display: flex; gap: var(--ui-space-4); flex-wrap: wrap;">
          <label class="ui-switch">
            <input type="checkbox" class="ui-switch__input" />
            <span class="ui-switch__track">
              <span class="ui-switch__thumb"></span>
            </span>
            <span class="ui-switch__label">Standard OFF</span>
          </label>

          <label class="ui-switch">
            <input type="checkbox" class="ui-switch__input" checked />
            <span class="ui-switch__track">
              <span class="ui-switch__thumb"></span>
            </span>
            <span class="ui-switch__label">Standard ON</span>
          </label>
        </div>

        <!-- Icon variant -->
        <div style="display: flex; gap: var(--ui-space-4); flex-wrap: wrap;">
          <label class="ui-icon-switch">
            <input type="checkbox" class="ui-switch__input" id="interactiveSwitch" ${this.state.interactiveSwitchOn ? "checked" : ""} />
            <span class="ui-switch__track">
              <span class="ui-switch__thumb">
                <svg class="ui-switch__icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                </svg>
              </span>
            </span>
            <span class="ui-switch__label">Icon Switch (${this.state.interactiveSwitchOn ? "ON" : "OFF"})</span>
          </label>
        </div>

        <!-- Disabled state -->
        <div style="display: flex; gap: var(--ui-space-4); flex-wrap: wrap;">
          <label class="ui-switch ui-switch--disabled">
            <input type="checkbox" class="ui-switch__input" disabled />
            <span class="ui-switch__track">
              <span class="ui-switch__thumb"></span>
            </span>
            <span class="ui-switch__label">Disabled OFF</span>
          </label>

          <label class="ui-switch ui-switch--disabled">
            <input type="checkbox" class="ui-switch__input" checked disabled />
            <span class="ui-switch__track">
              <span class="ui-switch__thumb"></span>
            </span>
            <span class="ui-switch__label">Disabled ON</span>
          </label>
        </div>

      </div>
    `;
  }

  renderRadioButtons() {
    return `
      <div class="test-row">
        <div style="font-size: var(--ui-font-s); color: var(--ui-text-mute);">
          Component not yet implemented
        </div>
      </div>
    `;
  }

  renderCheckbox() {
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
        .circle-slider-demo {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--ui-space-2);
        }
        .demo-label {
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

    initInputs(root);
    this.attachInputStateHandlers(root);
    initSliders(root);
    this.attachSliderStateHandlers(root);
    this.attachCircleSliderEvents(root);
    this.attachSwitchEvents(root);
  }

  attachInputStateHandlers(root) {
    const input = root.querySelector("#testInput");
    const display = root.querySelector("#inputValueDisplay");

    if (!input || !display) return;

    input.addEventListener("input", (e) => {
      this.state.inputValue = e.target.value;
      display.textContent = `Current value: "${this.state.inputValue || ""}"`;
    });
  }

  attachSliderStateHandlers(root) {
    const sliders = root.querySelectorAll(".ui-slider");

    sliders.forEach((slider) => {
      const input = slider.querySelector(".ui-slider__input");
      const sliderId = input?.dataset.sliderId;

      if (!input || !sliderId) return;

      // Handle state and display updates
      input.addEventListener("input", (e) => {
        const value = parseFloat(e.target.value);
        this.state[sliderId] = value;

        const display = root.querySelector("#sliderValueDisplay");
        if (display) {
          display.textContent = `Current value: "${Math.round(value)}"`;
        }
      });
    });
  }

  attachCircleSliderEvents(root) {
    const interactive = root.querySelector("#circleSliderInteractive");
    const display = root.querySelector("#circleSliderValueDisplay");

    if (!interactive || !display) return;

    interactive.addEventListener("slider-change", (e) => {
      this.state.circleSliderValue = e.detail.value;
      display.textContent = `Interactive value: "${e.detail.value}" · Last event: slider-change`;
    });

    interactive.addEventListener("slider-input", (e) => {
      display.textContent = `Interactive value: "${e.detail.value}" · Last event: slider-input (dragging)`;
    });
  }

  attachSwitchEvents(root) {
    const interactiveSwitch = root.querySelector("#interactiveSwitch");
    const label = interactiveSwitch?.closest('.ui-icon-switch')?.querySelector('.ui-switch__label');

    if (!interactiveSwitch || !label) return;

    interactiveSwitch.addEventListener("change", (e) => {
      this.state.interactiveSwitchOn = e.target.checked;
      // Update label text without re-rendering to preserve CSS animations
      label.textContent = `Icon Switch (${this.state.interactiveSwitchOn ? "ON" : "OFF"})`;
    });
  }
}

customElements.define("ui-test-forms", UITestFormsCard);