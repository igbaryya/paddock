/**
 * What an image is, read from its bytes. Shared by the favicon cache and Paddock's logo: both take
 * pictures from something that may lie about them — a dev server answering `/favicon.ico` with its
 * HTML shell and a 200, a file renamed to `.png` — so neither trusts a header or a label.
 */

const bytesOf = (...values) => Buffer.from(values);

/** Every type `sniffImageType` can answer, and so every type a stored image may claim. */
export const IMAGE_TYPES = new Set([
  'image/png', 'image/x-icon', 'image/gif', 'image/jpeg', 'image/webp', 'image/svg+xml',
]);

/** Magic numbers, checked in order. SVG has none, so it is recognised from its text below. */
const SIGNATURES = [
  { type: 'image/png', offset: 0, bytes: bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { type: 'image/x-icon', offset: 0, bytes: bytesOf(0x00, 0x00, 0x01, 0x00) },
  { type: 'image/gif', offset: 0, bytes: Buffer.from('GIF8') },
  { type: 'image/jpeg', offset: 0, bytes: bytesOf(0xff, 0xd8, 0xff) },
  { type: 'image/webp', offset: 8, bytes: Buffer.from('WEBP') },
];

/** An XML declaration, comments and a doctype may all come before the root element. */
const SVG_ROOT = /^﻿?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i;

/** @param {Buffer} bytes @returns {string|null} one of IMAGE_TYPES, or null for anything else */
export function sniffImageType(bytes) {
  const signature = SIGNATURES.find(
    ({ offset, bytes: magic }) => bytes.subarray(offset, offset + magic.length).equals(magic)
  );
  if (signature) return signature.type;
  return SVG_ROOT.test(bytes.subarray(0, 4_096).toString('utf8')) ? 'image/svg+xml' : null;
}
