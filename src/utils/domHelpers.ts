/**
 * DOM helpers for building dynamic display text inside the XUL organizer window.
 *
 * Why this exists: `doc.createElement("label")` in a XUL-namespaced XHTML
 * document (like `addon/content/organizer.xhtml`, which declares
 * `xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"`)
 * creates an HTML-namespace `HTMLLabelElement`, NOT a XUL `<label>`. The HTML
 * `<label>` element does not render text through its `.value` property, so
 * labels created this way are invisible even though their box structure
 * remains. This is the Zotero 7/9/10 migration documented in the
 * "Zotero for Developers" guide: `createElement()/createElementNS()` must be
 * replaced with `createXULElement()` for XUL elements, or — for plain display
 * text — HTML-namespace elements with `textContent` should be used.
 *
 * Pattern (matching the `llm-for-zotero` plugin, `src/utils/domHelpers.ts`):
 * create HTML-namespace elements (`div`/`span`) and set `.textContent`.
 * `.value` is reserved for real HTML form controls (`<input>`, `<textarea>`,
 * `<select>`), where it is the correct property.
 */

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Create an HTML-namespace element with optional inline style and text.
 *
 * @param doc   The ownerDocument (a XUL document in the organizer window).
 * @param tag   HTML tag name (e.g. "div", "span").
 * @param style Optional inline CSS string (set via the `style` attribute).
 * @param text  Optional text content (set via `textContent`).
 * @returns     The created element.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (style) node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}
