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
