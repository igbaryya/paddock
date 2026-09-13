/**
 * The status indicator used everywhere a state is shown. The glyph changes with the status as well
 * as the colour, so the state survives colour-blindness, a bad projector and a grayscale
 * screenshot; the status word is always in the accessibility tree even when it is not on screen.
 */

const GLYPHS = {
  running: '●', // filled circle
  starting: '◐', // half-filled, left
  stopping: '◑', // half-filled, right
  partial: '◧', // half-filled square
  stopped: '○', // hollow circle
  crashed: '▲', // triangle
  failed: '✕', // cross
};

/**
 * @param {{status: string, showLabel?: boolean}} props
 */
export default function StatusDot({ status, showLabel = false }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-glyph" aria-hidden="true">
        {GLYPHS[status] ?? '○'}
      </span>
      <span className={showLabel ? 'status-text' : 'sr-only'}>{status}</span>
    </span>
  );
}
