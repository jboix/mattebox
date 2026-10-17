/**
 * The generic EME handshake, entanglement #3 resolved: DRM lands without
 * touching a protocol adapter. Init data arrives by two routes — the
 * manifest (protection descriptors already in the IR since Stage 08) and
 * the media (the element's `encrypted` event) — and eme-core dedupes them
 * by key id so the same key never opens two sessions.
 *
 * Everything here is the impure edge: MediaKeys and MediaKeySession are
 * un-serializable and cannot enter the reducer, so this is an install-time
 * controller. It reports through ctx.emit (drm:* events, and a fatal
 * 'error' event that reaches engine.error) and exposes engine.drm; the
 * trace stays complete for everything the reducer can see.
 *
 * An expired key renews: eme-core opens a new session with the same init
 * data, which fetches a fresh license, and closes the old session once the
 * new key is usable. Renewal waits for playback, so a paused or suspended
 * element makes no license request. A renewal message the CDM sends on
 * its own (Widevine `license-renewal`) takes the normal license path.
 *
 * ClearKey is built in — it is the only key system testable headlessly.
 * Widevine, PlayReady, and FairPlay arrive as handlers eme-cenc and
 * eme-fairplay register through drm-shared.
 *
 * A license request follows hls.js's key-load policy: a network error or
 * an HTTP status outside 4xx retries up to 8 times, a timeout (20 s) once,
 * each after 1 s. A 401 or 403 calls `onUnauthorized` once and sends the
 * request again, so a page can refresh an expired token. `getLicense`
 * replaces the built-in request, as `getLicense` does in videojs-contrib-eme:
 * it takes the CDM message and returns the bytes for `MediaKeySession.update`
 * (W3C EME §6.6.2), with the same retries.
 */
import { bytesToBase64 } from '../../kernel/base64.js';
import type { ProtectionScheme } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';
import type { KeySystemHandler } from '../drm-shared.js';
import { keySystemHandlers, normalizeSystemId } from '../drm-shared.js';

export interface EmeOptions {
  /** License server URL, when the manifest does not carry one. */
  readonly licenseUrl?: string;
  /**
   * The FairPlay application certificate URL, for a FairPlay stage built
   * without one: a player then passes it with the license URL.
   */
  readonly certificateUrl?: string;
  /** Per-key-system license URLs, overriding `licenseUrl`. */
  readonly licenseUrls?: Readonly<Record<string, string>>;
  /**
   * Rewrites the license request before it is sent (auth tokens, wrapping).
   * It may change `request.url` and `request.headers`, and may return a promise.
   */
  readonly requestFilter?: (
    body: Uint8Array,
    keySystem: string,
    request: LicenseRequestDraft,
  ) => Uint8Array | Promise<Uint8Array>;
  /** Rewrites the license response before the key system reads it. It may return a promise. */
  readonly responseFilter?: (
    body: Uint8Array,
    keySystem: string,
    response: LicenseResponseInfo,
  ) => Uint8Array | Promise<Uint8Array>;
  /**
   * Gets the license in place of the built-in request: from the CDM message
   * to the bytes for `MediaKeySession.update`. A rejection with a `status`
   * of 401 or 403 calls `onUnauthorized`; another 4xx fails; anything else
   * retries as a network error does.
   */
  readonly getLicense?: (
    message: Uint8Array,
    context: LicenseContext,
  ) => Promise<Uint8Array | ArrayBuffer>;
  /**
   * Gets the server certificate for a key system: FairPlay's application
   * certificate, or a Widevine service certificate (W3C EME §6.5
   * `setServerCertificate`). Null: none, or the FairPlay certificate URL.
   */
  readonly getCertificate?: (keySystem: string) => Promise<Uint8Array | ArrayBuffer | null>;
  /**
   * Called once when the license server answers 401 or 403, before the
   * request goes again. Refresh the token your `requestFilter` adds here.
   */
  readonly onUnauthorized?: (context: {
    readonly keySystem: string;
    readonly status: number;
  }) => void | Promise<void>;
  /** Retries and timeout of a license request. */
  readonly licenseRetry?: LicenseRetryOptions;
  /** For ClearKey tests: resolves a base64url key id to its base64url key. */
  readonly clearKeys?: Readonly<Record<string, string>>;
  /** Preference order among available key systems. */
  readonly preferredKeySystems?: readonly string[];
  /**
   * Closes every key session when the engine suspends and requests the
   * licenses again when it resumes, so a suspended player stops holding a
   * license (and its renewals) against a concurrent-stream limit. Off by
   * default: resuming then waits for a license round trip.
   */
  readonly releaseOnSuspend?: boolean;
}

/** The license request a `requestFilter` may rewrite. */
export interface LicenseRequestDraft {
  url: string;
  headers: Record<string, string>;
  /** 1 for the first request, then one more for each retry. */
  readonly attempt: number;
}

/** The license response a `responseFilter` sees. */
export interface LicenseResponseInfo {
  readonly url: string;
  readonly status: number;
  readonly headers: Headers;
}

/** What `getLicense` gets with the CDM message. */
export interface LicenseContext {
  readonly keySystem: string;
  readonly sessionId: string;
  readonly initDataType: string;
  readonly initData: Uint8Array;
  /** 1 for the first request, then one more for each retry. */
  readonly attempt: number;
}

/** The defaults are hls.js's key-load policy. */
export interface LicenseRetryOptions {
  /** Retries after a network error or a status outside 4xx. Default 8. */
  readonly errorRetries?: number;
  /** Retries after a timeout. Default 1. */
  readonly timeoutRetries?: number;
  /** Milliseconds to wait for the response headers. Default 20000. */
  readonly timeoutMs?: number;
  /** Milliseconds before a retry. Default 1000. */
  readonly delayMs?: number;
  /** The longest delay, for exponential backoff. Default 20000. */
  readonly maxDelayMs?: number;
  /** `linear` waits `delayMs` each time (the default); `exponential` doubles it each retry. */
  readonly backoff?: 'linear' | 'exponential';
}

export interface DrmApi {
  readonly keySystem: string | null;
  readonly sessions: ReadonlyArray<{ readonly keyId: string; readonly status: string }>;
  /** Sets or replaces the license server URL at runtime. */
  setLicenseUrl(url: string): void;
  /**
   * Replaces the per-key-system license URLs at runtime. An entry for the
   * active key system wins over the single URL, and an empty map clears them.
   */
  setLicenseUrls(urls: Readonly<Record<string, string>>): void;
  /** Sets the FairPlay certificate URL at runtime, before the key system is chosen. */
  setCertificateUrl(url: string): void;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    drm: DrmApi;
  }
}

const CLEARKEY = 'org.w3.clearkey';

/** A license request that got no license from the network. */
interface LicenseFailure {
  readonly failure: 'license';
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly timeout: boolean;
  readonly cause: unknown;
}

function licenseFailure(status: number | null, timeout: boolean, cause: unknown): LicenseFailure {
  return { failure: 'license', status, timeout, cause };
}

function isLicenseFailure(value: unknown): value is LicenseFailure {
  return (value as LicenseFailure | null)?.failure === 'license';
}

function isTimeout(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'TimeoutError';
}

/** The bytes a response filter returned, as the ArrayBuffer a handler parses. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a session was opened with, and its place in a renewal. */
interface SessionRecord {
  readonly initDataType: string;
  readonly initData: ArrayBuffer;
  /** The expired session this one replaces; closed once a key here is usable. */
  replaces: MediaKeySession | null;
  /** Whether any key in this session has been usable. */
  usable: boolean;
  /** Whether a replacement session has been started for this one. */
  renewing?: boolean;
}

/**
 * A ClearKey handler with a license server: the server answers the JSON
 * request (W3C EME §9.1.3) with the JSON license.
 */
function remoteClearKeyHandler(): KeySystemHandler {
  return {
    keySystem: CLEARKEY,
    systemIds: ['1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'],
    initDataTypes: ['cenc', 'keyids'],
    buildLicenseRequest: (message) => message,
    parseLicenseResponse: (response) => response,
  };
}

/** A ClearKey handler: the license is a JSON the app answers from its keys. */
function clearKeyHandler(clearKeys: Readonly<Record<string, string>>): KeySystemHandler {
  return {
    keySystem: CLEARKEY,
    systemIds: ['1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'],
    initDataTypes: ['cenc', 'keyids'],
    // ClearKey needs no server: the license is produced from the keys here
    // and applied directly. eme-core skips the license POST for it.
    localLicense: true,
    buildLicenseRequest(message) {
      // The message is a JSON { kids: [base64url] }; answer with the keys.
      const request = JSON.parse(new TextDecoder().decode(message)) as { kids?: string[] };
      const keys = (request.kids ?? [])
        .filter((kid) => clearKeys[kid] !== undefined)
        .map((kid) => ({ kty: 'oct', kid, k: clearKeys[kid] as string }));
      return new TextEncoder().encode(JSON.stringify({ keys, type: 'temporary' }));
    },
    parseLicenseResponse(response) {
      return response;
    },
  };
}

/** The MSE capability config for requestMediaKeySystemAccess. */
function accessConfig(handler: KeySystemHandler): MediaKeySystemConfiguration[] {
  const robustnesses =
    handler.robustness && handler.robustness.length > 0 ? handler.robustness : [''];
  return robustnesses.map((robustness) => ({
    initDataTypes: [...handler.initDataTypes],
    videoCapabilities: [
      { contentType: 'video/mp4; codecs="avc1.42c01e"', robustness },
      { contentType: 'video/mp4; codecs="vp09.00.10.08"', robustness },
    ],
    audioCapabilities: [
      { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness },
      { contentType: 'audio/mp4; codecs="opus"', robustness },
    ],
  }));
}

export default function emeCore(options: EmeOptions = {}): Stage {
  return {
    name: 'eme-core',
    provides: ['eme-core'],
    requires: ['mse'],
    install(ctx) {
      const element = ctx.element;
      let mediaKeys: MediaKeys | null = null;
      let keySystem: string | null = null;
      let handler: KeySystemHandler | null = null;
      let licenseUrl = options.licenseUrl ?? null;
      let licenseUrls = options.licenseUrls;
      let certificateUrl = options.certificateUrl;
      const statuses = new Map<string, string>();
      // Dedup by init data: one session per blob, whichever route delivered it.
      const initDataSeen = new Set<string>();
      // Every open session with the init data that opened it, so an expired
      // session can be renewed with the same request.
      const open = new Map<MediaKeySession, SessionRecord>();
      // Expired sessions waiting for playback before they renew.
      const pendingRenewals = new Set<MediaKeySession>();
      let disposed = false;
      // Aborts the license and certificate requests in flight at teardown.
      const aborter = new AbortController();
      const retry = {
        errorRetries: options.licenseRetry?.errorRetries ?? 8,
        timeoutRetries: options.licenseRetry?.timeoutRetries ?? 1,
        timeoutMs: options.licenseRetry?.timeoutMs ?? 20_000,
        delayMs: options.licenseRetry?.delayMs ?? 1000,
        maxDelayMs: options.licenseRetry?.maxDelayMs ?? 20_000,
        exponential: options.licenseRetry?.backoff === 'exponential',
      };

      const api: DrmApi = {
        get keySystem() {
          return keySystem;
        },
        get sessions() {
          return [...statuses.entries()].map(([keyId, status]) => ({ keyId, status }));
        },
        setLicenseUrl(url) {
          licenseUrl = url;
        },
        setLicenseUrls(urls) {
          licenseUrls = urls;
        },
        setCertificateUrl(url) {
          certificateUrl = url;
        },
      };
      ctx.registerNamespace('drm', api);

      function fail(code: string, recoverable: boolean, cause?: unknown): void {
        ctx.emit('error', {
          category: 'drm',
          code,
          fatal: !recoverable,
          recoverable,
          ...(cause !== undefined ? { context: { message: String(cause) } } : {}),
        });
      }

      /**
       * All handlers eme-core can use: whatever registered, plus ClearKey
       * with the app's keys, or with a license server when the options name
       * ClearKey.
       */
      function allHandlers(): KeySystemHandler[] {
        const registered = keySystemHandlers();
        const clearKeys = options.clearKeys;
        if (clearKeys !== undefined) return [clearKeyHandler(clearKeys), ...registered];
        const named =
          options.preferredKeySystems?.includes(CLEARKEY) === true ||
          licenseUrls?.[CLEARKEY] !== undefined;
        return named ? [remoteClearKeyHandler(), ...registered] : [...registered];
      }

      /** The server certificate for a candidate, or null for none. */
      async function certificateFor(
        candidate: KeySystemHandler,
      ): Promise<ArrayBuffer | Uint8Array | null> {
        const provided = await options.getCertificate?.(candidate.keySystem);
        if (provided !== undefined && provided !== null) return provided;
        if (candidate.fairplay === undefined) return null;
        const url = candidate.fairplay.certificateUrl ?? certificateUrl;
        if (url === undefined) return null;
        const response = await ctx.request(url, { signal: aborter.signal });
        // An error page is not a certificate; the CDM would reject it with no reason.
        if (!response.ok) throw new Error(`certificate ${url}: HTTP ${response.status}`);
        return response.arrayBuffer();
      }

      /** Chooses and initializes a key system for the given systemIds. */
      async function ensureKeys(preferredSystemIds: readonly string[]): Promise<boolean> {
        if (mediaKeys !== null) return true;
        // Listed key systems go first, in list order; the rest keep their
        // order after them, as dash.js ranks systems without a priority.
        const preferred = options.preferredKeySystems ?? [];
        const rank = (h: KeySystemHandler): number => {
          const i = preferred.indexOf(h.keySystem);
          return i === -1 ? preferred.length : i;
        };
        const ordered = allHandlers().sort((a, b) => rank(a) - rank(b));
        // Prefer a handler that serves one of the manifest's systemIds.
        const candidates =
          preferredSystemIds.length > 0
            ? ordered.filter((h) => h.systemIds.some((id) => preferredSystemIds.includes(id)))
            : ordered;
        let lastError: unknown;
        for (const candidate of candidates.length > 0 ? candidates : ordered) {
          try {
            const access = await navigator.requestMediaKeySystemAccess(
              candidate.keySystem,
              accessConfig(candidate),
            );
            const keys = await access.createMediaKeys();
            if (disposed) return false;
            // A failed certificate fails this key system, and the next one
            // is tried, as in hls.js.
            const certificate = await certificateFor(candidate);
            if (disposed) return false;
            if (certificate !== null) {
              await keys.setServerCertificate(
                certificate instanceof Uint8Array ? new Uint8Array(certificate) : certificate,
              );
            }
            await element.setMediaKeys(keys);
            mediaKeys = keys;
            keySystem = candidate.keySystem;
            handler = candidate;
            ctx.emit('drm:keysystem', { keySystem });
            return true;
          } catch (err) {
            // Try the next candidate; the last reason goes out with the failure.
            lastError = err;
          }
        }
        fail('DRM_KEY_SYSTEM_UNAVAILABLE', false, lastError);
        return false;
      }

      /** Opens a session for one init data blob, deduped by key id. */
      async function openSession(initDataType: string, initData: ArrayBuffer): Promise<void> {
        if (mediaKeys === null || handler === null || disposed) return;
        const fingerprint = `${initDataType}:${bytesToBase64(new Uint8Array(initData), true)}`;
        if (initDataSeen.has(fingerprint)) return;
        initDataSeen.add(fingerprint);
        await startSession({ initDataType, initData, replaces: null, usable: false });
      }

      /** Creates a session and sends its license request. */
      async function startSession(record: SessionRecord): Promise<void> {
        if (mediaKeys === null || disposed) return;
        let session: MediaKeySession;
        try {
          session = mediaKeys.createSession('temporary');
        } catch (err) {
          fail('DRM_SESSION_FAILED', false, err);
          return;
        }
        open.set(session, record);
        session.addEventListener('message', (event) => {
          void onMessage(session, event as MediaKeyMessageEvent);
        });
        session.addEventListener('keystatuseschange', () => onKeyStatus(session));
        try {
          await session.generateRequest(record.initDataType, record.initData);
        } catch (err) {
          fail('DRM_INIT_DATA_INVALID', false, err);
        }
      }

      /** Replaces an expired session with a new one on the same init data. */
      function renew(session: MediaKeySession): void {
        const record = open.get(session);
        if (record === undefined || record.renewing === true) return;
        record.renewing = true;
        const keyIds: string[] = [];
        session.keyStatuses.forEach((_status, keyIdBuffer) => {
          keyIds.push(bytesToBase64(new Uint8Array(keyIdBuffer as ArrayBuffer), true));
        });
        ctx.emit('drm:renewing', { keyIds });
        void startSession({
          initDataType: record.initDataType,
          initData: record.initData,
          replaces: session,
          usable: false,
        });
      }

      /** Closes a session and forgets it; its later events are ignored. */
      function retire(session: MediaKeySession): void {
        open.delete(session);
        pendingRenewals.delete(session);
        void session.close().catch(() => {});
      }

      /** One license request: the page's `getLicense`, else a POST to the license URL. */
      async function requestLicense(
        session: MediaKeySession,
        record: SessionRecord,
        active: KeySystemHandler,
        message: ArrayBuffer,
        attempt: number,
      ): Promise<ArrayBuffer | Uint8Array> {
        const system = keySystem ?? '';
        if (options.getLicense !== undefined) {
          try {
            return await options.getLicense(new Uint8Array(message), {
              keySystem: system,
              sessionId: session.sessionId,
              initDataType: record.initDataType,
              initData: new Uint8Array(record.initData),
              attempt,
            });
          } catch (err) {
            const status = (err as { status?: unknown } | null)?.status;
            throw licenseFailure(typeof status === 'number' ? status : null, false, err);
          }
        }
        const url = licenseUrls?.[system] ?? licenseUrl;
        if (url === null || url === undefined) throw new Error('no license url');
        const draft: LicenseRequestDraft = { url, headers: { ...active.licenseHeaders }, attempt };
        let body: Uint8Array = new Uint8Array(active.buildLicenseRequest(message));
        if (options.requestFilter !== undefined) {
          body = await options.requestFilter(body, system, draft);
        }
        let response: Response;
        let bytes: Uint8Array;
        try {
          response = await ctx.request(draft.url, {
            method: 'POST',
            headers: draft.headers,
            body,
            timeoutMs: retry.timeoutMs,
            signal: aborter.signal,
          });
          if (!response.ok) {
            throw licenseFailure(response.status, false, `status ${response.status}`);
          }
          bytes = new Uint8Array(await response.arrayBuffer());
        } catch (err) {
          throw isLicenseFailure(err) ? err : licenseFailure(null, isTimeout(err), err);
        }
        if (options.responseFilter !== undefined) {
          bytes = await options.responseFilter(bytes, system, {
            url: draft.url,
            status: response.status,
            headers: response.headers,
          });
        }
        return active.parseLicenseResponse(bufferOf(bytes));
      }

      /**
       * Gets a license with retries, or null when the session went away
       * first. A failure past the retries throws.
       */
      async function fetchLicense(
        session: MediaKeySession,
        active: KeySystemHandler,
        message: ArrayBuffer,
      ): Promise<ArrayBuffer | Uint8Array | null> {
        let errors = 0;
        let timeouts = 0;
        let refreshed = false;
        for (let attempt = 1; ; attempt += 1) {
          const record = open.get(session);
          if (record === undefined || disposed) return null;
          let failure: LicenseFailure;
          try {
            return await requestLicense(session, record, active, message, attempt);
          } catch (err) {
            // A filter, a parser, or a missing URL: retrying changes nothing.
            if (!isLicenseFailure(err)) throw err;
            failure = err;
          }
          if (disposed || !open.has(session)) return null;
          const status = failure.status;
          if ((status === 401 || status === 403) && !refreshed && options.onUnauthorized) {
            refreshed = true;
            await options.onUnauthorized({ keySystem: keySystem ?? '', status });
            continue;
          }
          // hls.js: a 4xx never retries; a timeout and an error have their own counts.
          const again = failure.timeout
            ? timeouts++ < retry.timeoutRetries
            : (status === null || status < 400 || status > 499) && errors++ < retry.errorRetries;
          if (!again) throw failure.cause;
          const factor = retry.exponential ? 2 ** (errors + timeouts - 1) : 1;
          await wait(Math.min(retry.delayMs * factor, retry.maxDelayMs));
        }
      }

      async function onMessage(
        session: MediaKeySession,
        event: MediaKeyMessageEvent,
      ): Promise<void> {
        const active = handler;
        if (active === null) return;
        try {
          // ClearKey and other local systems need no round trip.
          if (active.localLicense === true) {
            const body = active.buildLicenseRequest(event.message);
            await session.update(body instanceof Uint8Array ? new Uint8Array(body) : body);
            return;
          }
          const raw = await fetchLicense(session, active, event.message);
          if (raw === null || disposed || !open.has(session)) return;
          await session.update(raw instanceof Uint8Array ? new Uint8Array(raw) : raw);
        } catch (err) {
          // The retries are spent and no key will arrive: playback cannot
          // continue, so the failure is fatal, as in hls.js.
          fail('DRM_LICENSE_FAILED', false, err);
        }
      }

      function onKeyStatus(session: MediaKeySession): void {
        const record = open.get(session);
        // A retired session reports its keys released on close; the
        // session that replaced it owns those keys now.
        if (record === undefined) return;
        let expired = false;
        session.keyStatuses.forEach((status, keyIdBuffer) => {
          const keyId = bytesToBase64(new Uint8Array(keyIdBuffer as ArrayBuffer), true);
          statuses.set(keyId, status);
          ctx.emit('drm:keystatus', { keyId, status });
          if (status === 'usable') record.usable = true;
          else if (status === 'expired') expired = true;
          else if (status === 'output-restricted') fail('DRM_OUTPUT_RESTRICTED', false);
          else if (status === 'internal-error') fail('DRM_KEY_STATUS_ERROR', false);
        });
        if (record.usable && record.replaces !== null) {
          retire(record.replaces);
          record.replaces = null;
        }
        if (!expired) return;
        // A license that arrives expired would expire again on every
        // renewal, so only a key that was once usable renews.
        if (!record.usable) {
          fail('DRM_KEY_EXPIRED', true);
          return;
        }
        if (element.paused) pendingRenewals.add(session);
        else renew(session);
      }

      // Renewal waits for playback: a paused or suspended element needs no
      // key, and a license request then could count against a stream limit.
      const onPlay = (): void => {
        for (const session of [...pendingRenewals]) {
          pendingRenewals.delete(session);
          renew(session);
        }
      };
      element.addEventListener('play', onPlay);

      // Suspend releases the sessions; resume asks for the same licenses again.
      let released: SessionRecord[] = [];
      const offSuspended = ctx.on('lifecycle:suspended', () => {
        if (options.releaseOnSuspend !== true || open.size === 0) return;
        // A session being replaced goes with its replacement; renew both as one.
        const live = [...open.entries()].filter(
          ([session]) => ![...open.values()].some((r) => r.replaces === session),
        );
        released = live.map(([, record]) => ({
          initDataType: record.initDataType,
          initData: record.initData,
          replaces: null,
          usable: false,
        }));
        for (const session of [...open.keys()]) retire(session);
        statuses.clear();
        ctx.emit('drm:released', { sessions: released.length });
      });
      const offResumed = ctx.on('lifecycle:resumed', () => {
        const records = released;
        released = [];
        for (const record of records) void startSession(record);
      });

      // The media route: the element fires `encrypted` with init data.
      const onEncrypted = (event: Event): void => {
        const e = event as MediaEncryptedEvent;
        if (e.initData === null) return;
        void ensureKeys([]).then((ok) => {
          if (ok) void openSession(e.initDataType, e.initData as ArrayBuffer);
        });
      };
      element.addEventListener('encrypted', onEncrypted);

      // The manifest route: the reducer emits protection descriptors on
      // MANIFEST_LOADED. Both routes converge on the same dedup.
      const offManifest = ctx.on('presentation:protection', (payload) => {
        const schemes = payload as readonly ProtectionScheme[];
        const systemIds = schemes
          .map((s) => normalizeSystemId(s.systemId))
          .filter((id): id is string => id !== null);
        void ensureKeys(systemIds).then((ok) => {
          if (!ok) return;
          for (const scheme of schemes) {
            if (scheme.initData !== null && scheme.initDataType !== null) {
              void openSession(scheme.initDataType, scheme.initData);
            }
          }
        });
      });

      return () => {
        disposed = true;
        aborter.abort();
        element.removeEventListener('encrypted', onEncrypted);
        element.removeEventListener('play', onPlay);
        offManifest();
        offSuspended();
        offResumed();
        for (const session of [...open.keys()]) retire(session);
        // Only after negotiation set keys: a browser build without EME has
        // no setMediaKeys, and a clear stream never called it.
        if (mediaKeys !== null) void element.setMediaKeys(null).catch(() => {});
      };
    },
  };
}
