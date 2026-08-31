/**
 * Line-based m3u8 tokenizer. RFC 8216 §4. The attribute-list tokenizer is
 * a real one: quoted values may contain commas, so splitting on ',' fails
 * on real manifests.
 */

export interface TagLine {
  readonly kind: 'tag';
  readonly name: string;
  /** The raw text after the colon, untokenized. */
  readonly value: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface UriLine {
  readonly kind: 'uri';
  readonly uri: string;
}

export type Line = TagLine | UriLine;

/** Tags with attribute lists; everything else keeps its raw value. */
const ATTRIBUTE_TAGS = new Set([
  'EXT-X-STREAM-INF',
  'EXT-X-MEDIA',
  'EXT-X-MAP',
  'EXT-X-KEY',
  'EXT-X-SESSION-KEY',
  'EXT-X-I-FRAME-STREAM-INF',
  'EXT-X-CONTENT-STEERING',
]);

/**
 * RFC 8216 §4.2: comma-separated KEY=VALUE pairs where a quoted-string
 * value may contain commas. Walk characters; never split.
 */
export function parseAttributeList(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    const eq = text.indexOf('=', at);
    if (eq === -1) break;
    const key = text.slice(at, eq).trim();
    at = eq + 1;
    let value: string;
    if (text[at] === '"') {
      const close = text.indexOf('"', at + 1);
      if (close === -1) {
        value = text.slice(at + 1);
        at = text.length;
      } else {
        value = text.slice(at + 1, close);
        at = close + 1;
      }
    } else {
      let end = text.indexOf(',', at);
      if (end === -1) end = text.length;
      value = text.slice(at, end).trim();
      at = end;
    }
    if (key !== '') out[key] = value;
    // Skip the separating comma, when present.
    if (text[at] === ',') at += 1;
  }
  return out;
}

/** Tokenizes a playlist into tag and URI lines. Comments and blanks drop. */
export function lex(text: string): readonly Line[] {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('#')) {
      lines.push({ kind: 'uri', uri: line });
      continue;
    }
    if (!line.startsWith('#EXT')) continue; // a comment
    const colon = line.indexOf(':');
    const name = colon === -1 ? line.slice(1) : line.slice(1, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);
    lines.push({
      kind: 'tag',
      name,
      value,
      attributes: ATTRIBUTE_TAGS.has(name) ? parseAttributeList(value) : {},
    });
  }
  return lines;
}
