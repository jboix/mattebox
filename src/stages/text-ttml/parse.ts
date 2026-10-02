/**
 * TTML to cues, for the IMSC1 Text Profile (W3C IMSC 1.0.1 to 1.2), which
 * EBU-TT-D documents also conform to. It reads `tt`, `head` (styling and
 * layout), `body`, `div`, `p`, `span`, and `br`, the timing attributes, the
 * styles a cue can show, and the region a `p` is flowed into. Anything else
 * is ignored, so a richer document still shows its text.
 *
 * Times come back in document time; `Infinity` marks an end the document
 * leaves open, for the caller to close at its segment's end.
 */
import type { CueDescriptor } from '../../types/messages.js';

const TTP = 'http://www.w3.org/ns/ttml#parameter';
const TTS = 'http://www.w3.org/ns/ttml#styling';
const XML = 'http://www.w3.org/XML/1998/namespace';

/** The styles kept: what a cue shows, and what the raw form carries for a page. */
const STYLES = [
  'fontStyle',
  'fontWeight',
  'textDecoration',
  'textAlign',
  'color',
  'backgroundColor',
  'displayAlign',
  'origin',
  'extent',
] as const;
type Style = Partial<Record<(typeof STYLES)[number], string>>;
/** Region-only styles do not pass from a region or a parent to its content. */
const NOT_INHERITED = new Set(['backgroundColor', 'displayAlign', 'origin', 'extent']);

interface Rates {
  readonly frame: number;
  readonly subFrame: number;
  readonly tick: number;
}

interface Run {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function attrNS(element: Element, ns: string, prefix: string, name: string): string | null {
  return element.getAttributeNS(ns, name) ?? element.getAttribute(`${prefix}:${name}`);
}

function childElements(element: Element, name?: string): Element[] {
  return [...element.children].filter((child) => name === undefined || child.localName === name);
}

/**
 * A TTML time expression in seconds (TTML2 §10.3.1): clock time
 * `hh:mm:ss.fff` or `hh:mm:ss:ff.sub`, or an offset `12.5s`, `250ms`, `2m`,
 * `1h`, `30f`, `100t`. Null for anything else.
 */
export function parseTime(value: string | null, rates: Rates): number | null {
  if (value === null) return null;
  const text = value.trim();
  const clock = /^(\d+):(\d\d):(\d\d)(?:(\.\d+)|:(\d+)(?:\.(\d+))?)?$/.exec(text);
  if (clock !== null) {
    const [, h, m, s, fraction, frames, sub] = clock;
    return (
      Number(h) * 3600 +
      Number(m) * 60 +
      Number(s) +
      (fraction !== undefined ? Number(fraction) : 0) +
      (frames !== undefined ? Number(frames) / rates.frame : 0) +
      (sub !== undefined ? Number(sub) / (rates.frame * rates.subFrame) : 0)
    );
  }
  const offset = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(text);
  if (offset === null) return null;
  const units: Record<string, number> = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 0.001,
    f: 1 / rates.frame,
    t: 1 / rates.tick,
  };
  return Number(offset[1]) * (units[offset[2] as string] as number);
}

/** The frame, sub-frame, and tick rates the root declares (TTML2 §7.2). */
function ratesOf(tt: Element): Rates {
  const declared = attrNS(tt, TTP, 'ttp', 'frameRate');
  const [num, den] = (attrNS(tt, TTP, 'ttp', 'frameRateMultiplier') ?? '1 1').split(/\s+/);
  const frame = Number(declared ?? 30) * (Number(num) / Number(den) || 1);
  const subFrame = Number(attrNS(tt, TTP, 'ttp', 'subFrameRate') ?? 1);
  const tick = Number(
    attrNS(tt, TTP, 'ttp', 'tickRate') ?? (declared !== null ? frame * subFrame : 1),
  );
  return { frame, subFrame, tick };
}

function inlineStyle(element: Element): Style {
  const style: Style = {};
  for (const key of STYLES) {
    const value = attrNS(element, TTS, 'tts', key);
    if (value !== null) style[key] = value.trim();
  }
  return style;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A length as a percent of the root container: `%`, `px` against the root extent, `c` against the cell grid. */
function percent(
  value: string | undefined,
  axis: 0 | 1,
  root: readonly number[],
  cells: readonly number[],
): number | null {
  const match = value === undefined ? null : /^(-?[\d.]+)(%|px|c)$/.exec(value);
  if (match === null) return null;
  const n = Number(match[1]);
  if (match[2] === '%') return n;
  const whole = match[2] === 'px' ? root[axis] : cells[axis];
  return whole !== undefined && whole > 0 ? (n / whole) * 100 : null;
}

/** WebVTT settings that put the cue where its region sits (IMSC1 §8, WebVTT §4.3). */
function settingsFor(style: Style, root: readonly number[], cells: readonly number[]): string {
  const origin = (style.origin ?? '').split(/\s+/);
  const extent = (style.extent ?? '').split(/\s+/);
  const x = percent(origin[0], 0, root, cells);
  const y = percent(origin[1], 1, root, cells);
  const w = percent(extent[0], 0, root, cells);
  const h = percent(extent[1], 1, root, cells);
  const out: string[] = [];
  if (x !== null && w !== null) out.push(`position:${x + w / 2}%,center`, `size:${w}%`);
  if (y !== null && h !== null) {
    // displayAlign defaults to before: the text hangs from the region's top.
    const display = style.displayAlign ?? 'before';
    out.push(
      display === 'after'
        ? `line:${y + h}%,end`
        : display === 'center'
          ? `line:${y + h / 2}%,center`
          : `line:${y}%,start`,
    );
  }
  const align = style.textAlign;
  if (align !== undefined && ['left', 'center', 'right', 'start', 'end'].includes(align)) {
    out.push(`align:${align}`);
  }
  return out.join(' ');
}

/** The cues of a TTML document. Throws a RangeError for bytes that are not XML. */
export function parseTtml(xml: string): CueDescriptor[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const tt = doc.documentElement;
  if (tt === null || tt.localName !== 'tt' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new RangeError('not a TTML document');
  }
  // The Text Profile times on the media timeline only.
  const timeBase = attrNS(tt, TTP, 'ttp', 'timeBase');
  if (timeBase !== null && timeBase !== 'media') return [];
  const rates = ratesOf(tt);
  const root = (attrNS(tt, TTS, 'tts', 'extent') ?? '')
    .split(/\s+/)
    .map((v) => Number.parseFloat(v));
  const cells = (attrNS(tt, TTP, 'ttp', 'cellResolution') ?? '32 15').split(/\s+/).map(Number);

  // Referential styles and regions by xml:id; a style may reference others.
  const styles = new Map<string, Element>();
  const regions = new Map<string, Element>();
  const head = childElements(tt, 'head')[0];
  for (const styling of head === undefined ? [] : childElements(head, 'styling')) {
    for (const style of childElements(styling, 'style')) styles.set(idOf(style), style);
  }
  for (const layout of head === undefined ? [] : childElements(head, 'layout')) {
    for (const region of childElements(layout, 'region')) regions.set(idOf(region), region);
  }

  function idOf(element: Element): string {
    return element.getAttributeNS(XML, 'id') ?? element.getAttribute('xml:id') ?? '';
  }

  /** The style an element specifies: referenced styles in order, then nested and inline ones. */
  function specified(element: Element, seen = new Set<Element>()): Style {
    let style: Style = {};
    for (const ref of (element.getAttribute('style') ?? '').split(/\s+/)) {
      const referenced = styles.get(ref);
      if (referenced === undefined || seen.has(referenced)) continue;
      seen.add(referenced);
      style = { ...style, ...specified(referenced, seen) };
    }
    for (const nested of childElements(element, 'style'))
      style = { ...style, ...inlineStyle(nested) };
    return { ...style, ...inlineStyle(element) };
  }

  function inherit(parent: Style): Style {
    const out: Style = {};
    for (const key of STYLES)
      if (!NOT_INHERITED.has(key) && parent[key] !== undefined) out[key] = parent[key];
    return out;
  }

  function interval(element: Element, parent: readonly [number, number]): [number, number] {
    const begin = parseTime(element.getAttribute('begin'), rates);
    const end = parseTime(element.getAttribute('end'), rates);
    const dur = parseTime(element.getAttribute('dur'), rates);
    const start = parent[0] + (begin ?? 0);
    let stop = parent[1];
    if (end !== null) stop = Math.min(stop, parent[0] + end);
    if (dur !== null) stop = Math.min(stop, start + dur);
    return [start, stop];
  }

  /** The text runs of a p's content, each with its own active interval and markup. */
  function runs(node: Node, style: Style, span: readonly [number, number], out: Run[]): void {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = (child.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' ');
        if (text === '') continue;
        let markup = escapeText(text);
        if (style.textDecoration?.includes('underline') === true) markup = `<u>${markup}</u>`;
        if (style.fontWeight === 'bold') markup = `<b>${markup}</b>`;
        if (style.fontStyle === 'italic' || style.fontStyle === 'oblique')
          markup = `<i>${markup}</i>`;
        out.push({ text: markup, start: span[0], end: span[1] });
      } else if (child.nodeType === 1) {
        const element = child as Element;
        if (element.localName === 'br') out.push({ text: '\n', start: span[0], end: span[1] });
        else if (element.localName === 'span') {
          runs(element, { ...inherit(style), ...specified(element) }, interval(element, span), out);
        }
      }
    }
  }

  const cues: CueDescriptor[] = [];

  function cuesOf(p: Element, style: Style, span: readonly [number, number]): void {
    const content: Run[] = [];
    runs(p, style, span, content);
    const edges = [...new Set([span[0], span[1], ...content.flatMap((r) => [r.start, r.end])])]
      .filter((t) => t >= span[0] && t <= span[1])
      .sort((a, b) => a - b);
    const settings = settingsFor(style, root, cells);
    const payload = Object.fromEntries(Object.entries(style)) as Record<string, string>;
    for (let i = 0; i + 1 < edges.length; i += 1) {
      const from = edges[i] as number;
      const to = edges[i + 1] as number;
      const text = content
        .filter((r) => r.start <= from && r.end >= to)
        .map((r) => r.text)
        .join('')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .trim();
      if (text === '') continue;
      const last = cues[cues.length - 1];
      // The same text across adjacent spans is one cue.
      if (
        last !== undefined &&
        last.end === from &&
        last.text === text &&
        last.settings === settings
      ) {
        cues[cues.length - 1] = { ...last, end: to };
        continue;
      }
      cues.push({ start: from, end: to, text, ...(settings !== '' ? { settings } : {}), payload });
    }
  }

  /** Walks body and its divs, carrying timing, style, and region down to each p. */
  function walk(
    element: Element,
    parentStyle: Style,
    region: string | null,
    span: readonly [number, number],
  ): void {
    const own = element.getAttribute('region') ?? region;
    const regionElement = own === null ? undefined : regions.get(own);
    // Content takes the region's styles as from a parent, and the region's position.
    const fromRegion = regionElement === undefined ? {} : specified(regionElement);
    const style = { ...fromRegion, ...inherit(parentStyle), ...specified(element) };
    const placed = { ...style, ...pick(fromRegion) };
    const interval_ = interval(element, span);
    if (element.localName === 'p') {
      cuesOf(element, placed, interval_);
      return;
    }
    for (const child of childElements(element)) {
      if (child.localName === 'div' || child.localName === 'p') walk(child, style, own, interval_);
    }
  }

  function pick(style: Style): Style {
    const out: Style = {};
    for (const key of ['origin', 'extent', 'displayAlign', 'backgroundColor'] as const) {
      if (style[key] !== undefined) out[key] = style[key];
    }
    return out;
  }

  const body = childElements(tt, 'body')[0];
  if (body !== undefined) walk(body, {}, null, [0, Number.POSITIVE_INFINITY]);
  return cues.sort((a, b) => a.start - b.start);
}
