// /config/www/cards/ui-circle-slider.js

import "/local/base/foundation.js";
import { uiComponents } from "/local/base/components.js";

class UICircleSlider extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    // Internal state
    this._value = 50;
    this._min = 0;
    this._max = 100;
    this._step = 1;
    this._size = 90;
    this._strokeWidth = 3;
    this._showRollback = true;
    this._label = "Circular Slider";
    this._disabled = false;
    this._unit = "%";

    // Interaction tracking
    this._startTime = 0;
    this._startValue = 0;
    this._isDragging = false;

    // Bound handlers for cleanup
    this._boundHandlers = null;
  }

  static get observedAttributes() {
    return ["value", "min", "max", "step", "size", "stroke-width", "show-rollback", "label", "disabled", "unit"];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    switch (name) {
      case "value":
        this._value = parseFloat(newValue) || 0;
        break;
      case "min":
        this._min = parseFloat(newValue) || 0;
        break;
      case "max":
        this._max = parseFloat(newValue) || 100;
        break;
      case "step":
        this._step = parseFloat(newValue) || 1;
        break;
      case "size":
        this._size = parseFloat(newValue) || 90;
        break;
      case "stroke-width":
        this._strokeWidth = parseFloat(newValue) || 3;
        break;
      case "show-rollback":
        this._showRollback = newValue !== "false";
        break;
      case "label":
        this._label = newValue || "Circular Slider";
        break;
      case "disabled":
        this._disabled = newValue !== null;
        break;
      case "unit":
        this._unit = newValue || "%";
        break;
    }

    this.updateVisuals();
  }

  setConfig(config) {
    this._value = config.value ?? 50;
    this._min = config.min ?? 0;
    this._max = config.max ?? 100;
    this._step = config.step ?? 1;
    this._size = config.size ?? 90;
    this._strokeWidth = config.strokeWidth ?? 3;
    this._showRollback = config.showRollback ?? true;
    this._label = config.label ?? "Circular Slider";
    this._disabled = config.disabled ?? false;
    this._unit = config.unit ?? "%";

    if (this.isConnected) {
      this.render();
      this.attachEvents();
    }
  }

  getCardSize() {
    return 2;
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents];
    this.render();
    this.attachEvents();
  }

  disconnectedCallback() {
    this.detachEvents();
  }

  render() {
    const disabledClass = this._disabled ? " ui-circle-slider--disabled" : "";
    const radius = (50 - this._strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;

    this.shadowRoot.innerHTML = `
      <div
        class="ui-circle-slider${disabledClass}"
        style="--ui-circle-size: ${this._size}px; --ui-circle-stroke-width: ${this._strokeWidth}px;"
        role="slider"
        aria-label="${this._label}"
        aria-valuemin="${this._min}"
        aria-valuemax="${this._max}"
        aria-valuenow="${this._value}"
        tabindex="${this._disabled ? -1 : 0}"
      >
        <svg class="ui-circle-slider__svg" viewBox="0 0 50 50">
          <circle
            class="ui-circle-slider__track"
            cx="25"
            cy="25"
            r="${radius}"
          />
          <circle
            class="ui-circle-slider__fill"
            cx="25"
            cy="25"
            r="${radius}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${circumference}"
          />
          <circle
            class="ui-circle-slider__rollback"
            cx="25"
            cy="25"
            r="${radius}"
            stroke-dasharray="0 ${circumference}"
            stroke-dashoffset="0"
          />
        </svg>

        <div class="ui-circle-slider__value">
          <span class="ui-circle-slider__value-number">${this._formatValue(this._value)}</span><span class="ui-circle-slider__unit">${this._unit}</span>
        </div>

        <input
          type="range"
          class="ui-circle-slider__input"
          min="${this._min}"
          max="${this._max}"
          step="${this._step}"
          value="${this._value}"
          ${this._disabled ? "disabled" : ""}
          aria-hidden="true"
          tabindex="-1"
        />

        <div class="ui-circle-slider__tooltip">${this._formatValue(this._value)}${this._unit}</div>
      </div>
    `;

    this.updateVisuals();
  }

  detachEvents() {
    if (!this._boundHandlers) return;

    const input = this.shadowRoot?.querySelector(".ui-circle-slider__input");
    const container = this.shadowRoot?.querySelector(".ui-circle-slider");

    if (input) {
      input.removeEventListener("input", this._boundHandlers.onInput);
      input.removeEventListener("mousedown", this._boundHandlers.onStart);
      input.removeEventListener("mouseup", this._boundHandlers.onEnd);
      input.removeEventListener("mouseleave", this._boundHandlers.onEnd);
      input.removeEventListener("touchstart", this._boundHandlers.onStart);
      input.removeEventListener("touchend", this._boundHandlers.onEnd);
      input.removeEventListener("touchcancel", this._boundHandlers.onEnd);
      input.removeEventListener("blur", this._boundHandlers.onEnd);
    }

    if (container) {
      container.removeEventListener("keydown", this._boundHandlers.onKeydown);
    }

    this._boundHandlers = null;
  }

  attachEvents() {
    this.detachEvents();

    const container = this.shadowRoot.querySelector(".ui-circle-slider");
    const input = this.shadowRoot.querySelector(".ui-circle-slider__input");
    const tooltip = this.shadowRoot.querySelector(".ui-circle-slider__tooltip");

    if (!container || !input || !tooltip) return;

    const onInput = (e) => {
      const newValue = parseFloat(e.target.value);
      this._value = newValue;
      this.updateVisuals();

      this.dispatchEvent(new CustomEvent("slider-input", {
        detail: { value: newValue },
        bubbles: true,
        composed: true
      }));
    };

    const onStart = () => {
      if (this._disabled) return;

      this._isDragging = true;
      this._startTime = Date.now();
      this._startValue = this._value;

      container.classList.add("active");
      tooltip.classList.add("visible");
    };

    const onEnd = () => {
      if (this._disabled || !this._isDragging) return;

      const duration = Date.now() - this._startTime;
      const valueDelta = Math.abs(this._value - this._startValue);

      container.classList.remove("active");
      tooltip.classList.remove("visible");

      if (duration < 200 && valueDelta < 5) {
        this.dispatchEvent(new CustomEvent("slider-tap", {
          detail: {},
          bubbles: true,
          composed: true
        }));
      } else {
        this.dispatchEvent(new CustomEvent("slider-change", {
          detail: { value: this._value },
          bubbles: true,
          composed: true
        }));
      }

      this._startValue = this._value;
      this._isDragging = false;
      this.updateVisuals();
    };

    const onKeydown = (e) => {
      if (this._disabled) return;

      let newValue = this._value;
      const step = this._step;

      switch (e.key) {
        case "ArrowUp":
        case "ArrowRight":
          newValue = Math.min(this._max, this._value + step);
          e.preventDefault();
          break;
        case "ArrowDown":
        case "ArrowLeft":
          newValue = Math.max(this._min, this._value - step);
          e.preventDefault();
          break;
        case "Home":
          newValue = this._min;
          e.preventDefault();
          break;
        case "End":
          newValue = this._max;
          e.preventDefault();
          break;
        default:
          return;
      }

      this._value = newValue;
      input.value = newValue;
      this.updateVisuals();

      this.dispatchEvent(new CustomEvent("slider-change", {
        detail: { value: newValue },
        bubbles: true,
        composed: true
      }));
    };

    this._boundHandlers = { onInput, onStart, onEnd, onKeydown };

    input.addEventListener("input", onInput);
    input.addEventListener("mousedown", onStart);
    input.addEventListener("mouseup", onEnd);
    input.addEventListener("mouseleave", onEnd);
    input.addEventListener("touchstart", onStart, { passive: true });
    input.addEventListener("touchend", onEnd);
    input.addEventListener("touchcancel", onEnd);
    input.addEventListener("blur", onEnd);
    container.addEventListener("keydown", onKeydown);
  }

  updateVisuals() {
    const container = this.shadowRoot?.querySelector(".ui-circle-slider");
    const fillCircle = this.shadowRoot?.querySelector(".ui-circle-slider__fill");
    const rollbackCircle = this.shadowRoot?.querySelector(".ui-circle-slider__rollback");
    const valueDisplay = this.shadowRoot?.querySelector(".ui-circle-slider__value-number");
    const tooltip = this.shadowRoot?.querySelector(".ui-circle-slider__tooltip");
    const input = this.shadowRoot?.querySelector(".ui-circle-slider__input");

    if (!container || !fillCircle || !rollbackCircle) return;

    const percentage = ((this._value - this._min) / (this._max - this._min)) * 100;
    const radius = (50 - this._strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - percentage / 100);

    fillCircle.style.strokeDashoffset = offset;

    // Rollback indicator: shows segment from current to start value when dragging down
    if (this._isDragging && this._showRollback && this._value < this._startValue) {
      const startPct = ((this._startValue - this._min) / (this._max - this._min)) * 100;
      const currentPct = percentage;
      const segmentLength = ((startPct - currentPct) / 100) * circumference;
      const currentOffset = circumference * (1 - currentPct / 100);

      rollbackCircle.style.strokeDasharray = `${segmentLength} ${circumference - segmentLength}`;
      rollbackCircle.style.strokeDashoffset = currentOffset;
      rollbackCircle.classList.add("visible");
    } else {
      rollbackCircle.style.strokeDasharray = `0 ${circumference}`;
      rollbackCircle.classList.remove("visible");
    }

    if (valueDisplay) {
      valueDisplay.textContent = this._formatValue(this._value);
    }

    if (tooltip) {
      tooltip.textContent = `${this._formatValue(this._value)}${this._unit}`;
    }

    if (input) {
      input.value = this._value;
    }

    container?.setAttribute("aria-valuenow", this._value);
  }

  _formatValue(value) {
    const decimals = this._step < 1 ? Math.abs(Math.floor(Math.log10(this._step))) : 0;
    return value.toFixed(decimals);
  }

  get value() {
    return this._value;
  }

  set value(val) {
    this._value = Math.max(this._min, Math.min(this._max, parseFloat(val) || 0));
    this.updateVisuals();
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(val) {
    this._disabled = Boolean(val);
    this.render();
    this.attachEvents();
  }
}

customElements.define("ui-circle-slider", UICircleSlider);