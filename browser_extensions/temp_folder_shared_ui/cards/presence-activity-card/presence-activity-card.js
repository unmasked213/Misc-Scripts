// /config/www/cards/presence-activity-card/presence-activity-card.js
// Presence Activity Card V2 - Main Component
// Displays real-time activity from area presence sensors

import '/local/base/foundation.js';
import { FloorResolver } from './floor-resolver.js';
import { ActivityColorCalculator, formatElapsedTime, getSecondsElapsed } from './color-fade.js';

/**
 * Default configuration
 */
const DEFAULTS = {
  activeThresholdSeconds: 60,
  recentFadeDurationSeconds: 300,
  itemLimit: 20,
  fadeCurve: 0.7
};

/**
 * Card-specific styles
 * Uses token-only values from foundation.js
 */
const cardStyles = new CSSStyleSheet();
cardStyles.replaceSync(`
  :host {
    display: block;
  }

  .pac-container {
    position: relative;
    height: 250px;
    background: transparent;
    overflow: hidden;
  }

  .pac-list {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: var(--ui-space-4);
    padding: var(--ui-space-8) var(--ui-space-3) var(--ui-space-2);
    overflow-y: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    
    /* Gradient mask: solid at top, fades at bottom */
    mask-image: linear-gradient(
      to bottom,
      black 0%,
      black 85%,
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      to bottom,
      black 0%,
      black 85%,
      transparent 100%
    );
  }

  .pac-list::-webkit-scrollbar {
    display: none;
  }

  .pac-item {
    display: flex;
    align-items: baseline;
    gap: var(--ui-space-2);
    font-size: var(--ui-font-m);
    line-height: var(--ui-font-line-height-s);
    flex-shrink: 0;
    cursor: pointer;
    
    /* Base transition for color/opacity updates */
    transition: 
      color var(--ui-motion-fast),
      opacity var(--ui-motion-fast),
      font-size var(--ui-motion-fast);
  }

  .pac-item:hover {
    opacity: 1 !important;
  }

  /* Entry animation - more pronounced */
  .pac-item--entering {
    animation: pac-item-enter 320ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }

  @keyframes pac-item-enter {
    0% {
      opacity: 0;
      transform: translateX(-16px);
    }
    100% {
      opacity: 1;
      transform: translateX(0);
    }
  }

  /* Exit animation */
  .pac-item--exiting {
    animation: pac-item-exit 250ms cubic-bezier(0.4, 0, 1, 1) forwards;
    pointer-events: none;
  }

  @keyframes pac-item-exit {
    0% {
      opacity: 1;
      transform: translateX(0);
    }
    100% {
      opacity: 0;
      transform: translateX(24px);
    }
  }

  .pac-item__floor-indicator {
    width: 2px;
    height: 0.7em;
    border-radius: 1px;
    flex-shrink: 0;
    align-self: center;
    opacity: 0.4;
    transition: background var(--ui-motion-fast);
  }

  .pac-item__name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pac-item__time {
    flex-shrink: 0;
    font-size: 0.75em;
    letter-spacing: 0.8px;
    padding-left: var(--ui-space-1);
    transition: color var(--ui-motion-fast);
  }

  .pac-empty {
    color: var(--ui-text-mute);
    font-size: var(--ui-font-s);
    padding: var(--ui-space-4);
    text-align: center;
    animation: pac-item-enter 320ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }

  /* Floor group spacing */
  .pac-item[data-floor-break="true"] {
    margin-top: var(--ui-space-2);
  }

  .pac-item:first-child[data-floor-break="true"] {
    margin-top: 0;
  }

  /* Settings panel toggle */
  .pac-settings-toggle {
    position: absolute;
    top: var(--ui-space-2);
    right: var(--ui-space-2);
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    color: var(--ui-text-mute);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--ui-motion-fast);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    z-index: 1;
  }

  .pac-container:hover .pac-settings-toggle {
    opacity: 0.6;
  }

  .pac-settings-toggle:hover {
    opacity: 1 !important;
    background: var(--ui-state-hover);
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .pac-item,
    .pac-item--entering,
    .pac-item--exiting,
    .pac-settings-toggle {
      animation: none !important;
      transition-duration: 0.01ms !important;
    }
  }
`);


/**
 * PresenceActivityCard
 * 
 * Custom Home Assistant card displaying real-time presence activity.
 * Queries area presence sensors directly, eliminating manual exclusion lists.
 */
class PresenceActivityCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    // Configuration
    this._config = {};
    this._hass = null;
    
    // Data layer
    this._floorResolver = null;
    this._colorCalculator = null;
    this._activityList = [];
    
    // Animation state tracking
    this._previousEntityIds = new Set();
    this._exitingItems = new Map(); // entityId ? timeout handle
    
    // Update timer
    this._updateInterval = null;
    
    // State
    this._initialized = false;
  }

  /**
   * Card configuration from Lovelace YAML
   */
  setConfig(config) {
    if (!config.area_sensors || !Array.isArray(config.area_sensors)) {
      throw new Error('Please define area_sensors as an array of entity IDs');
    }
    
    this._config = {
      area_sensors: config.area_sensors,
      activeThresholdSeconds: config.active_threshold ?? DEFAULTS.activeThresholdSeconds,
      recentFadeDurationSeconds: config.recent_fade_duration ?? DEFAULTS.recentFadeDurationSeconds,
      itemLimit: config.item_limit ?? DEFAULTS.itemLimit,
      fadeCurve: config.fade_curve ?? DEFAULTS.fadeCurve,
      floorColors: config.floor_colors ?? {}
    };
    
    // Initialize color calculator with config
    this._colorCalculator = new ActivityColorCalculator({
      activeThresholdSeconds: this._config.activeThresholdSeconds,
      recentFadeDurationSeconds: this._config.recentFadeDurationSeconds,
      fadeCurve: this._config.fadeCurve
    });
    
    if (this.isConnected && this._hass) {
      this._initialize();
    }
  }

  /**
   * Home Assistant state updates
   */
  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    
    if (firstHass && this._config.area_sensors) {
      this._initialize();
    } else if (this._initialized) {
      this._updateActivityList();
    }
  }

  /**
   * Connected to DOM
   */
  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, cardStyles];
    this._render();
    this._startUpdateTimer();
    
    if (this._hass && this._config.area_sensors) {
      this._initialize();
    }
  }

  /**
   * Disconnected from DOM
   */
  disconnectedCallback() {
    this._stopUpdateTimer();
    
    // Clear any pending exit animations
    for (const timeout of this._exitingItems.values()) {
      clearTimeout(timeout);
    }
    this._exitingItems.clear();
  }

  /**
   * Initialize data layer
   */
  async _initialize() {
    if (this._initialized) return;
    
    try {
      // Initialize floor resolver
      this._floorResolver = new FloorResolver(this._hass);
      await this._floorResolver.initialize();
      
      // Apply floor color overrides from config
      for (const [floorId, color] of Object.entries(this._config.floorColors)) {
        this._floorResolver.setFloorColor(floorId, color);
      }
      
      this._initialized = true;
      this._updateActivityList();
      
    } catch (error) {
      console.error('[PresenceActivityCard] Initialization failed:', error);
    }
  }

  /**
   * Start 1-second update timer for visual refresh
   */
  _startUpdateTimer() {
    this._stopUpdateTimer();
    this._updateInterval = setInterval(() => {
      if (this._initialized) {
        this._updateVisuals();
      }
    }, 1000);
  }

  /**
   * Stop update timer
   */
  _stopUpdateTimer() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
  }

  /**
   * Update activity list from area sensor attributes
   * Uses active_sensors, recent_edge_sensors, and recently_off_sensors
   */
  _updateActivityList() {
    const items = [];
    const seenEntities = new Set();
    
    for (const sensorId of this._config.area_sensors) {
      const sensor = this._hass.states[sensorId];
      if (!sensor) continue;
      
      const attrs = sensor.attributes;
      const areaId = attrs.area_id;
      const floorInfo = this._floorResolver?.getFloorForArea(areaId);
      
      // Process active sensors
      const activeSensors = this._parseJsonAttribute(attrs.active_sensors);
      for (const entityId of activeSensors) {
        if (seenEntities.has(entityId)) continue;
        seenEntities.add(entityId);
        
        const entityState = this._hass.states[entityId];
        if (!entityState) continue;
        
        items.push({
          entityId,
          name: entityState.attributes.friendly_name || entityId,
          lastChanged: entityState.last_changed,
          state: 'on',
          isDoor: entityState.attributes.device_class === 'door',
          areaId,
          areaName: attrs.area_name,
          floor: floorInfo
        });
      }
      
      // Process recent edge sensors (doors within hold window)
      const recentEdge = this._parseJsonAttribute(attrs.recent_edge_sensors);
      for (const entityId of recentEdge) {
        if (seenEntities.has(entityId)) continue;
        seenEntities.add(entityId);
        
        const entityState = this._hass.states[entityId];
        if (!entityState) continue;
        
        items.push({
          entityId,
          name: this._formatDoorName(entityState.attributes.friendly_name || entityId),
          lastChanged: entityState.last_changed,
          state: entityState.state,
          isDoor: true,
          areaId,
          areaName: attrs.area_name,
          floor: floorInfo
        });
      }
      
      // Process recently off sensors
      const recentlyOff = this._parseJsonAttribute(attrs.recently_off_sensors);
      for (const entityId of recentlyOff) {
        if (seenEntities.has(entityId)) continue;
        seenEntities.add(entityId);
        
        const entityState = this._hass.states[entityId];
        if (!entityState) continue;
        
        items.push({
          entityId,
          name: entityState.attributes.friendly_name || entityId,
          lastChanged: entityState.last_changed,
          state: 'off',
          isDoor: false,
          areaId,
          areaName: attrs.area_name,
          floor: floorInfo
        });
      }
    }
    
    // Sort by recency (most recent at top)
    items.sort((a, b) => new Date(b.lastChanged) - new Date(a.lastChanged));
    
    // Apply limit
    this._activityList = items.slice(0, this._config.itemLimit);
    
    this._updateVisuals();
  }

  /**
   * Parse JSON attribute safely
   */
  _parseJsonAttribute(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Format door sensor name (strip common prefixes)
   */
  _formatDoorName(name) {
    return name
      .replace(/^Door:\s*/i, '')
      .replace(/^Contact:\s*/i, '')
      .replace(/\s+Door$/i, '');
  }

  /**
   * Initial render - creates DOM structure
   */
  _render() {
    this.shadowRoot.innerHTML = `
      <div class="pac-container">
        <div class="pac-list" id="activity-list"></div>
        <button class="pac-settings-toggle" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
          </svg>
        </button>
      </div>
    `;
  }

  /**
   * Update visuals - applies current state to DOM with animations
   * Called every second by timer and on data changes
   */
  _updateVisuals() {
    const listEl = this.shadowRoot.getElementById('activity-list');
    if (!listEl) return;
    
    // Handle empty state
    if (!this._activityList || this._activityList.length === 0) {
      this._animateOutAll(listEl);
      return;
    }
    
    // Remove empty message if present
    const emptyEl = listEl.querySelector('.pac-empty');
    if (emptyEl) {
      emptyEl.remove();
    }
    
    // Sort by floor level (highest first), then by time within floor
    const sortedItems = this._sortByFloorThenTime(this._activityList);
    
    // Build current entity ID set
    const currentEntityIds = new Set(sortedItems.map(item => item.entityId));
    
    // Detect additions and removals
    const additions = sortedItems.filter(item => !this._previousEntityIds.has(item.entityId));
    const removals = [...this._previousEntityIds].filter(id => !currentEntityIds.has(id));
    
    // Animate out removed items
    for (const entityId of removals) {
      this._animateOut(listEl, entityId);
    }
    
    // Update or create items
    let lastFloorId = null;
    
    sortedItems.forEach((item, index) => {
      const elapsed = getSecondsElapsed(item.lastChanged);
      const type = item.state === 'on' ? 'active' : 'recent';
      const colors = this._colorCalculator.getColors(type, elapsed);
      const timeStr = formatElapsedTime(elapsed);
      const floorColor = item.floor?.color || 'transparent';
      const currentFloorId = item.floor?.floorId || null;
      const isFloorBreak = index > 0 && currentFloorId !== lastFloorId;
      lastFloorId = currentFloorId;
      
      const isNew = additions.some(a => a.entityId === item.entityId);
      let itemEl = listEl.querySelector(`[data-entity="${item.entityId}"]`);
      
      if (itemEl) {
        // Update existing item
        this._updateItemElement(itemEl, item, colors, timeStr, floorColor, isFloorBreak);
      } else {
        // Create new item
        itemEl = this._createItemElement(item, colors, timeStr, floorColor, isFloorBreak, isNew);
        
        // Insert at correct position
        const existingItems = listEl.querySelectorAll('.pac-item:not(.pac-item--exiting)');
        if (index < existingItems.length) {
          listEl.insertBefore(itemEl, existingItems[index]);
        } else {
          listEl.appendChild(itemEl);
        }
      }
    });
    
    // Reorder items if needed (items may have changed position)
    this._reorderItems(listEl, sortedItems);
    
    // Update previous entity set
    this._previousEntityIds = currentEntityIds;
  }

  /**
   * Create a new item DOM element
   */
  _createItemElement(item, colors, timeStr, floorColor, isFloorBreak, animate) {
    const itemEl = document.createElement('div');
    itemEl.className = 'pac-item' + (animate ? ' pac-item--entering' : '');
    itemEl.dataset.entity = item.entityId;
    itemEl.dataset.floorBreak = isFloorBreak;
    
    itemEl.style.color = colors.text;
    itemEl.style.opacity = colors.opacity;
    itemEl.style.fontSize = colors.fontSize;
    
    itemEl.innerHTML = `
      <div class="pac-item__floor-indicator" style="background: ${floorColor};"></div>
      <span class="pac-item__name">${item.name}</span>
      <span class="pac-item__time" style="color: ${colors.secondary};">${timeStr}</span>
    `;
    
    // Click handler to open more-info dialog
    itemEl.addEventListener('click', () => {
      const event = new Event('hass-more-info', {
        bubbles: true,
        composed: true,
      });
      event.detail = { entityId: item.entityId };
      this.dispatchEvent(event);
    });
    
    // Remove animation class after animation completes
    if (animate) {
      setTimeout(() => {
        itemEl.classList.remove('pac-item--entering');
      }, 320);
    }
    
    return itemEl;
  }

  /**
   * Update an existing item element
   */
  _updateItemElement(itemEl, item, colors, timeStr, floorColor, isFloorBreak) {
    // Update styles
    itemEl.style.color = colors.text;
    itemEl.style.opacity = colors.opacity;
    itemEl.style.fontSize = colors.fontSize;
    itemEl.dataset.floorBreak = isFloorBreak;
    
    // Update floor indicator
    const floorIndicator = itemEl.querySelector('.pac-item__floor-indicator');
    if (floorIndicator) {
      floorIndicator.style.background = floorColor;
    }
    
    // Update time
    const timeEl = itemEl.querySelector('.pac-item__time');
    if (timeEl) {
      timeEl.textContent = timeStr;
      timeEl.style.color = colors.secondary;
    }
  }

  /**
   * Animate an item out and remove it
   */
  _animateOut(listEl, entityId) {
    // Cancel any existing exit timeout for this entity
    if (this._exitingItems.has(entityId)) {
      clearTimeout(this._exitingItems.get(entityId));
    }
    
    const itemEl = listEl.querySelector(`[data-entity="${entityId}"]`);
    if (!itemEl || itemEl.classList.contains('pac-item--exiting')) return;
    
    itemEl.classList.add('pac-item--exiting');
    
    // Remove after animation completes
    const timeout = setTimeout(() => {
      itemEl.remove();
      this._exitingItems.delete(entityId);
    }, 250);
    
    this._exitingItems.set(entityId, timeout);
  }

  /**
   * Animate all items out (for empty state)
   */
  _animateOutAll(listEl) {
    const items = listEl.querySelectorAll('.pac-item:not(.pac-item--exiting)');
    
    items.forEach(itemEl => {
      const entityId = itemEl.dataset.entity;
      if (entityId) {
        this._animateOut(listEl, entityId);
      }
    });
    
    // Show empty message after animations complete
    setTimeout(() => {
      if (this._activityList.length === 0) {
        const existing = listEl.querySelector('.pac-empty');
        if (!existing) {
          const emptyEl = document.createElement('div');
          emptyEl.className = 'pac-empty';
          emptyEl.textContent = 'No activity';
          listEl.appendChild(emptyEl);
        }
      }
    }, 270);
  }

  /**
   * Reorder items to match sorted order (preserves elements, uses appendChild to move)
   */
  _reorderItems(listEl, sortedItems) {
    // Get current order (excluding exiting items)
    const currentItems = listEl.querySelectorAll('.pac-item:not(.pac-item--exiting)');
    const currentOrder = Array.from(currentItems).map(el => el.dataset.entity);
    const targetOrder = sortedItems.map(item => item.entityId);
    
    // Skip if order matches
    if (currentOrder.length === targetOrder.length && 
        currentOrder.every((id, i) => id === targetOrder[i])) {
      return;
    }
    
    // Move items in correct order - appendChild moves existing elements
    sortedItems.forEach(item => {
      const itemEl = listEl.querySelector(`[data-entity="${item.entityId}"]:not(.pac-item--exiting)`);
      if (itemEl) {
        listEl.appendChild(itemEl);
      }
    });
    
    // Move exiting items to the end (keeps them visible during exit animation)
    const exitingItems = listEl.querySelectorAll('.pac-item--exiting');
    exitingItems.forEach(el => listEl.appendChild(el));
  }

  /**
   * Sort items by floor (highest level first), then by time within each floor
   */
  _sortByFloorThenTime(items) {
    return [...items].sort((a, b) => {
      const floorA = a.floor?.level ?? -1;
      const floorB = b.floor?.level ?? -1;
      
      // Higher floors first
      if (floorB !== floorA) {
        return floorB - floorA;
      }
      
      // Within same floor, most recent first
      return new Date(b.lastChanged) - new Date(a.lastChanged);
    });
  }

  /**
   * Render activity items as HTML (fallback, used for initial render)
   */
  _renderItems(items) {
    if (!items.length) return '';
    
    let lastFloorId = null;
    
    return items.map((item, index) => {
      const elapsed = getSecondsElapsed(item.lastChanged);
      const type = item.state === 'on' ? 'active' : 'recent';
      const colors = this._colorCalculator.getColors(type, elapsed);
      const timeStr = formatElapsedTime(elapsed);
      
      const floorColor = item.floor?.color || 'transparent';
      const currentFloorId = item.floor?.floorId || null;
      
      // Detect floor change for spatial grouping
      const isFloorBreak = index > 0 && currentFloorId !== lastFloorId;
      lastFloorId = currentFloorId;
      
      return `
        <div class="pac-item" 
             style="color: ${colors.text}; opacity: ${colors.opacity}; font-size: ${colors.fontSize};"
             data-floor-break="${isFloorBreak}"
             data-entity="${item.entityId}">
          <div class="pac-item__floor-indicator" style="background: ${floorColor};"></div>
          <span class="pac-item__name">${item.name}</span>
          <span class="pac-item__time" style="color: ${colors.secondary};">${timeStr}</span>
        </div>
      `;
    }).join('');
  }

  /**
   * Card size for Lovelace layout
   */
  getCardSize() {
    return 4;
  }

  /**
   * Static config element for visual editor (stub)
   */
  static getConfigElement() {
    // TODO: Implement visual editor
    return document.createElement('div');
  }

  /**
   * Default config for visual editor
   */
  static getStubConfig() {
    return {
      area_sensors: []
    };
  }
}

customElements.define('presence-activity-card', PresenceActivityCard);

// Register with Home Assistant custom card registry
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'presence-activity-card',
  name: 'Presence Activity Card',
  description: 'Displays real-time presence activity from area sensors',
  preview: false
});