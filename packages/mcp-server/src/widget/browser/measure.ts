/**
 * The one measurement of how tall the widget wants its frame to be.
 *
 * There used to be two, and they disagreed: the renderer reported
 * `body.scrollHeight + 24` while SkybridgeHost's ResizeObserver reported bare
 * `body.scrollHeight`. ChatGPT resized the iframe to whichever spoke last, so
 * the two fought. Worse, the bare value is a rounded integer with no slack — a
 * frame a fraction of a pixel short grows a vertical scrollbar, the content
 * narrows by its width, and L0179's `.tableWrapper { overflow-x: auto }` then
 * grows a horizontal scrollbar, which adds height, which the observer reports,
 * which removes the vertical scrollbar, and round it goes. That is the
 * spreadsheet jitter. Every height report now goes through here.
 *
 * Not compiled by tsc (browser-only) — bundled by scripts/build-widget.mjs.
 */

/** Breathing room below the content, so the frame never clips a shadow or focus ring. */
export const HEIGHT_PAD_PX = 24;

export function contentHeight(): number {
  // The document element's box, not body.scrollHeight: it is fractional, so
  // ceil() never under-reports, and it includes body's own padding.
  return Math.ceil(document.documentElement.getBoundingClientRect().height) + HEIGHT_PAD_PX;
}
