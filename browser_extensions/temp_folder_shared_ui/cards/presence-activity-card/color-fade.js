// /config/www/cards/presence-activity-card/color-fade.js
// Color fade calculations for activity items
// Handles both active (binary threshold) and recent (continuous fade) states

/**
 * Color endpoint definitions
 * These will eventually be read from CSS custom properties (tokens)
 * For now, defined here matching the current card's colors
 */
const COLOR_ENDPOINTS = {
  // Active items (state: on)
  active: {
    fresh: {
      text: { r: 243, g: 137, b: 26, a: 1 },       // Warm orange
      secondary: { r: 247, g: 191, b: 0, a: 0.7 }  // Amber
    },
    stale: {
      text: { r: 250, g: 170, b: 130, a: 0.2 },    // Faded peach
      secondary: { r: 250, g: 170, b: 130, a: 0.2 }
    }
  },
  // Recent items (state: off)
  recent: {
    fresh: {
      text: { r: 255, g: 255, b: 255, a: 1 },      // White
      secondary: { r: 0, g: 200, b: 100, a: 1 }    // Green
    },
    faded: {
      text: { r: 105, g: 105, b: 105, a: 1 },      // Dim gray
      secondary: { r: 120, g: 80, b: 20, a: 1 }    // Brown
    }
  }
};

/**
 * Default behavioral parameters (card config, not tokens)
 */
const DEFAULTS = {
  activeThresholdSeconds: 60,
  recentFadeDurationSeconds: 300,
  fadeCurve: 0.7  // Power curve exponent
};

/**
 * ActivityColorCalculator
 * 
 * Calculates interpolated colors for activity items based on time elapsed.
 * 
 * Usage:
 *   const calc = new ActivityColorCalculator();
 *   const colors = calc.getColors('active', 45);  // 45 seconds since change
 *   // { text: 'rgba(243, 137, 26, 1)', secondary: 'rgba(247, 191, 0, 0.7)', opacity: 1, fontSize: '0.95em' }
 */
export class ActivityColorCalculator {
  constructor(config = {}) {
    this._activeThreshold = config.activeThresholdSeconds ?? DEFAULTS.activeThresholdSeconds;
    this._recentFadeDuration = config.recentFadeDurationSeconds ?? DEFAULTS.recentFadeDurationSeconds;
    this._fadeCurve = config.fadeCurve ?? DEFAULTS.fadeCurve;
    
    // Allow color endpoint overrides
    this._colors = { ...COLOR_ENDPOINTS };
    if (config.colors) {
      this._mergeColors(config.colors);
    }
  }

  /**
   * Get calculated colors for an activity item
   * @param {string} type - 'active' or 'recent'
   * @param {number} secondsElapsed - Seconds since last_changed
   * @returns {Object} { text, secondary, opacity, fontSize }
   */
  getColors(type, secondsElapsed) {
    if (type === 'active') {
      return this._getActiveColors(secondsElapsed);
    } else {
      return this._getRecentColors(secondsElapsed);
    }
  }

  /**
   * Active items: Binary threshold (fresh vs stale)
   */
  _getActiveColors(secondsElapsed) {
    const isFresh = secondsElapsed < this._activeThreshold;
    const endpoints = this._colors.active;
    
    if (isFresh) {
      return {
        text: this._toRgba(endpoints.fresh.text),
        secondary: this._toRgba(endpoints.fresh.secondary),
        opacity: 1,
        fontSize: '1em'
      };
    } else {
      return {
        text: this._toRgba(endpoints.stale.text),
        secondary: this._toRgba(endpoints.stale.secondary),
        opacity: 1,
        fontSize: '1em'
      };
    }
  }

  /**
   * Recent items: Continuous fade with power curve
   */
  _getRecentColors(secondsElapsed) {
    // Clamp progress to 0-1 range
    const rawProgress = Math.min(secondsElapsed / this._recentFadeDuration, 1);
    
    // Apply power curve for non-linear fade
    const progress = Math.pow(rawProgress, this._fadeCurve);
    
    const endpoints = this._colors.recent;
    
    // Interpolate colors
    const text = this._interpolateColor(endpoints.fresh.text, endpoints.faded.text, progress);
    const secondary = this._interpolateColor(endpoints.fresh.secondary, endpoints.faded.secondary, progress);
    
    // Interpolate opacity (1.0 → 0.5)
    const opacity = this._lerp(1.0, 0.5, progress);
    
    // Interpolate font size (0.95em → 0.8em)
    const fontSizeValue = this._lerp(0.95, 0.8, progress);
    const fontSize = `${fontSizeValue.toFixed(2)}em`;
    
    return {
      text: this._toRgba(text),
      secondary: this._toRgba(secondary),
      opacity,
      fontSize
    };
  }

  /**
   * Linear interpolation
   */
  _lerp(start, end, t) {
    return start + (end - start) * t;
  }

  /**
   * Interpolate between two RGBA color objects
   */
  _interpolateColor(from, to, t) {
    return {
      r: Math.round(this._lerp(from.r, to.r, t)),
      g: Math.round(this._lerp(from.g, to.g, t)),
      b: Math.round(this._lerp(from.b, to.b, t)),
      a: this._lerp(from.a, to.a, t)
    };
  }

  /**
   * Convert RGBA object to CSS string
   */
  _toRgba(color) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
  }

  /**
   * Merge custom color overrides
   */
  _mergeColors(overrides) {
    // Deep merge color overrides
    for (const type of ['active', 'recent']) {
      if (overrides[type]) {
        for (const state of Object.keys(overrides[type])) {
          if (this._colors[type][state]) {
            Object.assign(this._colors[type][state], overrides[type][state]);
          }
        }
      }
    }
  }

  /**
   * Update configuration at runtime
   */
  configure(config) {
    if (config.activeThresholdSeconds !== undefined) {
      this._activeThreshold = config.activeThresholdSeconds;
    }
    if (config.recentFadeDurationSeconds !== undefined) {
      this._recentFadeDuration = config.recentFadeDurationSeconds;
    }
    if (config.fadeCurve !== undefined) {
      this._fadeCurve = config.fadeCurve;
    }
    if (config.colors) {
      this._mergeColors(config.colors);
    }
  }

  /**
   * Get current thresholds (for settings display)
   */
  get thresholds() {
    return {
      activeThresholdSeconds: this._activeThreshold,
      recentFadeDurationSeconds: this._recentFadeDuration,
      fadeCurve: this._fadeCurve
    };
  }
}


/**
 * Format elapsed time as human-readable string
 * @param {number} seconds - Elapsed seconds
 * @returns {string} Formatted string (e.g., '45s', '12m', '2h')
 */
export function formatElapsedTime(seconds) {
  if (seconds < 0) return '0s';
  
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  } else {
    return `${Math.floor(seconds / 3600)}h`;
  }
}


/**
 * Calculate seconds elapsed since a timestamp
 * @param {string|Date} timestamp - ISO datetime string or Date object
 * @returns {number} Seconds elapsed (0 if invalid)
 */
export function getSecondsElapsed(timestamp) {
  if (!timestamp) return 0;
  
  const then = new Date(timestamp).getTime();
  const now = Date.now();
  
  if (isNaN(then)) return 0;
  
  return Math.max(0, (now - then) / 1000);
}
