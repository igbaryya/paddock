/**
 * Keyboard focus for the layers that claim the whole window. One copy, because a dialog that keeps Tab
 * inside and a palette that lets it walk into the sidebar behind are the same `aria-modal` promise
 * kept by one and broken by the other.
 */

/** Everything Tab can land on. Disabled controls and `tabindex="-1"` are skipped, as the browser does. */
export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Wraps Tab and Shift+Tab at the edges of `container`, so focus cycles inside it instead of leaving
 * for the page an `aria-modal` layer has declared out of reach.
 * @param {KeyboardEvent} event @param {HTMLElement|null} container
 */
export function keepTabInside(event, container) {
  if (event.key !== 'Tab' || !container) return;
  const stops = [...container.querySelectorAll(FOCUSABLE)];
  if (!stops.length) {
    event.preventDefault();
    return;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  const inside = container.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}
