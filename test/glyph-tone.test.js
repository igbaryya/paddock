/**
 * Regression suite for ui/src/glyphTone.js — which favicons get redrawn on the light theme.
 *
 * A near-white mark on the light tile is invisible, so it is classified `light` and painted in
 * ink. A coloured logo, and a picture that already contains a dark drawing, stay `ink`: redrawing
 * those would throw the logo away. The thresholds are the product, so they are locked here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toneOf } from '../ui/src/glyphTone.js';

/** @param {{r: number, g: number, b: number, a?: number, n: number}[]} parts */
function pixels(parts) {
  const total = parts.reduce((sum, part) => sum + part.n, 0);
  const data = new Uint8ClampedArray(total * 4);
  let offset = 0;
  for (const part of parts) {
    for (let i = 0; i < part.n; i += 1) {
      data[offset] = part.r;
      data[offset + 1] = part.g;
      data[offset + 2] = part.b;
      data[offset + 3] = part.a ?? 255;
      offset += 4;
    }
  }
  return data;
}

test('a white glyph on a transparent tile is light', () => {
  const data = pixels([
    { r: 255, g: 255, b: 255, n: 400 },
    { r: 0, g: 0, b: 0, a: 0, n: 800 },
  ]);
  assert.equal(toneOf(data), 'light');
});

test('a pale grey mark, still under 3:1 on the light tile, is light', () => {
  const data = pixels([{ r: 210, g: 210, b: 210, n: 200 }]);
  assert.equal(toneOf(data), 'light');
});

test('a dark glyph is already visible and stays ink', () => {
  const data = pixels([{ r: 30, g: 30, b: 36, n: 200 }]);
  assert.equal(toneOf(data), 'ink');
});

test('a coloured logo stays ink', () => {
  const data = pixels([
    { r: 51, g: 103, b: 145, n: 500 },
    { r: 255, g: 255, b: 255, n: 120 },
  ]);
  assert.equal(toneOf(data), 'ink');
});

test('a pale mark with a real dark drawing inside it stays ink', () => {
  const data = pixels([
    { r: 255, g: 255, b: 255, n: 300 },
    { r: 20, g: 20, b: 24, n: 80 },
  ]);
  assert.equal(toneOf(data), 'ink');
});

test('an empty picture is not treated as a white icon', () => {
  const data = pixels([{ r: 255, g: 255, b: 255, a: 0, n: 100 }]);
  assert.equal(toneOf(data), 'ink');
});
