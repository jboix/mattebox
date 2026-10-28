/** What a load and a preload take: the page's through the facade, a stage's through its context. */

export interface LoadOptions {
  /**
   * The manifest's MIME type, when the caller knows it. Authoritative: a
   * type no composed adapter accepts fails the load before any fetch with
   * MANIFEST_UNSUPPORTED, and an accepted type routes the bytes to that
   * adapter without sniffing. Omitted, the adapters sniff the bytes.
   */
  readonly mimeType?: string;
  /**
   * The presentation time to start from, in seconds. On demand it is
   * clamped to the duration. Live, a time outside the window starts at the
   * live edge. Omitted, playback starts at 0, or at the live edge.
   */
  readonly start?: number;
}

export interface PreloadOptions extends LoadOptions {
  /**
   * Media segments to fetch per track, from `start` or from the start of
   * the source, with the playlists and init segments they need. 0, the
   * default, fetches the manifest alone. Only an attached engine fetches
   * more than the manifest.
   */
  readonly segments?: number;
  /** Seconds the responses are kept for the load. 30 by default. */
  readonly keepSeconds?: number;
}
