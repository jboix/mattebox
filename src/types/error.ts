/**
 * The error taxonomy. The native MediaError has four codes; this is the real
 * one. This module imports nothing so that messages can carry errors without
 * a dependency cycle.
 */

export type ErrorCategory = 'network' | 'manifest' | 'media' | 'drm' | 'config' | 'internal';

export type NetworkErrorCode =
  | 'NETWORK_FAILED'
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_HTTP_STATUS'
  | 'NETWORK_ABORTED';

export type ManifestErrorCode =
  | 'MANIFEST_PARSE_FAILED'
  | 'MANIFEST_UNSUPPORTED'
  | 'MANIFEST_EMPTY'
  | 'MANIFEST_REFRESH_FAILED';

export type MediaErrorCode =
  | 'MEDIA_APPEND_FAILED'
  | 'MEDIA_CONTAINER_INVALID'
  | 'MEDIA_QUOTA_EXCEEDED'
  | 'MEDIA_CODEC_UNSUPPORTED'
  | 'MEDIA_DECODE_ERROR'
  | 'MEDIA_SOURCE_CLOSED';

export type DrmErrorCode =
  | 'DRM_KEY_SYSTEM_UNAVAILABLE'
  | 'DRM_LICENSE_FAILED'
  | 'DRM_KEY_EXPIRED'
  | 'DRM_KEY_STATUS_ERROR'
  | 'DRM_OUTPUT_RESTRICTED'
  | 'DRM_SESSION_FAILED'
  | 'DRM_INIT_DATA_INVALID';

export type ConfigErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_STAGE_REQUIREMENT_MISSING'
  | 'CONFIG_ELEMENT_OCCUPIED';

export type InternalErrorCode = 'INTERNAL_ASSERTION';

export type ErrorCode =
  | NetworkErrorCode
  | ManifestErrorCode
  | MediaErrorCode
  | DrmErrorCode
  | ConfigErrorCode
  | InternalErrorCode;

/**
 * A Mattebox error. Plain data, not an Error subclass, so it can travel in
 * facts and in the trace.
 */
export interface MatteboxError {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly fatal: boolean;
  /** Whether the `recovery` stage could act on it. */
  readonly recoverable: boolean;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * The diagnostic ring buffer, attached when a fatal error surfaces.
   * Typed loosely here because TraceEntry lives above this module in the
   * type graph; `TracedError` in kernel.ts is the precise shape.
   */
  readonly trace?: readonly unknown[];
}
