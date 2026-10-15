/**
 * A favicon or logo on an icon tile.
 *
 * The picture is shown as it was designed. The exception is a mark that is itself near-white:
 * on the light theme that mark is redrawn in the ink colour, because a white helmet on a white
 * tile cannot be seen. The dark theme keeps the original, where white on the dark tile is already
 * the contrast. Colour in the picture is left alone, so a logo is not flattened to grey.
 */
import { useEffect, useState } from 'react';
import { toneOf } from '../glyphTone.js';
import { useTheme } from '../useTheme.js';

/** Resolved tones, so a second tile of the same picture does not sample it again. */
const tones = new Map();
/** @type {Map<string, Promise<'light'|'ink'>>} */
const inflight = new Map();

/**
 * Draw the picture small and ask whether it is a light glyph. A picture that will not decode, or
 * a canvas that will not give its pixels up, stays ink — showing the original is the safe result.
 * @param {string} src
 * @returns {Promise<'light'|'ink'>}
 */
function sample(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const size = 48;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        resolve('ink');
        return;
      }
      context.drawImage(image, 0, 0, size, size);
      try {
        resolve(toneOf(context.getImageData(0, 0, size, size).data));
      } catch {
        resolve('ink');
      }
    };
    image.onerror = () => resolve('ink');
    image.src = src;
  });
}

/** @param {string} src @returns {Promise<'light'|'ink'>} */
function loadTone(src) {
  const known = tones.get(src);
  if (known) return Promise.resolve(known);
  let job = inflight.get(src);
  if (!job) {
    job = sample(src).then((tone) => {
      tones.set(src, tone);
      inflight.delete(src);
      return tone;
    });
    inflight.set(src, job);
  }
  return job;
}

/** @param {string|undefined} src @returns {'light'|'ink'|null} null while the picture is still being read */
function useGlyphTone(src) {
  const [tone, setTone] = useState(() => (src ? tones.get(src) ?? null : null));

  useEffect(() => {
    if (!src) return undefined;
    const known = tones.get(src);
    if (known) {
      setTone(known);
      return undefined;
    }
    let live = true;
    loadTone(src).then((next) => {
      if (live) setTone(next);
    });
    return () => {
      live = false;
    };
  }, [src]);

  return tone;
}

/**
 * Quoted for CSS `url()`, so a base64 payload cannot close the function.
 * @param {string} src
 */
const maskOf = (src) => `url(${JSON.stringify(src)})`;

/**
 * Decorative wherever it is used: the name beside the tile already says what it is.
 * @param {{src: string, title?: string}} props
 */
export default function Glyph({ src, title }) {
  const { resolved } = useTheme();
  const tone = useGlyphTone(src);

  if (resolved === 'light' && tone === 'light') {
    return <span className="glyph" title={title} style={{ '--glyph': maskOf(src) }} />;
  }
  return <img src={src} alt="" title={title} />;
}
