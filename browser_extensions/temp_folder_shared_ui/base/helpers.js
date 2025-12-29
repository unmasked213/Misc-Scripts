// /config/www/base/helpers.js
// Shared UI component initialization helpers
// Version: 1
// Updated: 11-12-2024

/**
 * Call a Home Assistant service
 * @param {Object} hass - Home Assistant object
 * @param {string} domain - Service domain (e.g., "script", "light")
 * @param {string} service - Service name (e.g., "turn_on", "upload_document")
 * @param {Object} serviceData - Service data/parameters
 * @returns {Promise} Promise that resolves when service call completes
 */
export async function callService(hass, domain, service, serviceData = {}) {
  return hass.callService(domain, service, serviceData);
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after the specified time
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Initialize all input fields within a given root element
 * @param {ShadowRoot|HTMLElement} root - The root element to search for inputs
 */
export function initInputs(root) {
  const inputs = root.querySelectorAll(".ui-input-field");

  inputs.forEach((input) => {
    const pill = input.closest(".ui-input-pill");
    if (!pill) return;

    // Set initial state
    if (input.value) {
      pill.classList.add("has-value");
    }

    // Handle changes
    input.addEventListener("input", () => {
      if (input.value) {
        pill.classList.add("has-value");
      } else {
        pill.classList.remove("has-value");
      }
    });
  });
}

/**
 * Initialize all sliders within a given root element
 * @param {ShadowRoot|HTMLElement} root - The root element to search for sliders
 */
export function initSliders(root) {
  const sliders = root.querySelectorAll(".ui-slider");

  sliders.forEach((slider) => {
    const input = slider.querySelector(".ui-slider__input");
    const container = slider.querySelector(".ui-slider__container");
    const trackActive = slider.querySelector(".ui-slider__track-active");
    const trackInactive = slider.querySelector(".ui-slider__track-inactive");
    const thumb = slider.querySelector(".ui-slider__thumb");
    const valueBubble = thumb?.querySelector(".ui-slider__value");

    if (!input || !container || !trackActive || !trackInactive || !thumb || !valueBubble) return;

    const min = parseFloat(input.min);
    const max = parseFloat(input.max);

    const updateSlider = (value) => {
      // Get fresh width each time in case of resize
      const containerWidth = container.offsetWidth;
      if (containerWidth === 0) return; // Skip if not laid out yet
      
      const percentage = ((value - min) / (max - min)) * 100;
      const thumbPosition = (percentage / 100) * containerWidth;
      
      // Thumb and gap dimensions
      const styles = getComputedStyle(slider);
      const thumbWidth = parseFloat(styles.getPropertyValue('--ui-slider-thumb-width-rest')) || 6;
      const gap = parseFloat(styles.getPropertyValue('--ui-slider-gap-rest')) || 4;
      
      // Calculate track widths with gaps
      const activeWidth = Math.max(0, thumbPosition - gap);
      const inactiveStart = thumbPosition + gap;
      const inactiveWidth = Math.max(0, containerWidth - inactiveStart);

      // Update tracks
      trackActive.style.width = `${activeWidth}px`;
      trackInactive.style.width = `${inactiveWidth}px`;

      // Update thumb position
      thumb.style.left = `${thumbPosition}px`;

      // Update value bubble
      valueBubble.textContent = Math.round(value);

      // Handle edge carving
      const edgeThreshold = 20;

      if (thumbPosition < edgeThreshold) {
        // Near left edge - fully rounded right side of active track
        trackActive.style.borderTopRightRadius = 'var(--ui-slider-track-radius, 12px)';
        trackActive.style.borderBottomRightRadius = 'var(--ui-slider-track-radius, 12px)';
        trackInactive.style.borderTopLeftRadius = 'var(--ui-slider-track-radius, 12px)';
        trackInactive.style.borderBottomLeftRadius = 'var(--ui-slider-track-radius, 12px)';
      } else if (thumbPosition > containerWidth - edgeThreshold) {
        // Near right edge - fully rounded left side of inactive track
        trackActive.style.borderTopRightRadius = 'var(--ui-slider-track-radius, 12px)';
        trackActive.style.borderBottomRightRadius = 'var(--ui-slider-track-radius, 12px)';
        trackInactive.style.borderTopLeftRadius = 'var(--ui-slider-track-radius, 12px)';
        trackInactive.style.borderBottomLeftRadius = 'var(--ui-slider-track-radius, 12px)';
      } else {
        // Middle - tight carving (4px radius on inner edges)
        trackActive.style.borderTopRightRadius = 'var(--ui-slider-thumb-radius, 4px)';
        trackActive.style.borderBottomRightRadius = 'var(--ui-slider-thumb-radius, 4px)';
        trackInactive.style.borderTopLeftRadius = 'var(--ui-slider-thumb-radius, 4px)';
        trackInactive.style.borderBottomLeftRadius = 'var(--ui-slider-thumb-radius, 4px)';
      }
    };

    // Initial update after layout completes
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateSlider(parseFloat(input.value));
      });
    });

    // Handle input changes
    input.addEventListener("input", (e) => {
      const value = parseFloat(e.target.value);
      updateSlider(value);
    });

    // Handle press states
    const onStart = () => {
      slider.classList.add("ui-slider--pressed");
      // Disable transitions during dragging for instant responsiveness (< 16ms target)
      thumb.style.transition = 'width var(--ui-slider-motion-duration) var(--ui-slider-motion-easing)';
      trackActive.style.transition = 'none';
      trackInactive.style.transition = 'none';
    };

    const onEnd = () => {
      slider.classList.remove("ui-slider--pressed");
      // Re-enable transitions after dragging
      thumb.style.transition = '';
      trackActive.style.transition = '';
      trackInactive.style.transition = '';
    };

    input.addEventListener("mousedown", onStart);
    input.addEventListener("mouseup", onEnd);
    input.addEventListener("mouseleave", onEnd);
    input.addEventListener("touchstart", onStart, { passive: true });
    input.addEventListener("touchend", onEnd);
    input.addEventListener("touchcancel", onEnd);

    // Handle window resize
    const resizeObserver = new ResizeObserver(() => {
      updateSlider(parseFloat(input.value));
    });
    resizeObserver.observe(container);
  });
}