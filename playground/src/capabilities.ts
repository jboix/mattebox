/**
 * What this browser can decode and decrypt, probed with the platform APIs and
 * rendered as tables. The single most useful thing to know when a stream
 * will not play is a codec or key system the content needs but the browser
 * lacks, and for DRM the level matters as much as the presence: a Widevine
 * L3 browser cannot play content whose license demands hardware security,
 * and an HDCP requirement fails on an external monitor without it.
 */

interface CodecProbe {
  readonly label: string;
  /** RFC 6381 codec string. */
  readonly codec: string;
  readonly kind: 'video' | 'audio';
  /** Containers to probe through MSE, as MIME types. */
  readonly containers: readonly string[];
}

const CODECS: readonly CodecProbe[] = [
  { label: 'H.264 High 4.0', codec: 'avc1.640028', kind: 'video', containers: ['video/mp4'] },
  { label: 'H.264 Baseline', codec: 'avc1.42e01e', kind: 'video', containers: ['video/mp4'] },
  {
    label: 'H.265 / HEVC Main',
    codec: 'hvc1.1.6.L123.B0',
    kind: 'video',
    containers: ['video/mp4'],
  },
  {
    label: 'VP9 Profile 0',
    codec: 'vp09.00.40.08',
    kind: 'video',
    containers: ['video/mp4', 'video/webm'],
  },
  {
    label: 'AV1 Main',
    codec: 'av01.0.08M.08',
    kind: 'video',
    containers: ['video/mp4', 'video/webm'],
  },
  { label: 'AAC-LC', codec: 'mp4a.40.2', kind: 'audio', containers: ['audio/mp4'] },
  { label: 'HE-AAC', codec: 'mp4a.40.5', kind: 'audio', containers: ['audio/mp4'] },
  { label: 'Opus', codec: 'opus', kind: 'audio', containers: ['audio/mp4', 'audio/webm'] },
  { label: 'FLAC', codec: 'flac', kind: 'audio', containers: ['audio/mp4'] },
  { label: 'AC-3', codec: 'ac-3', kind: 'audio', containers: ['audio/mp4'] },
  { label: 'E-AC-3', codec: 'ec-3', kind: 'audio', containers: ['audio/mp4'] },
];

interface KeySystemProbe {
  readonly label: string;
  /** Key system strings to try, first match wins. */
  readonly keySystems: readonly string[];
  /** Video robustness levels, highest first, with the vendor's name for each. */
  readonly levels: ReadonlyArray<readonly [robustness: string, name: string]>;
}

const KEY_SYSTEMS: readonly KeySystemProbe[] = [
  {
    label: 'Widevine',
    keySystems: ['com.widevine.alpha'],
    levels: [
      ['HW_SECURE_ALL', 'L1'],
      ['HW_SECURE_DECODE', 'L1'],
      ['HW_SECURE_CRYPTO', 'L2'],
      ['SW_SECURE_DECODE', 'L3'],
      ['SW_SECURE_CRYPTO', 'L3'],
    ],
  },
  {
    label: 'PlayReady',
    keySystems: ['com.microsoft.playready.recommendation', 'com.microsoft.playready'],
    levels: [
      ['3000', 'SL3000'],
      ['2000', 'SL2000'],
      ['150', 'SL150'],
    ],
  },
  { label: 'FairPlay', keySystems: ['com.apple.fps', 'com.apple.fps.1_0'], levels: [] },
  { label: 'ClearKey', keySystems: ['org.w3.clearkey'], levels: [] },
];

const HDCP_VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '2.0', '2.1', '2.2', '2.3'];

const VIDEO_TYPE = 'video/mp4; codecs="avc1.42e01e"';
const VIDEO_TYPE_ALT = 'video/mp4; codecs="vp09.00.10.08"';
const AUDIO_TYPE = 'audio/mp4; codecs="mp4a.40.2"';
const AUDIO_TYPE_ALT = 'audio/mp4; codecs="opus"';

type Cell = 'yes' | 'no' | 'na' | string;

function mseSupports(type: string): boolean {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
  } catch {
    return false;
  }
}

function elementSupports(type: string): Cell {
  const probe = document.createElement('video');
  const answer = probe.canPlayType(type);
  return answer === 'probably' ? 'yes' : answer === 'maybe' ? 'maybe' : 'no';
}

/** Never let one hung probe hold the whole table. */
function withTimeout<T>(promise: Promise<T>, fallback: T, ms = 4000): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function decodingInfo(probe: CodecProbe): Promise<{ smooth: Cell; efficient: Cell }> {
  const mc = navigator.mediaCapabilities;
  if (mc?.decodingInfo === undefined) return { smooth: 'na', efficient: 'na' };
  const container = probe.containers[0] as string;
  const contentType = `${container}; codecs="${probe.codec}"`;
  const config: MediaDecodingConfiguration =
    probe.kind === 'video'
      ? {
          type: 'media-source',
          video: { contentType, width: 1920, height: 1080, bitrate: 6_000_000, framerate: 30 },
        }
      : { type: 'media-source', audio: { contentType, channels: '2', bitrate: 128_000 } };
  try {
    const info = await withTimeout(mc.decodingInfo(config), null);
    if (info === null) return { smooth: 'na', efficient: 'na' };
    if (!info.supported) return { smooth: 'no', efficient: 'no' };
    return { smooth: info.smooth ? 'yes' : 'no', efficient: info.powerEfficient ? 'yes' : 'no' };
  } catch {
    return { smooth: 'na', efficient: 'na' };
  }
}

async function requestAccess(
  keySystem: string,
  config: MediaKeySystemConfiguration,
): Promise<MediaKeySystemAccess | null> {
  if (typeof navigator.requestMediaKeySystemAccess !== 'function') return null;
  return withTimeout(
    navigator.requestMediaKeySystemAccess(keySystem, [config]).then(
      (access) => access,
      () => null,
    ),
    null,
  );
}

/**
 * A browser rejects a configuration when none of its capabilities is
 * decodable, so every probe offers a royalty-free alternate (a Chromium
 * without proprietary codecs still has VP9 and Opus). Robustness probes
 * pass `videoCapabilities` explicitly and use `videoAlternates` for that.
 */
function videoAlternates(
  extra: Partial<MediaKeySystemMediaCapability> = {},
): MediaKeySystemMediaCapability[] {
  return [
    { contentType: VIDEO_TYPE, ...extra },
    { contentType: VIDEO_TYPE_ALT, ...extra },
  ];
}

function baseConfig(extra: Partial<MediaKeySystemConfiguration> = {}): MediaKeySystemConfiguration {
  return {
    initDataTypes: ['cenc', 'keyids', 'sinf', 'skd'],
    videoCapabilities: videoAlternates(),
    audioCapabilities: [{ contentType: AUDIO_TYPE }, { contentType: AUDIO_TYPE_ALT }],
    ...extra,
  };
}

interface DrmRow {
  readonly label: string;
  readonly keySystem: string | null;
  readonly level: Cell;
  readonly schemes: Cell;
  readonly persistent: Cell;
  readonly identifier: Cell;
  readonly hdcp: Cell;
}

async function probeKeySystem(probe: KeySystemProbe): Promise<DrmRow> {
  const none: DrmRow = {
    label: probe.label,
    keySystem: null,
    level: 'na',
    schemes: 'na',
    persistent: 'na',
    identifier: 'na',
    hdcp: 'na',
  };
  let keySystem: string | null = null;
  let access: MediaKeySystemAccess | null = null;
  for (const candidate of probe.keySystems) {
    access = await requestAccess(candidate, baseConfig());
    if (access !== null) {
      keySystem = candidate;
      break;
    }
  }
  if (keySystem === null || access === null) return none;

  // Security level: the highest video robustness the CDM grants. Audio is
  // left unconstrained; hardware levels usually apply to video alone.
  let level: Cell = probe.levels.length === 0 ? 'n/a for this system' : 'none granted';
  for (const [robustness, name] of probe.levels) {
    const granted = await requestAccess(
      keySystem,
      baseConfig({ videoCapabilities: videoAlternates({ robustness }) }),
    );
    if (granted !== null) {
      level = `${name} (${robustness})`;
      break;
    }
  }

  // Encryption schemes: the browser echoes the field back only when it
  // understands it, so an echo of undefined means the API is too old to say.
  const schemes: string[] = [];
  let schemeApi = false;
  for (const scheme of ['cenc', 'cbcs'] as const) {
    const granted = await requestAccess(
      keySystem,
      baseConfig({
        videoCapabilities: videoAlternates({
          encryptionScheme: scheme,
        } as Partial<MediaKeySystemMediaCapability>),
      }),
    );
    const echoed = (
      granted?.getConfiguration().videoCapabilities?.find((c) => c.contentType !== '') as
        | { encryptionScheme?: string | null }
        | undefined
    )?.encryptionScheme;
    if (echoed !== undefined) schemeApi = true;
    if (granted !== null && echoed === scheme) schemes.push(scheme);
  }

  const persistent = await requestAccess(
    keySystem,
    baseConfig({ persistentState: 'required', sessionTypes: ['persistent-license'] }),
  );
  const identifier = await requestAccess(
    keySystem,
    baseConfig({ distinctiveIdentifier: 'required' }),
  );

  // HDCP: the policy check reports whether output protection at a given
  // version is available now, which depends on the display, not the CDM.
  let hdcp: Cell = 'na';
  try {
    const keys = await withTimeout(access.createMediaKeys(), null);
    const policyCheck = (
      keys as {
        getStatusForPolicy?: (policy: { minHdcpVersion: string }) => Promise<string>;
      } | null
    )?.getStatusForPolicy;
    if (keys !== null && typeof policyCheck === 'function') {
      let best: string | null = null;
      for (const version of HDCP_VERSIONS) {
        const status = await withTimeout(policyCheck.call(keys, { minHdcpVersion: version }), '');
        if (status === 'usable') best = version;
        else break;
      }
      hdcp = best === null ? 'no output protection' : `up to ${best}`;
    }
  } catch {
    hdcp = 'na';
  }

  return {
    label: probe.label,
    keySystem,
    level,
    schemes: schemeApi ? schemes.join(', ') || 'none' : 'unknown (no API)',
    persistent: persistent !== null ? 'yes' : 'no',
    identifier: identifier !== null ? 'yes' : 'no',
    hdcp,
  };
}

function cell(value: Cell, title = ''): string {
  const cls =
    value === 'yes'
      ? 'cell-ok'
      : value === 'no'
        ? 'cell-bad'
        : value === 'na'
          ? 'cell-na'
          : value === 'maybe'
            ? 'cell-maybe'
            : '';
  const text = value === 'yes' ? '✓' : value === 'no' ? '✕' : value === 'na' ? '–' : value;
  return `<td class="${cls}" title="${title}">${text}</td>`;
}

function platformRows(): Array<[string, Cell, string]> {
  const g = globalThis as Record<string, unknown>;
  const has = (name: string): Cell => (typeof g[name] !== 'undefined' ? 'yes' : 'no');
  let changeType: Cell = 'no';
  try {
    changeType =
      typeof MediaSource !== 'undefined' && 'changeType' in SourceBuffer.prototype ? 'yes' : 'no';
  } catch {
    changeType = 'no';
  }
  return [
    [
      'Secure context',
      window.isSecureContext ? 'yes' : 'no',
      'EME and several media APIs need https or localhost',
    ],
    ['MediaSource', has('MediaSource'), 'The MSE entry point the engine appends through'],
    [
      'ManagedMediaSource',
      has('ManagedMediaSource'),
      'The battery-aware MSE variant (iOS 17.1+, Safari 17+)',
    ],
    [
      'SourceBuffer.changeType',
      changeType,
      'Codec switching without a reload; codec-switch needs it',
    ],
    ['Encrypted Media (EME)', has('MediaKeys'), 'navigator.requestMediaKeySystemAccess'],
    [
      'MediaCapabilities',
      navigator.mediaCapabilities !== undefined ? 'yes' : 'no',
      'Smoothness and power-efficiency answers for the codec table',
    ],
    ['WebCodecs', has('VideoDecoder'), 'Not used by the engine; a useful platform fact'],
  ];
}

export async function renderCapabilities(host: HTMLElement): Promise<void> {
  // The user agent is one long string and every other platform fact is a
  // yes or no: one full-width line for the string, then a two-column grid.
  const platform = platformRows()
    .map(
      ([label, value, title]) =>
        `<div class="cap-item" title="${title}"><span class="cap-label">${label}</span><span class="cap-value ${
          value === 'yes' ? 'ok' : 'bad'
        }">${value === 'yes' ? '✓ yes' : '✕ no'}</span></div>`,
    )
    .join('');

  const codecRows = await Promise.all(
    CODECS.map(async (probe) => {
      const mp4 = probe.containers.includes(`${probe.kind}/mp4`)
        ? mseSupports(`${probe.kind}/mp4; codecs="${probe.codec}"`)
          ? 'yes'
          : 'no'
        : 'na';
      const webm = probe.containers.includes(`${probe.kind}/webm`)
        ? mseSupports(`${probe.kind}/webm; codecs="${probe.codec}"`)
          ? 'yes'
          : 'no'
        : 'na';
      const element = elementSupports(`${probe.containers[0]}; codecs="${probe.codec}"`);
      const info = await decodingInfo(probe);
      return `<tr><th>${probe.label}<span class="sub-label">${probe.codec}</span></th>${cell(
        mp4,
        'MediaSource.isTypeSupported, fMP4',
      )}${cell(webm, 'MediaSource.isTypeSupported, WebM')}${cell(
        element,
        'HTMLMediaElement.canPlayType',
      )}${cell(info.smooth, probe.kind === 'video' ? '1080p30 at 6 Mbps' : 'stereo 128 kbps')}${cell(
        info.efficient,
        'MediaCapabilities powerEfficient',
      )}</tr>`;
    }),
  );

  host.innerHTML = `
    <div class="cap-section">
      <h3>Platform</h3>
      <div class="cap-ua" title="navigator.userAgent">${navigator.userAgent}</div>
      <div class="cap-grid">${platform}</div>
    </div>
    <div class="cap-section">
      <h3>Codecs</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Codec</th><th>MSE fMP4</th><th>MSE WebM</th><th>&lt;video&gt;</th><th>Smooth</th><th>Efficient</th></tr></thead>
        <tbody>${codecRows.join('')}</tbody>
      </table></div>
    </div>
    <div class="cap-section">
      <h3>DRM</h3>
      <div class="table-wrap"><table class="table" id="drmTable">
        <thead><tr><th>Key system</th><th>Available</th><th>Security level</th><th>Schemes</th><th>Persistent license</th><th>Device id</th><th>HDCP</th></tr></thead>
        <tbody><tr><td colspan="7" class="muted">probing key systems…</td></tr></tbody>
      </table></div>
      <p class="hint">Security level is the highest video robustness the CDM grants. HDCP reports the output protection available on the current display. Both are what a license server would see.</p>
    </div>
  `;

  const drmRows = await Promise.all(KEY_SYSTEMS.map(probeKeySystem));
  const body = host.querySelector('#drmTable tbody') as HTMLElement;
  body.innerHTML = drmRows
    .map(
      (row) =>
        `<tr><th>${row.label}${
          row.keySystem !== null ? `<span class="sub-label">${row.keySystem}</span>` : ''
        }</th>${cell(row.keySystem !== null ? 'yes' : 'no')}${cell(row.level)}${cell(
          row.schemes,
        )}${cell(row.persistent)}${cell(row.identifier)}${cell(row.hdcp)}</tr>`,
    )
    .join('');
}
