/**
 * Escapes text for an HTML text node or a quoted attribute value. Manifest
 * content (codecs, ids, URLs, tag values) is untrusted and must pass through
 * here before it reaches innerHTML.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Puts `children` in `parent` in place of what it held. replaceChildren()
 * needs Chromium 86, and the hosted playground runs on the TV floor
 * (lint/floor/README.md).
 */
export function setChildren(parent: Node, ...children: Array<Node | string>): void {
  while (parent.firstChild !== null) parent.removeChild(parent.firstChild);
  for (const child of children) {
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/**
 * Marks the page `no-flex-gap` where the browser lacks flex `gap`
 * (Chromium 84), so the margins vite.config.ts adds under that class take
 * its place.
 */
export function markFlexGap(): void {
  const box = document.createElement('div');
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.rowGap = '1px';
  box.appendChild(document.createElement('div'));
  box.appendChild(document.createElement('div'));
  document.body.appendChild(box);
  const works = box.scrollHeight === 1;
  document.body.removeChild(box);
  if (!works) document.documentElement.classList.add('no-flex-gap');
}
