/**
 * Chapter files into one record shape. Pure. A WebVTT file serves two
 * sources: a chapters track, whose cue payload is the title, and the
 * metadata track this engine defines, whose cue payload may be a JSON object
 * with a title, an image, and free data. Detection is per cue, so the two
 * mix in one file.
 */
import { parseVtt } from '../../containers/webvtt.js';
import { resolveUrl as resolve } from '../../kernel/url.js';
import type { Serializable } from '../../types/messages.js';

export interface ChapterImage {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

export interface Chapter {
  /** The cue id, or the parser's deterministic id when the file gives none. */
  readonly id: string;
  /** Presentation time, seconds. */
  readonly start: number;
  readonly end: number;
  /** Always set; the empty string when the source has no title. */
  readonly title: string;
  /** BCP 47 tag when the source carries one. */
  readonly lang?: string;
  readonly image?: ChapterImage;
  /** Whatever the source carried beyond the fields above, verbatim. */
  readonly data?: Serializable;
}

/** Something the parser skipped or changed, for a `chapters:warning` event. */
export interface ChapterWarning {
  readonly reason: 'malformed-cue' | 'bad-json' | 'overlap' | 'fetch-failed';
  readonly id?: string;
}

export interface ChaptersResult {
  readonly chapters: readonly Chapter[];
  readonly warnings: readonly ChapterWarning[];
}

function imageOf(value: unknown, baseUrl: string): ChapterImage | undefined {
  if (typeof value === 'string') return { url: resolve(value, baseUrl) };
  if (typeof value !== 'object' || value === null) return undefined;
  const { url, width, height } = value as Record<string, unknown>;
  if (typeof url !== 'string') return undefined;
  return {
    url: resolve(url, baseUrl),
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
  };
}

/** A JSON cue payload into the record's fields; every other field goes to `data`. */
function fromJson(
  object: Record<string, unknown>,
  baseUrl: string,
): Pick<Chapter, 'title' | 'lang' | 'image' | 'data'> {
  const { title, lang, image, ...rest } = object;
  const resolvedImage = imageOf(image, baseUrl);
  return {
    title: typeof title === 'string' ? title : '',
    ...(typeof lang === 'string' ? { lang } : {}),
    ...(resolvedImage !== undefined ? { image: resolvedImage } : {}),
    ...(Object.keys(rest).length > 0 ? { data: rest as Serializable } : {}),
  };
}

/**
 * Sorts by start and truncates an earlier chapter that runs into the next,
 * so chapters partition the timeline. An authored gap stays a gap.
 */
export function orderChapters(chapters: readonly Chapter[], warnings: ChapterWarning[]): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  return sorted.map((chapter, i) => {
    const next = sorted[i + 1];
    if (next === undefined || chapter.end <= next.start) return chapter;
    warnings.push({ reason: 'overlap', id: chapter.id });
    return { ...chapter, end: next.start };
  });
}

/** A WebVTT chapters or metadata track. URLs resolve against `baseUrl`, the file's own URL. */
export function parseChapterTrack(text: string, baseUrl: string): ChaptersResult {
  const { cues, skipped } = parseVtt(text);
  const warnings: ChapterWarning[] = [];
  for (let i = 0; i < skipped; i += 1) warnings.push({ reason: 'malformed-cue' });
  const chapters: Chapter[] = [];
  for (const cue of cues) {
    const payload = (cue.text ?? '').trim();
    const id = cue.id ?? String(Math.round(cue.start * 1000));
    let fields: Pick<Chapter, 'title' | 'lang' | 'image' | 'data'> = { title: payload };
    if (payload.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new TypeError('not an object');
        }
        fields = fromJson(parsed as Record<string, unknown>, baseUrl);
      } catch {
        // Not JSON after all: the payload is the title, as in a plain track.
        warnings.push({ reason: 'bad-json', id });
      }
    }
    chapters.push({ id, start: cue.start, end: cue.end, ...fields });
  }
  return { chapters: orderChapters(chapters, warnings), warnings };
}

interface AppleTitle {
  readonly language: string;
  readonly title: string;
}

/**
 * The title in `preferred`, else the language-neutral `und` one, else the
 * first. Apple's JSON gives one title per BCP 47 tag.
 */
function pickTitle(
  titles: readonly AppleTitle[],
  preferred: string | null,
): AppleTitle | undefined {
  const base = (tag: string) => tag.toLowerCase().split('-')[0];
  return (
    (preferred === null
      ? undefined
      : (titles.find((t) => t.language.toLowerCase() === preferred.toLowerCase()) ??
        titles.find((t) => base(t.language) === base(preferred)))) ??
    titles.find((t) => t.language === 'und') ??
    titles[0]
  );
}

/**
 * Apple's JSON chapters document (HTTP Live Streaming, "Providing
 * JavaScript Object Notation (JSON) chapters"): an array of entries with a
 * required `start-time` and optional `duration`, `chapter`, `titles`,
 * `images`, and `metadata`. Without `duration` a chapter ends at the next
 * one's start; the last one runs to the end of the presentation (Infinity
 * here). The first image becomes `image`; every title, image, and metadata
 * item stays under `data`. Image URLs resolve against the document.
 */
export function parseAppleChapters(
  text: string,
  baseUrl: string,
  preferredLanguage: string | null = null,
): ChaptersResult {
  const warnings: ChapterWarning[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { chapters: [], warnings: [{ reason: 'bad-json' }] };
  }
  if (!Array.isArray(parsed)) return { chapters: [], warnings: [{ reason: 'bad-json' }] };
  const entries = parsed.filter((entry): entry is Record<string, unknown> => {
    const ok =
      typeof entry === 'object' && entry !== null && typeof entry['start-time'] === 'number';
    if (!ok) warnings.push({ reason: 'malformed-cue' });
    return ok;
  });
  const starts = entries.map((entry) => entry['start-time'] as number).sort((a, b) => a - b);
  const chapters: Chapter[] = entries.map((entry, index) => {
    const start = entry['start-time'] as number;
    const duration = typeof entry.duration === 'number' ? entry.duration : null;
    const end =
      duration !== null
        ? start + duration
        : (starts.find((s) => s > start) ?? Number.POSITIVE_INFINITY);
    const titles = Array.isArray(entry.titles)
      ? (entry.titles as unknown[]).filter(
          (t): t is AppleTitle =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as AppleTitle).language === 'string' &&
            typeof (t as AppleTitle).title === 'string',
        )
      : [];
    const title = pickTitle(titles, preferredLanguage);
    const images = Array.isArray(entry.images)
      ? (entry.images as unknown[])
          .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
          .filter((i) => typeof i.url === 'string')
          .map((i): Record<string, unknown> & { url: string } => ({
            ...i,
            url: resolve(i.url as string, baseUrl),
          }))
      : [];
    const first = images[0];
    const {
      'start-time': _start,
      duration: _duration,
      titles: _titles,
      images: _images,
      ...rest
    } = entry;
    const data = {
      ...rest,
      ...(titles.length > 0 ? { titles } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
    const width = first?.['pixel-width'];
    const height = first?.['pixel-height'];
    return {
      id: typeof entry.chapter === 'number' ? String(entry.chapter) : String(index + 1),
      start,
      end,
      title: title?.title ?? '',
      ...(title !== undefined ? { lang: title.language } : {}),
      ...(first !== undefined
        ? {
            image: {
              url: first.url,
              ...(typeof width === 'number' ? { width } : {}),
              ...(typeof height === 'number' ? { height } : {}),
            },
          }
        : {}),
      ...(Object.keys(data).length > 0 ? { data: data as Serializable } : {}),
    };
  });
  return { chapters: orderChapters(chapters, warnings), warnings };
}
