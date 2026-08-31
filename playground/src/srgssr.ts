/**
 * SRG SSR content through the integration layer (IL): search by business
 * unit, resolve a URN to its media composition, pick a resource, and add
 * the Akamai token and DRM license URLs the resource needs. Playground
 * code only: the engine never knows where a URL came from. Adapted from
 * pillarbox-web (srgssr middleware, AkamaiTokenService, Drm) and the
 * pillarbox theme editor's il-provider.
 */

export const IL_HOST = 'il.srgssr.ch';
export const BUSINESS_UNITS = ['srf', 'rts', 'rsi', 'rtr', 'swi'] as const;
export type BusinessUnit = (typeof BUSINESS_UNITS)[number];

const TOKEN_SERVER = 'https://tp.srgssr.ch/akahd/token?acl=';

export interface SearchResult {
  readonly title: string;
  readonly urn: string;
  readonly mediaType: string;
  readonly date: string;
  /** Milliseconds. */
  readonly duration: number;
}

export interface DrmEntry {
  readonly type: 'WIDEVINE' | 'PLAYREADY' | 'FAIRPLAY';
  readonly licenseUrl: string;
  readonly certificateUrl?: string;
}

/** One playable resource of a chapter, as the IL describes it. */
export interface IlResource {
  readonly url: string;
  readonly streaming: string;
  readonly quality: string;
  readonly presentation: string;
  readonly mimeType: string;
  readonly mediaContainer?: string;
  readonly dvr?: boolean;
  readonly live?: boolean;
  readonly tokenType?: string;
  readonly drmList?: readonly DrmEntry[];
  readonly streamOffset?: number;
}

export interface Composition {
  readonly urn: string;
  readonly title: string;
  readonly mediaType: string;
  readonly vendor: string;
  readonly imageUrl?: string;
  readonly blockReason?: string;
  readonly resources: readonly IlResource[];
}

export async function searchMedia(
  bu: BusinessUnit,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    vector: 'srgplay',
    includeAggregations: 'false',
    includeSuggestions: 'false',
    sortBy: 'default',
    sortDir: 'desc',
    pageSize: '30',
    q: query,
  });
  const url = `https://${IL_HOST}/integrationlayer/2.0/${bu}/searchResultMediaList?${params}`;
  const response = await fetch(url, signal !== undefined ? { signal } : {});
  if (!response.ok) throw new Error(`search failed: HTTP ${response.status}`);
  const data = (await response.json()) as { searchResultMediaList?: SearchResult[] };
  return (data.searchResultMediaList ?? []).map(({ title, urn, mediaType, date, duration }) => ({
    title,
    urn,
    mediaType,
    date,
    duration,
  }));
}

export async function fetchComposition(urn: string, signal?: AbortSignal): Promise<Composition> {
  const url = `https://${IL_HOST}/integrationlayer/2.1/mediaComposition/byUrn/${encodeURIComponent(
    urn,
  )}?onlyChapters=true&vector=portalplay`;
  const response = await fetch(url, signal !== undefined ? { signal } : {});
  if (!response.ok) throw new Error(`media composition failed: HTTP ${response.status}`);
  const data = (await response.json()) as {
    chapterUrn: string;
    chapterList?: Array<{
      urn: string;
      title: string;
      mediaType: string;
      vendor: string;
      imageUrl?: string;
      blockReason?: string;
      resourceList?: IlResource[];
    }>;
  };
  const chapter = (data.chapterList ?? []).find((c) => c.urn === data.chapterUrn);
  if (chapter === undefined) throw new Error('media composition has no main chapter');
  return {
    urn: chapter.urn,
    title: chapter.title,
    mediaType: chapter.mediaType,
    vendor: chapter.vendor,
    ...(chapter.imageUrl !== undefined ? { imageUrl: chapter.imageUrl } : {}),
    ...(chapter.blockReason !== undefined ? { blockReason: chapter.blockReason } : {}),
    resources: chapter.resourceList ?? [],
  };
}

/** The Akamai ACL for a stream URL: its directory and everything below. */
function aclPath(url: URL): string {
  const path = url.pathname;
  return `${path.substring(0, path.lastIndexOf('/') + 1)}*`;
}

/** Adds the Akamai auth parameters the token server issues for the stream's path. */
export async function tokenize(streamUrl: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(streamUrl);
  const response = await fetch(
    `${TOKEN_SERVER}${encodeURIComponent(aclPath(url))}`,
    signal !== undefined ? { signal } : {},
  );
  if (!response.ok) throw new Error(`token server failed: HTTP ${response.status}`);
  const data = (await response.json()) as { token?: { authparams?: string } };
  const params = new URLSearchParams(data.token?.authparams ?? '');
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

export const IL_KEY_SYSTEMS: Record<DrmEntry['type'], string> = {
  WIDEVINE: 'com.widevine.alpha',
  PLAYREADY: 'com.microsoft.playready',
  FAIRPLAY: 'com.apple.fps',
};

/** Per-key-system license URLs, in the shape eme-core's `licenseUrls` takes. */
export function licenseUrlsFor(resource: IlResource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of resource.drmList ?? []) {
    out[IL_KEY_SYSTEMS[entry.type]] = entry.licenseUrl;
  }
  return out;
}

export function certificateUrlFor(resource: IlResource): string | undefined {
  return (resource.drmList ?? []).find((d) => d.type === 'FAIRPLAY')?.certificateUrl;
}

export function fmtDuration(ms: number): string {
  if (!ms) return '';
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
    : `${Math.max(1, minutes)} min`;
}
