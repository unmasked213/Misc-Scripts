/* ========================================================================
 *  UTILITIES — PURE FUNCTIONS
 * ========================================================================
 *
 *  Pure utility functions with no side effects. These take inputs and
 *  return outputs without touching DOM, state, or external systems.
 *
 *  Use these for data transformation, formatting, validation, and
 *  calculations across your custom cards.
 *
 * ======================================================================== */

// -----------------------------------------------------------------------
// TIME & DATE
// -----------------------------------------------------------------------

/**
 * Format seconds into human-readable duration
 * @param {number} seconds - Total seconds
 * @returns {string} Formatted string like "2h 34m" or "45s"
 */
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Get relative time string (e.g. "2 hours ago", "in 5 minutes")
 * @param {Date|string|number} timestamp - Date to compare
 * @returns {string} Relative time description
 */
export function getRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format timestamp to HH:MM:SS
 * @param {Date|string|number} timestamp - Time to format
 * @returns {string} Formatted time string
 */
export function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit'
  });
}

// -----------------------------------------------------------------------
// NUMBERS & FORMATTING
// -----------------------------------------------------------------------

/**
 * Format number with thousands separators
 * @param {number} num - Number to format
 * @returns {string} Formatted string like "1,234,567"
 */
export function formatNumber(num) {
  return new Intl.NumberFormat('en-GB').format(num);
}

/**
 * Format bytes into human-readable size
 * @param {number} bytes - Byte count
 * @param {number} decimals - Decimal places (default 2)
 * @returns {string} Formatted string like "1.23 MB"
 */
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
}

/**
 * Clamp number between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linear interpolation between two values
 * @param {number} start - Start value
 * @param {number} end - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
export function lerp(start, end, t) {
  return start + (end - start) * clamp(t, 0, 1);
}

// -----------------------------------------------------------------------
// STRING MANIPULATION
// -----------------------------------------------------------------------

/**
 * Truncate string with ellipsis
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length before truncation
 * @returns {string} Truncated string
 */
export function truncate(str, maxLength) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

/**
 * Convert entity_id to readable name
 * @param {string} entityId - Entity ID like "sensor.bedroom_temperature"
 * @returns {string} Readable name like "Bedroom Temperature"
 */
export function entityIdToName(entityId) {
  return entityId
    .split('.')[1]
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Slugify string for use as ID or class name
 * @param {string} str - String to slugify
 * @returns {string} Slugified string
 */
export function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '_')
    .replace(/^-+|-+$/g, '');
}

// -----------------------------------------------------------------------
// ARRAY & OBJECT OPERATIONS
// -----------------------------------------------------------------------

/**
 * Group array of objects by key
 * @param {Array} array - Array to group
 * @param {string} key - Key to group by
 * @returns {Object} Grouped object
 */
export function groupBy(array, key) {
  return array.reduce((result, item) => {
    const group = item[key];
    if (!result[group]) result[group] = [];
    result[group].push(item);
    return result;
  }, {});
}

/**
 * Sort array by nested property path
 * @param {Array} array - Array to sort
 * @param {string} path - Dot-notation path like "user.name"
 * @param {boolean} descending - Sort descending (default false)
 * @returns {Array} Sorted array
 */
export function sortByPath(array, path, descending = false) {
  const getValue = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
  return [...array].sort((a, b) => {
    const aVal = getValue(a, path);
    const bVal = getValue(b, path);
    const result = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
    return descending ? -result : result;
  });
}

/**
 * Deep clone object (simple, no functions/dates/etc)
 * @param {*} obj - Object to clone
 * @returns {*} Cloned object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// -----------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------

/**
 * Check if value is empty (null, undefined, empty string/array/object)
 * @param {*} value - Value to check
 * @returns {boolean} True if empty
 */
export function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Validate entity_id format
 * @param {string} entityId - Entity ID to validate
 * @returns {boolean} True if valid
 */
export function isValidEntityId(entityId) {
  return /^[a-z_]+\.[a-z0-9_]+$/.test(entityId);
}

// -----------------------------------------------------------------------
// COLOR MANIPULATION
// -----------------------------------------------------------------------

/**
 * Convert hex color to RGB object
 * @param {string} hex - Hex color like "#ff0000" or "ff0000"
 * @returns {Object} RGB object {r, g, b}
 */
export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Calculate relative luminance of RGB color
 * @param {Object} rgb - RGB object {r, g, b}
 * @returns {number} Luminance value (0-1)
 */
export function getLuminance(rgb) {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(val => {
    val = val / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Determine if color is light or dark
 * @param {string} hex - Hex color
 * @returns {boolean} True if light, false if dark
 */
export function isLightColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return getLuminance(rgb) > 0.5;
}