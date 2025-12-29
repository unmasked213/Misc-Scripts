# Presence Activity Card V2 — Project Context

**Created:** December 29, 2025  
**Purpose:** Comprehensive context for AI assistants continuing this project  
**Status:** Architecture planning complete, ready for implementation

---

## 1. Project Overview

### 1.1 What We're Building

A custom Home Assistant card (`<presence-activity-card>`) that displays real-time activity within a home. This replaces an existing `custom:button-card` + `custom:auto-entities` implementation that has become legacy due to maintenance burden and architectural limitations.

### 1.2 Why This Matters

- **Most viewed card** in the user's dashboard
- **Most essential card** for daily use
- Current version requires manual entity list maintenance when devices are added/moved/removed
- User is phasing out `custom:button-card` entirely—moving toward custom web components
- Toast notification system already uses the better architecture (area sensors); card should catch up

### 1.3 User Context

- **Environment:** Home Assistant on NUC 11 i7, 320,000+ lines of HA code, 10,056 dashboard cards (55% custom)
- **Devices:** Samsung Galaxy M23 5G, iPad 9th gen, Desktop 1440p/1080p
- **Technical level:** Expert in YAML, Jinja2, custom HA cards, Python scripting
- **Philosophy:** Precision over approximation, foundation systems deserve enterprise-grade quality
- **Communication preference:** Direct, no pleasantries, comprehensive answers

---

## 2. Current Implementation (Legacy)

### 2.1 Active Entities Card

Displays currently active motion/occupancy/vibration sensors with:
- Binary color threshold (60 seconds): fresh = orange/amber, stale = faded peach
- Time-since-activation display (Xs, Xm, Xh format)
- Sorted by `last_changed`, limited to 5 items
- Extensive exclusion list for FP2 zone sensors, computed presence sensors, etc.

**Architecture:** `custom:button-card` wrapper → `custom:auto-entities` filter → `custom:template-entity-row` items

**Problems:**
- Hardcoded entity exclusion lists require manual maintenance
- Duplicates logic that area sensors already handle
- Built on third-party cards being phased out

### 2.2 Recently Active Card

Displays recently-deactivated sensors with:
- Continuous color fade over 300 seconds (power curve 0.7)
- White → dimgray for primary text
- Green → orange-brown for secondary text
- Opacity and font-size also fade
- Gradient mask for visual fade at edges
- Sorted by `last_changed`, limited to 20 items

**Same architectural problems as active card.**

### 2.3 Current Card YAML

**Active list card:**
```yaml
type: custom:button-card
update_timer: 1s
custom_fields:
  active_list:
    card:
      type: custom:auto-entities
      card:
        type: entities
        show_header_toggle: false
        card_mod:
          style: |
            ha-card {
              max-height: 100%;
              overflow-y: auto;
              scrollbar-width: none;
              -ms-overflow-style: none;
              border: none;
              box-shadow: none;
              width: 100% !important;
              padding: 0px;
              background: rgba(0,0,0,0);
            }
            ha-card::-webkit-scrollbar { 
              display: none; 
            }
            ha-card::before {
              backdrop-filter: none !important;
              box-shadow: none !important;
            }              
            #states div { 
              margin-bottom: 8px; 
              margin-left: -40px; 
            }
      filter:
        include:
          - entity_id: binary_sensor.contact_sensor_e778
            state: "on"
          - entity_id: input_boolean.test_boolean
            state: "on"
            options:
              type: custom:template-entity-row
              name: |
                {{ state_attr(config.entity, 'friendly_name') | title }}
              secondary: >
                {% set last_changed = as_timestamp(states[config.entity].last_changed) %}
                {% set now = as_timestamp(now()) %}
                {% set diff = now - last_changed %}
                {% if diff < 60 %}{{ diff | round(0) }}s
                {% elif diff < 3600 %}{{ (diff / 60) | round(0) }}m
                {% else %}{{ (diff / 3600) | round(0) }}h{% endif %}
              icon: none
              state: " "
              card_mod:
                style: |
                  :host {
                    --secondary-text-color: {% if (as_timestamp(now()) - as_timestamp(states[config.entity].last_changed)) > 60 %} rgba(250, 170, 130, 0.2) {% else %} rgba(247, 191, 0, 0.7) {% endif %};
                    color: {% if (as_timestamp(now()) - as_timestamp(states[config.entity].last_changed)) > 60 %} rgba(250, 170, 130, 0.2) {% else %} rgba(243, 137, 26, 1) {% endif %};
                  }
                  .secondary {
                    color: var(--secondary-text-color);
                    font-size: 0.75em;
                    letter-spacing: 1px;
                    padding-left: 2px;
                    padding-top: 1px;
                  }
          - domain: binary_sensor
            state: "on"
            attributes:
              device_class: /(vibration|motion|occupancy)/
            options:
              type: custom:template-entity-row
              # ... same template as above
        exclude:
          - attributes:
              type: browser_mod
          - entity_id: binary_sensor.presence_sensor_fp2_1780_presence_sensor*
          - entity_id: binary_sensor.presence_sensor_fp2_07a0_presence_sensor_1_2
          # ... extensive exclusion list
      sort:
        method: last_changed
        reverse: true
        count: 5
      show_empty: false
styles:
  custom_fields:
    active_list:
      - text-align: left
      - font-size: 1em
      - position: absolute
      - left: 10px
      - bottom: 0
  card:
    - height: 250px
    - background: none
    - box-shadow: none
    - border: none
```

---

## 3. Area Sensor Architecture

The user has built a sophisticated presence detection system using template sensors. These are the data source for V2.

### 3.1 Area Presence Sensor Structure

Each area has a presence sensor (e.g., `binary_sensor.presence_bedroom`) with attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `area_id` | string | HA area identifier (e.g., "bedroom_2") |
| `area_name` | string | Human-readable name |
| `edge_hold_seconds` | int | How long door events extend presence |
| `contributing_sensors` | JSON array | All sensors that feed this presence sensor |
| `active_sensors` | JSON array | Currently active sensors (state: on) |
| `recent_edge_sensors` | JSON array | Door sensors that fired within edge_hold window |
| `last_movement` | ISO datetime | Most recent sensor state change |
| `last_updated_sensor` | entity_id | Which sensor triggered most recently |
| `lux` | float | Average illuminance from area's lux sensors |

### 3.2 Key Design Principles

- **Steady sensors:** presence/occupancy/motion (continuous state)
- **Edge sensors:** doors (momentary events with hold window)
- **Auto-exclusion:** Raw door contributor sensors excluded to prevent double-counting
- **Area-based:** Sensors assigned to HA areas; presence sensor aggregates per-area

### 3.3 Existing Area Sensors

```yaml
- binary_sensor.presence_bedroom    # area: bedroom_2
- binary_sensor.presence_office     # area: office  
- binary_sensor.presence_floor_02_2 # area: 2nd_floor (landing/stairs)
- binary_sensor.presence_floor_01   # area: 1st_floor
- binary_sensor.presence_floor_00   # area: ground_floor
```

### 3.4 Floor Registry

HA natively supports floor-area relationships:
- Areas have a `floor` field linking to floor registry
- Floors have: `floor_id`, `name`, `level` (numeric for ordering), `icon`, `aliases`
- Example: `floor_02` → "Floor 02", level: 2, areas: [2nd_floor, bedroom_2, office]

**V2 will query floor registry via WebSocket API, not parse area_id patterns.**

---

## 4. Toast Notification System

The user's toast system demonstrates the target architecture. The card should align with this.

### 4.1 Automation Trigger Pattern

```yaml
trigger:
  - trigger: state
    entity_id:
      - binary_sensor.presence_bedroom
      - binary_sensor.presence_office
      # ... area sensors
    attribute: last_movement
```

Triggers on `last_movement` attribute change, extracts `last_updated_sensor` to identify which raw sensor fired.

### 4.2 Toast Display

- Shows friendly_name of the triggering sensor
- Animated screen border (now handles what the removed card border used to do)
- Rate-limited PC notifications
- Browser_mod integration for cross-device display

---

## 5. Shared UI Design System

V2 must comply with the user's token-driven design system.

### 5.1 Core Files

| File | Lines | Purpose |
|------|-------|---------|
| `foundation.js` | 642 | Token definitions (READ-ONLY, single source of truth) |
| `components.js` | 1,902 | UI components (buttons, FABs, inputs, etc.) |
| `toggles.js` | 343 | Toggle switches |
| `tooltips.js` | 632 | Tooltip system |
| `helpers.js` | 169 | DOM utilities |
| `utilities.js` | 267 | Pure functions |

### 5.2 Key Constraints

1. **Token-only values:** All spacing, colors, radii, timing from `foundation.js`
2. **Fixed geometry:** Components have immutable dimensions
3. **State model:** Identical hover/pressed/active/focus/disabled across all components
4. **Theme equality:** Light and dark themes receive equal quality
5. **4px spacing grid:** `--ui-space-1` through `--ui-space-10`
6. **adoptedStyleSheets:** No `<style>` tag injection

### 5.3 Relevant Tokens

**Spacing:**
- `--ui-space-1`: 4px
- `--ui-space-2`: 8px
- `--ui-space-3`: 12px
- `--ui-space-4`: 16px
- `--ui-space-6`: 24px

**Motion:**
- `--ui-motion-fast`: 120ms cubic-bezier(0.2, 0, 0.2, 1)
- `--ui-motion-med`: 240ms cubic-bezier(0.2, 0, 0.2, 1)
- `--ui-motion-slow`: 360ms cubic-bezier(0.2, 0, 0.2, 1)

**Colors (semantic):**
- `--ui-text`, `--ui-text-mute`, `--ui-text-strong`
- `--ui-accent`, `--ui-success`, `--ui-error`, `--ui-warning`
- `--ui-elevated-0` through `--ui-elevated-4`

### 5.4 New Tokens Needed

Activity-specific colors (to be added to foundation.js). **Note:** Thresholds are behavioral parameters, not presentation primitives—they belong in card config, not the token system.

```css
/* Active items (state: on, < threshold) */
--ui-activity-active-text: rgb(243, 137, 26);
--ui-activity-active-secondary: rgb(247, 191, 0);

/* Stale active items (state: on, > threshold) */
--ui-activity-stale-text: rgba(250, 170, 130, 0.2);
--ui-activity-stale-secondary: rgba(250, 170, 130, 0.2);

/* Recent items (state: off, fresh) */
--ui-activity-recent-text: rgb(255, 255, 255);
--ui-activity-recent-secondary: rgb(0, 200, 100);

/* Faded recent items (state: off, old) */
--ui-activity-faded-text: rgb(105, 105, 105);
--ui-activity-faded-secondary: rgb(120, 80, 20);

/* Fade curve exponent (presentation, not behavioral) */
--ui-activity-fade-curve: 0.7;
```

**Behavioral defaults (card config, not tokens):**
```javascript
const DEFAULTS = {
  activeThresholdSeconds: 60,
  recentFadeDurationSeconds: 300,
  itemLimit: 20,  // Single limit for unified list
  fadeCurve: 0.7
};
```

---

## 6. V2 Scope

### 6.1 In Scope

- Custom web component (`<presence-activity-card>`)
- Query area sensors directly (eliminate exclusion list maintenance)
- **Unified chronological list** (no separate active/recent sections)
- Color differentiation: active (vivid orange) vs recent (fading white-to-gray)
- Continuous color fade system with power curve
- Door events inline in the feed
- Floor context via HA floor registry API
- Floor visualization (colored accent lines + spatial grouping by floor)
- Floor colors via HSL rotation with config override
- 1-second update interval for smooth time displays
- Inline settings panel for runtime configuration (not shared `<ui-modal>`)
- Shared UI compliant structure
- Data layer separated from presentation (future-proofing)

### 6.2 Not In Scope (V3+)

- Direction of travel detection
- Predicted path visualization
- Floorplan integration

### 6.3 Design Principles

From user: *"The whole point of the card is to convey exactly the right info at exactly the right moment in a way that can be both read and (more importantly) understood by the user as fast as possible."*

- Visually minimal (the simplicity is intentional)
- Information density over decoration
- Ambient floor context (not prominent labels)
- Sub-second perceived responsiveness

---

## 7. Technical Decisions

### 7.1 Data Strategy

**Sensor-centric approach (decided):**
- Card maintains list of area presence sensor entity IDs in config
- On `hass` update, reads `active_sensors`, `recent_edge_sensors`, `last_updated_sensor` attributes
- Aggregates across all areas, deduplicates, sorts by recency
- No exclusion lists needed—area sensors already filter

### 7.2 Floor Resolution

**HA API approach (decided):**
- Call `config/area_registry/list` → area → floor mappings
- Call `config/floor_registry/list` → floor metadata (name, level)
- Cache on initialization (floors/areas stable during session)
- Floor info is presentation-layer concern, not sensor concern

### 7.3 Floor Display

**Unified list with floor grouping (decided):**
- Single chronological list, no separate active/recent sections
- Items sorted by floor level (highest first), then by time within each floor
- Thin vertical accent line on left edge, color varies by floor (HSL rotation)
- Subtle spacing between floor groups (`margin-top` on floor break)
- No text headers—visual rhythm only
- Gradient mask at bottom for fade-out effect
- Color differentiates active (vivid) from recent (fading)

### 7.4 Update Frequency

**1-second internal timer (decided):**
- Essential for smooth color fade animation
- Provides psychological reassurance (timestamp visibly updating)
- Enables granular inference for future direction detection

### 7.5 Configuration

**Minimal config, settings panel for runtime (decided):**

```yaml
type: custom:presence-activity-card
area_sensors:
  - binary_sensor.presence_bedroom
  - binary_sensor.presence_office
  - binary_sensor.presence_floor_02_2
  - binary_sensor.presence_floor_01
  - binary_sensor.presence_floor_00
```

**Settings UI approach (revised):** Building `<ui-modal>` as a proper shared UI component while shipping this card is scope stacking. For V2, use an inline expandable settings panel or minimal card-specific modal—not the canonical shared UI implementation. Proper `<ui-modal>` becomes a separate task.

Panel exposes: active threshold, fade duration, item limit, floor color overrides, display density.

### 7.6 Floor Color Strategy

**HSL rotation with config override (decided):**
- Default: Base hue from accent token, rotate by fixed increment per floor level
- Guarantees distinct colors, scales to any floor count
- Config allows manual override per floor if generated colors clash
- Keeps minimal config while allowing control when needed

---

## 8. Component Architecture

### 8.1 File Structure

```
www/cards/presence-activity-card/
├── presence-activity-card.js    # Main card, HA integration, config
├── activity-feed.js             # Core feed component (potentially reusable)
├── activity-item.js             # Single item renderer
├── floor-resolver.js            # HA API floor lookups, caching
├── color-fade.js                # Fade calculation logic
└── settings-panel.js            # Card-specific settings UI (inline panel, not shared modal)
```

### 8.2 Data Flow

```
hass state updates
       ↓
area sensor attributes read
       ↓
floor-resolver enriches with floor metadata
       ↓
normalized activity list (sorted, deduplicated)
       ↓
activity-feed component
       ↓
activity-item renderers (with color-fade calculations)
```

### 8.3 Component Skeleton Pattern

From shared UI `component_authoring.md`:

```javascript
import '/local/base/foundation.js';

const componentStyles = new CSSStyleSheet();
componentStyles.replaceSync(`/* token-only CSS */`);

class PresenceActivityCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._floorCache = null;
    this._updateInterval = null;
  }

  static getConfigElement() { /* editor */ }
  static getStubConfig() { /* defaults */ }

  setConfig(config) {
    this._config = config;
    if (this.isConnected) this.render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this.isConnected) this.updateActivityList();
  }

  connectedCallback() {
    this.shadowRoot.adoptedStyleSheets = [window.uiFoundation, componentStyles];
    this.render();
    this._startUpdateTimer();
  }

  disconnectedCallback() {
    this._stopUpdateTimer();
  }

  _startUpdateTimer() {
    this._updateInterval = setInterval(() => this.updateVisuals(), 1000);
  }

  _stopUpdateTimer() {
    if (this._updateInterval) clearInterval(this._updateInterval);
  }

  render() { /* initial DOM structure */ }
  updateActivityList() { /* process hass data */ }
  updateVisuals() { /* apply current state to DOM */ }

  getCardSize() { return 4; }
}

customElements.define('presence-activity-card', PresenceActivityCard);
```

---

## 9. Door Integration

### 9.1 Current Door Cards

User has sophisticated door cards with:
- SVG door visualization (open/closed state)
- Battery/signal quality badges
- Hysteresis logic (1.2s visual, 2.5s badge)
- Elapsed time display
- Unified door sensors combining contact + vibration

### 9.2 V2 Integration

Doors appear inline in activity feed:
- Use door entity's `last_state_change` attribute
- Display friendly_name (with "Door: " prefix stripped)
- Same color fade logic as other items
- Door card SVG remains separate (will migrate to shared UI later)

---

## 10. Open Questions

### 10.1 Resolved

| Question | Decision |
|----------|----------|
| Custom component vs button-card overlay | Custom component |
| Token strategy for colors | New activity tokens in foundation.js (colors only, not thresholds) |
| Floor identification method | HA floor registry API |
| Update frequency | 1-second internal timer |
| Config interface | Minimal YAML + inline settings panel |
| Component scope | Bespoke first, design for extraction |
| Floor color assignments | HSL rotation from accent with config override |
| Settings UI implementation | Card-specific inline panel (not shared `<ui-modal>`) |
| Active vs recent visual separation | **Unified list**, sorted by floor then time, differentiated by color only |

### 10.2 Still Open

| Question | Options | Notes |
|----------|---------|-------|
| (none currently) | | |

---

## 11. Next Steps

1. **Draft component skeleton** with data layer (floor resolver, area sensor querying, activity list normalization)
2. **Validate architecture** before committing to visual implementation
3. **Implement floor resolver** with WebSocket API calls
4. **Build activity item renderer** with color fade logic
5. **Add settings panel** (card-specific, inline expandable)
6. **Token additions** to foundation.js for activity colors (endpoints only, not thresholds)
7. **Testing** across devices and themes

---

## 12. ChatGPT Review Notes (December 2025)

External review validated the architecture with these refinements:

1. **Threshold tokens removed:** `60s` and `300s` are behavioral parameters, not presentation primitives. They belong in card config defaults, not foundation.js. Only color endpoints and fade curve are tokens.

2. **Modal scope avoided:** Building `<ui-modal>` as shared UI while shipping this card is scope stacking. V2 uses a card-specific settings panel. Proper shared modal becomes separate task.

3. **Floor colors:** HSL rotation from accent is least-bad option for auto-generation. Config override available for manual control.

4. **Architecture validated:** Area sensors as sole data source collapses maintenance problems. Floor resolution via registry API is correct abstraction. Data/presentation separation enables future extensibility.

5. **Risk identified:** Scope discipline during implementation is the primary remaining failure mode, not design.

6. **Unified list decision:** Two-section layout (active bottom, recent top) replaced with single chronological list. Rationale:
   - Color already distinguishes active from recent—physical separation duplicates information
   - Unified list creates continuity: when sensor turns off, it stays in place and fades (how time works)
   - Essential for future direction-of-travel features (sequential items show path)
   - Floor grouping cleaner with one list vs two parallel groupings
   - Layout: highest floor at top, items sorted by floor then time within floor
   - Gradient mask at bottom provides fade-to-nothing effect

---

## 12. Reference Code

### 12.1 Area Sensor Template (Abbreviated)

```yaml
- name: "Presence: Bedroom"
  unique_id: presence_area_bedroom
  device_class: occupancy
  variables:
    area: bedroom_2
    edge_hold: 30
  state: >
    {% set AREA = area %}
    {% set HOLD = edge_hold | int %}
    {% set ents = area_entities(AREA) or [] %}
    # ... filtering logic for steady + edge sensors
    {{ any_steady_on or recent_edge }}
  attributes:
    area_id: "{{ area }}"
    area_name: "{{ area_name(area) }}"
    active_sensors: >
      # JSON array of currently-on sensors
    last_updated_sensor: >
      # entity_id of most recently changed sensor
    last_movement: >
      # ISO datetime of most recent change
```

### 12.2 Toast Automation Pattern

```yaml
trigger:
  - trigger: state
    entity_id:
      - binary_sensor.presence_bedroom
      # ... area sensors
    attribute: last_movement
actions:
  - variables:
      sensor_entity: "{{ trigger.to_state.attributes.last_updated_sensor }}"
      sensor_name: "{{ state_attr(sensor_entity, 'friendly_name') }}"
  - action: script.show_toast_notification
    data:
      message: "{{ sensor_name }}"
```

---

## 13. Files to Request

If continuing in a new chat, request these files for full context:

1. **Shared UI docs:** CLAUDE.md, spec.md, implementation_guide.md, component_authoring.md
2. **Shared UI code:** foundation.js, components.js
3. **User's existing code:** Area sensor YAML (presence_detection.yaml), door sensor YAML (doors.yaml), toast script

---

## 14. Communication Notes

- User prefers direct communication, no apologies or thanks
- When user says "artifact" → immediately create, no discussion
- Precision over approximation
- Don't use lists/bullets unless present in user input (for prose responses)
- User's name: Sir (referenced in memory context)
- Partner: Enhy
- Dogs: Winnie and Mabel (West Highland Terriers)
