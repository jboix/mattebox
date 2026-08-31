/**
 * The DRM key-system registry both eme-cenc and eme-fairplay contribute to
 * and eme-core reads. A handler is pure config plus two shaping functions,
 * so a module-level registry is safe across engines: no per-engine state
 * lives here. eme-core supplies ClearKey itself; the others register
 * Widevine, PlayReady, and FairPlay.
 *
 * This mirrors live-shared.ts: a shared module is not a lateral stage
 * import, which keeps the dependency-cruiser rule satisfied while the
 * stages stay independently loadable.
 */

/** One key system eme-core can negotiate and drive. */
export interface KeySystemHandler {
  /** The EME key system string, e.g. 'com.widevine.alpha'. */
  readonly keySystem: string;
  /** ContentProtection systemId UUIDs (lowercase, no urn prefix) this handler serves. */
  readonly systemIds: readonly string[];
  /** EME init data types this handler accepts, e.g. ['cenc']. */
  readonly initDataTypes: readonly string[];
  /** Robustness levels to request, or empty for none. */
  readonly robustness?: readonly string[];
  /** Shapes the CDM's license message into the request body sent to the server. */
  buildLicenseRequest(message: ArrayBuffer): ArrayBuffer | Uint8Array;
  /** Extracts the raw bytes to pass to session.update from the server response. */
  parseLicenseResponse(response: ArrayBuffer): ArrayBuffer | Uint8Array;
  /** Optional headers for the license POST. */
  licenseHeaders?: Readonly<Record<string, string>>;
  /** When true, buildLicenseRequest already produced the license; apply it directly, no server. */
  readonly localLicense?: boolean;
  /**
   * FairPlay's non-standard flow needs the certificate and a per-session
   * init-data rewrite; absent for the standard CENC systems.
   */
  readonly fairplay?: {
    certificateUrl?: string;
    /** Builds the SPC init data from the raw skd content id. */
    contentId(initData: ArrayBuffer): string;
  };
}

const handlers = new Map<string, KeySystemHandler>();

/** Registers a handler, keyed by its key system; a repeat replaces. */
export function registerKeySystem(handler: KeySystemHandler): void {
  handlers.set(handler.keySystem, handler);
}

/** Every registered handler. eme-core reads this when choosing a key system. */
export function keySystemHandlers(): readonly KeySystemHandler[] {
  return [...handlers.values()];
}

/** Normalizes a ContentProtection schemeIdUri or systemId to a bare lowercase UUID. */
export function normalizeSystemId(raw: string | null): string | null {
  if (raw === null) return null;
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(raw);
  return match !== null ? (match[1] as string).toLowerCase() : null;
}
