// /config/www/cards/phone-card.js
import "/local/base/foundation.js";
import { uiComponents } from "/local/base/components.js";

class PhoneCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._isRendered = false;
    this._menuOpen = false;
  }

  setConfig(config) {
    this._config = {
      card_title: config.card_title || "Phone",
      ringer_entity: config.ringer_entity || "sensor.phone_c_ringer_mode",
      flashlight_entity: config.flashlight_entity || "binary_sensor.phone_c_flashlight"
    };

    if (this._hass) {
      this.render();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) {
      if (!this._isRendered) {
        this.render();
      } else {
        this.updateValues();
      }
    }
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, uiComponents];
    this._boundHandleOutsideClick = this._handleOutsideClick.bind(this);
    document.addEventListener("click", this._boundHandleOutsideClick);
  }

  disconnectedCallback() {
    this._isRendered = false;
    document.removeEventListener("click", this._boundHandleOutsideClick);
  }

  _handleOutsideClick(e) {
    if (this._menuOpen && !this.shadowRoot.contains(e.target)) {
      this.closeMenu();
    }
  }

  getCardSize() {
    return 3;
  }

  getRingerMode() {
    const entity = this._hass?.states?.[this._config.ringer_entity];
    return entity?.state || "normal";
  }

  getRingerLabel(mode) {
    const labels = {
      normal: "Normal",
      vibrate: "Vibrate",
      silent: "Silent"
    };
    return labels[mode] || mode;
  }

  getRingerIcon(mode) {
    const icons = {
      normal: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
      vibrate: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zM16.5 3h-9C6.67 3 6 3.67 6 4.5v15c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5v-15c0-.83-.67-1.5-1.5-1.5zM16 19H8V5h8v14z"/></svg>`,
      silent: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`
    };
    return icons[mode] || icons.normal;
  }

  isFlashlightOn() {
    const entity = this._hass?.states?.[this._config.flashlight_entity];
    return entity?.state === "on";
  }

  updateValues() {
    if (!this._config || !this._hass || !this._isRendered) return;

    const root = this.shadowRoot;
    const mainBtn = root.querySelector(".ui-split__main");
    const mode = this.getRingerMode();

    if (mainBtn) {
      mainBtn.innerHTML = `
        <span class="ui-split__icon">${this.getRingerIcon(mode)}</span>
        <span class="ui-split__label">${this.getRingerLabel(mode)}</span>
      `;
    }

    // Update selected state in menu
    root.querySelectorAll(".ui-menu__item").forEach(item => {
      item.classList.toggle("ui-menu__item--selected", item.dataset.mode === mode);
    });

    // Update flashlight toggle state
    const torchBtn = root.querySelector("#torchBtn");
    if (torchBtn) {
      torchBtn.classList.toggle("is-selected", this.isFlashlightOn());
    }
  }

  toggleMenu() {
    this._menuOpen = !this._menuOpen;
    const root = this.shadowRoot;
    const split = root.querySelector(".ui-split");
    const menu = root.querySelector(".ui-menu");

    split.classList.toggle("ui-split--open", this._menuOpen);
    menu.classList.toggle("ui-menu--open", this._menuOpen);
  }

  closeMenu() {
    this._menuOpen = false;
    const root = this.shadowRoot;
    const split = root.querySelector(".ui-split");
    const menu = root.querySelector(".ui-menu");

    split?.classList.remove("ui-split--open");
    menu?.classList.remove("ui-menu--open");
  }

  async callScript(scriptId) {
    await this._hass.callService("script", scriptId);
  }

  render() {
    if (!this._config || !this._hass) return;

    const mode = this.getRingerMode();
    const flashlightOn = this.isFlashlightOn();

    this.shadowRoot.innerHTML = `
      <style>
        .phone-card {
          display: flex;
          flex-direction: column;
          gap: var(--ui-space-4);
          padding: var(--ui-space-4);
        }

        .phone-card__actions {
          display: flex;
          gap: var(--ui-space-3);
          align-items: center;
        }

        .ui-split__icon {
          display: flex;
          align-items: center;
        }

        .ui-split__label {
          position: relative;
          z-index: 1;
        }

        .phone-card__map-placeholder {
          background: var(--ui-elevated-1);
          border-radius: var(--ui-radius-l);
          height: 200px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--ui-text-mute);
        }
      </style>

      <div class="ui-card">
        <div class="ui-card-header">
          <div class="ui-card-header__accent"></div>
          <h2 class="ui-card-header__title">${this._config.card_title}</h2>
        </div>

        <div class="phone-card">
          <div class="phone-card__actions">
            <!-- Find My Phone -->
            <button class="ui-btn ui-btn--accent ui-btn--filled" id="findBtn" aria-label="Find my phone">
              <ha-icon icon="fluent:phone-shake-24-regular"></ha-icon>
              <span>Find</span>
            </button>

            <!-- Ringer Mode Split Button -->
            <div class="ui-split">
              <button class="ui-split__main" id="ringerMain">
                <span class="ui-split__icon">${this.getRingerIcon(mode)}</span>
                <span class="ui-split__label">${this.getRingerLabel(mode)}</span>
              </button>
              <button class="ui-split__arrow" id="ringerArrow">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 10l5 5 5-5z"/>
                </svg>
              </button>

              <div class="ui-menu" role="menu">
                <button class="ui-menu__item ${mode === 'normal' ? 'ui-menu__item--selected' : ''}" data-mode="normal" role="menuitem">
                  Normal
                </button>
                <button class="ui-menu__item ${mode === 'vibrate' ? 'ui-menu__item--selected' : ''}" data-mode="vibrate" role="menuitem">
                  Vibrate
                </button>
                <button class="ui-menu__item ${mode === 'silent' ? 'ui-menu__item--selected' : ''}" data-mode="silent" role="menuitem">
                  Silent
                </button>
              </div>
            </div>

            <!-- Flashlight Toggle -->
            <button class="ui-btn toggle-btn ui-btn--icon ${flashlightOn ? 'is-selected' : ''}" id="torchBtn" aria-label="Toggle flashlight">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 14l3 3v5h6v-5l3-3V9H6v5zm5-12h2v3h-2V2zM3.5 5.88l1.41-1.41 2.12 2.12L5.62 8 3.5 5.88zm13.46.71l2.12-2.12 1.41 1.41L18.38 8l-1.42-1.41z"/>
              </svg>
            </button>
          </div>

          <div class="phone-card__map-placeholder">
            Map placeholder
          </div>
        </div>
      </div>
    `;

    this._isRendered = true;
    this.attachEvents();
  }

  attachEvents() {
    const root = this.shadowRoot;

    // Find button
    const findBtn = root.querySelector("#findBtn");
    findBtn?.addEventListener("click", () => {
      this.callScript("phone_c_find");
    });

    // Split button arrow toggles menu
    const ringerArrow = root.querySelector("#ringerArrow");
    ringerArrow?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Menu items
    root.querySelectorAll(".ui-menu__item").forEach(item => {
      item.addEventListener("click", (e) => {
        const mode = e.currentTarget.dataset.mode;
        this.callScript(`phone_c_ringer_${mode}`);
        this.closeMenu();
      });
    });

    // Flashlight toggle
    const torchBtn = root.querySelector("#torchBtn");
    torchBtn?.addEventListener("click", () => {
      this.callScript("phone_c_flashlight_toggle");
    });
  }
}

customElements.define("phone-card", PhoneCard);