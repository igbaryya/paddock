/**
 * Whether a favicon is a light glyph that would disappear on the light theme's tile.
 *
 * Sampled from the picture's pixels, not from its file type: a white helmet and a white wordmark
 * are the same problem, and a coloured logo is not. A mark counts as light when nearly every
 * visible pixel is a pale neutral. Colour, and a real dark drawing inside the picture, are left
 * as they are — flattening either of those would throw away the logo.
 */

/** Below this alpha the pixel is the tile showing through, not part of the mark. */
const VISIBLE_ALPHA = 32;

/** Pale neutrals at this lightness or above fail 3:1 against the light tile. */
const LIGHT_LIGHTNESS = 0.58;
const LIGHT_SATURATION = 0.16;

/** A drawing this dark is already visible, and it is part of the picture. */
const DARK_LIGHTNESS = 0.4;
const DARK_SHARE = 0.12;

/** Saturated pixels are a logo, not a monochrome glyph. */
const COLOR_SATURATION = 0.22;
const COLOR_SHARE = 0.08;

/** How much of the visible mark must be pale before it is redrawn. */
const LIGHT_SHARE = 0.85;

/** Fewer visible pixels than this is an empty image, not a white one. */
const MIN_VISIBLE = 8;

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{lightness: number, saturation: number}}
 */
function hsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return { lightness, saturation };
}

/**
 * @param {Uint8ClampedArray} pixels RGBA, row-major
 * @returns {'light'|'ink'}
 */
export function toneOf(pixels) {
  let visible = 0;
  let pale = 0;
  let dark = 0;
  let colored = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < VISIBLE_ALPHA) continue;
    visible += 1;
    const { lightness, saturation } = hsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (lightness >= LIGHT_LIGHTNESS && saturation <= LIGHT_SATURATION) pale += 1;
    else if (lightness <= DARK_LIGHTNESS) dark += 1;
    else if (saturation >= COLOR_SATURATION) colored += 1;
  }

  if (visible < MIN_VISIBLE) return 'ink';
  if (dark / visible > DARK_SHARE) return 'ink';
  if (colored / visible > COLOR_SHARE) return 'ink';
  if (pale / visible >= LIGHT_SHARE) return 'light';
  return 'ink';
}
