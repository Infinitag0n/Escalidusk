// A thin notice across the top of every page, such as "Experimental build",
// set with BANNER. It is written into the pages as they are served, so
// changing it needs only a restart, not a rebuild. Its look is in
// src/banner.css.

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** BANNER as shown: trimmed, on one line, or "" for none. */
export function bannerText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

/** A page's HTML with the banner as the first thing in its body. Plain text only. */
export function withBanner(html, text) {
  if (!text) return html;
  const safe = escapeHtml(text);
  // The title shows the whole text where a narrow screen cuts it short.
  const banner = `<div class="app-banner" role="note" title="${safe}">${safe}</div>`;
  return html.replace(/<body([^>]*)>/, (body) => `${body}\n    ${banner}`);
}
