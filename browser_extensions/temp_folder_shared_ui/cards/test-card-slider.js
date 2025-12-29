class TestCardSlider extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.value = 50;
  }

  setConfig(config) {
    this.config = config;
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>

        :host {
          --track-height: 24px;
          --thumb-width: 12px;
          --thumb-height: 44px;
          --thumb-scale: 0.66667;
          --thumb-color: #03a9f4;
          --track-fill: #03a9f4;
          --track-empty: #08303c;
          --surface: #0d1117;
          --motion: 200ms cubic-bezier(0.2, 0, 0, 1);
        }

        .wrap {
          padding: 20px;
          background: #0d1117;
        }

        .slider {
          width: 100%;
          position: relative;
          height: 54px;
        }

        .track {
          position: relative;
          width: 100%;
          height: var(--track-height);
          border-radius: 6px;
          background: var(--track-empty);
          overflow: visible;
        }

        .fill {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          background: var(--track-fill);
          margin-right: 6px;
          border-radius: 6px 2px 2px 6px;
          transition: margin-right var(--motion);
        }

        .fill::after {
          content: "";
          position: absolute;
          top: 0;
          right: -18px;
          width: 6px;
          height: 100%;
          border-radius: 2px;
          background: var(--surface);
          transition: right var(--motion);
        }

        .thumb {
          position: absolute;
          top: 50%;
          width: var(--thumb-width);
          height: var(--track-height);
          background: var(--surface);
          transform: translate(-50%, -50%);
          z-index: 5;
          transition: scale var(--motion);
        }

        .thumb::before {
          content: "";
          position: absolute;
          width: 4px;
          height: var(--thumb-height);
          top: calc(-0.5 * (var(--thumb-height) - var(--track-height)));
          left: 4px;
          border-radius: 999px;
          background: var(--track-fill);
          transition: scale var(--motion);
        }

        /* ACTIVE STATE */
        .active .thumb {
          scale: var(--thumb-scale) 1;
        }
        .active .thumb::before {
          scale: 0.75 1;
        }
        .active .fill {
          margin-right: 4px; /* 6px - 2px */
        }
        .active .fill::after {
          right: -16px; /* -18px + 2px */
        }

        .input {
          position: absolute;
          inset: 0;
          opacity: 0;
          cursor: grab;
          z-index: 10;
        }
        .input:active {
          cursor: grabbing;
        }

      </style>

      <div class="wrap">
        <div class="slider">
          <div class="track">
            <div class="fill" id="fill"></div>
            <div class="thumb" id="thumb"></div>
          </div>
          <input type="range" min="0" max="100" value="${this.value}" class="input" id="range">
        </div>
      </div>
    `;

    this.attachEvents();
    this.updateUI();
  }

  attachEvents() {
    const slider = this.shadowRoot.querySelector(".slider");
    const range = this.shadowRoot.querySelector("#range");

    const start = () => slider.classList.add("active");
    const end   = () => slider.classList.remove("active");

    range.addEventListener("input", (e) => {
      this.value = Number(e.target.value);
      this.updateUI();
    });

    range.addEventListener("mousedown", start);
    range.addEventListener("mouseup", end);
    range.addEventListener("mouseleave", end);

    range.addEventListener("touchstart", start);
    range.addEventListener("touchend", end);
    range.addEventListener("touchcancel", end);
  }

  updateUI() {
    const percent = this.value;
    const fill = this.shadowRoot.querySelector("#fill");
    const thumb = this.shadowRoot.querySelector("#thumb");

    fill.style.width = `${percent}%`;
    thumb.style.left = `${percent}%`;
  }

  getCardSize() {
    return 3;
  }
}

customElements.define("test-card-slider", TestCardSlider);
